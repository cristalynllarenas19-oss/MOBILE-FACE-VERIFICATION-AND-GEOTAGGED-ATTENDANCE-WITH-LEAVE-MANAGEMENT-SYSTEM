import { BadRequestException, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { promises as fs } from "fs";
import * as path from "path";
import { PrismaService, withPrismaRetry } from "../../prisma/prisma.service";

const BACKUP_DIR = path.join(process.cwd(), "backups");
// "Backup_2026-08-31_0142AM.sql", with an optional "-2"/"-3" disambiguator
// when two backups land in the same minute (see uniqueFilename below).
// ".json" is the older format — no longer written, but still listed,
// deletable and restorable.
const FILENAME_PATTERN = /^Backup_\d{4}-\d{2}-\d{2}_\d{4}(AM|PM)(-\d+)?\.(json|sql)$/;
const RESTORE_TRANSACTION_OPTIONS = { timeout: 5 * 60_000, maxWait: 30_000 };

// First line of every .sql backup — how restore (and the admin UI) tells an
// ETALA backup apart from an arbitrary SQL script.
const SQL_HEADER = "-- ETALA backup";
const SQL_REPLICA_ROLE = "SET LOCAL session_replication_role = replica;";
// One INSERT statement is capped at whichever comes first, so a table full
// of base64 face photos doesn't become a single enormous statement.
const SQL_INSERT_MAX_ROWS = 500;
const SQL_INSERT_MAX_BYTES = 1024 * 1024;

type DmmfModel = (typeof Prisma.dmmf.datamodel.models)[number];
type DmmfField = DmmfModel["fields"][number];

function tableNameFor(model: DmmfModel) {
  return model.dbName ?? model.name;
}

// Always a single line: a value containing a backslash or line break is
// written as an E'' escape string, so every statement in the file stays on
// one line and restore can read the file line by line.
function sqlString(value: string) {
  const quoted = value.replace(/'/g, "''");
  if (!/[\\\n\r]/.test(value)) return `'${quoted}'`;
  return `E'${quoted.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r")}'`;
}

function sqlText(value: unknown, type: string) {
  if (type === "DateTime") return value instanceof Date ? value.toISOString() : String(value);
  if (type === "Json") return JSON.stringify(value);
  return String(value);
}

function isNumericType(type: string) {
  return type === "Int" || type === "Float" || type === "Decimal" || type === "BigInt";
}

function sqlArrayElement(value: unknown, type: string) {
  if (value === null || value === undefined) return "NULL";
  if (isNumericType(type)) return String(value);
  if (type === "Boolean") return value ? "true" : "false";
  return `"${sqlText(value, type).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Enums, JSON, dates and arrays are all written as quoted literals, which
// Postgres casts to the target column's type on INSERT — so no per-column
// casts are needed (an ARRAY['A'] constructor would be text[] and fail
// against an enum[] column; the '{...}' literal form doesn't).
function sqlValue(value: unknown, field: DmmfField) {
  if (value === null || value === undefined) return "NULL";
  if (field.isList) {
    return sqlString(`{${(value as unknown[]).map((item) => sqlArrayElement(item, field.type)).join(",")}}`);
  }
  if (isNumericType(field.type)) return String(value);
  if (field.type === "Boolean") return value ? "TRUE" : "FALSE";
  return sqlString(sqlText(value, field.type));
}

function backupStamp(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  const hours24 = date.getHours();
  const hours12 = pad(hours24 % 12 || 12);
  const suffix = hours24 >= 12 ? "PM" : "AM";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${hours12}${pad(date.getMinutes())}${suffix}`;
}

// True only for a line shaped exactly like the INSERTs createBackup writes:
// one statement, ending in its only top-level ";". Outside string literals
// just identifiers, numbers, NULL/TRUE/FALSE and list punctuation are
// allowed — no comments, dollar-quoting or operators — and inside them only
// the escapes sqlString produces, so there is no way to smuggle a second
// statement past this check by confusing where a string starts or ends.
function isSingleGeneratedInsert(line: string) {
  const last = line.length - 1;
  let i = 0;
  while (i <= last) {
    const ch = line[i];
    if (ch === "'") {
      const isEscapeString = line[i - 1] === "E" && (line[i - 2] === " " || line[i - 2] === "(");
      i += 1;
      for (;;) {
        if (i > last) return false;
        const code = line.charCodeAt(i);
        if (code === 92 /* \ */) {
          const next = line[i + 1];
          if (!isEscapeString || (next !== "\\" && next !== "n" && next !== "r")) return false;
          i += 2;
        } else if (code === 39 /* ' */) {
          if (line.charCodeAt(i + 1) !== 39) break;
          i += 2;
        } else {
          i += 1;
        }
      }
      i += 1;
    } else if (ch === '"') {
      const end = line.indexOf('"', i + 1);
      if (end === -1 || !/^[A-Za-z0-9_]+$/.test(line.slice(i + 1, end))) return false;
      i = end + 1;
    } else if (ch === ";") {
      return i === last;
    } else if ((ch === "-" && line[i + 1] === "-") || !/[A-Za-z0-9 (),._+-]/.test(ch)) {
      return false;
    } else {
      i += 1;
    }
  }
  return false;
}

function metaFilename(dataFilename: string) {
  return dataFilename.replace(/\.(json|sql)$/, ".meta.json");
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

type BackupTrigger = "manual" | "pre-restore";

type BackupMeta = {
  name: string;
  createdAt: string;
  sizeBytes: number;
  createdBy: string;
  status: "SUCCESS" | "FAILED";
  tableCount?: number;
  // Absent on backups written before this field existed — the UI treats a
  // missing trigger the same as "manual".
  trigger?: BackupTrigger;
};

type BackupPayload = { createdAt: string; tableCount: number; tables: Record<string, unknown[]> };

type PrismaModelDelegate = { findMany: () => Promise<unknown[]>; deleteMany: () => Promise<unknown>; createMany: (args: { data: unknown[] }) => Promise<unknown> };

@Injectable()
export class BackupService {
  constructor(private readonly prisma: PrismaService) {}

  private modelNames(): string[] {
    return Prisma.dmmf.datamodel.models.map((model) => model.name);
  }

  private clientKeyFor(modelName: string) {
    return modelName.charAt(0).toLowerCase() + modelName.slice(1);
  }

  private async ensureDir() {
    await fs.mkdir(BACKUP_DIR, { recursive: true });
  }

  private assertValidFilename(filename: string) {
    if (!FILENAME_PATTERN.test(filename)) {
      throw new BadRequestException("Invalid backup filename.");
    }
  }

  // Two backups (e.g. a manual one immediately followed by the automatic
  // pre-restore snapshot) can land in the same displayed minute — this keeps
  // the second one from silently overwriting the first's file on disk.
  // Checked against both formats and the shared ".meta.json" name, so a new
  // .sql backup can't take over an older .json backup's history entry.
  private async uniqueFilename(stem: string) {
    const isTaken = async (candidate: string) => {
      for (const extension of [".sql", ".json", ".meta.json"]) {
        try {
          await fs.access(path.join(BACKUP_DIR, `${candidate}${extension}`));
          return true;
        } catch {
          // not present — keep checking
        }
      }
      return false;
    };

    let candidate = stem;
    let suffix = 2;
    while (await isTaken(candidate)) {
      candidate = `${stem}-${suffix}`;
      suffix += 1;
    }
    return `${candidate}.sql`;
  }

  private async actorLabel(actorUserId?: string) {
    if (!actorUserId) return "System";
    const user = await this.prisma.user.findUnique({
      where: { id: actorUserId },
      select: { email: true, employee: { select: { firstName: true, lastName: true } } },
    });
    if (!user) return "System";
    return user.employee ? `${user.employee.firstName} ${user.employee.lastName}` : user.email;
  }

  async listBackups(): Promise<BackupMeta[]> {
    await this.ensureDir();
    const files = await fs.readdir(BACKUP_DIR);
    const metaFiles = files.filter((file) => file.endsWith(".meta.json"));

    const entries = await Promise.all(
      metaFiles.map(async (file) => {
        try {
          const raw = await fs.readFile(path.join(BACKUP_DIR, file), "utf-8");
          return JSON.parse(raw) as BackupMeta;
        } catch {
          return null;
        }
      }),
    );

    return entries
      .filter((entry): entry is BackupMeta => entry != null)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  // Exports every Prisma-tracked table to a single .sql file of plain
  // DELETE + INSERT statements (data only — the tables themselves must
  // already exist, as they do in any database set up with `prisma db push`),
  // wrapped in one transaction so it can also be run as-is from pgAdmin's
  // Query Tool or psql. This is a logical, application-level backup (via
  // Prisma), not a pg_dump: it covers everything the app itself
  // reads/writes — including base64-embedded face photos and leave
  // attachments, since those live in table columns, not on disk — but it
  // would miss any table that exists in the live database outside
  // schema.prisma (the DB has had drift/untracked tables before).
  async createBackup(actorUserId?: string, trigger: BackupTrigger = "manual"): Promise<BackupMeta> {
    await this.ensureDir();
    const now = new Date();
    const name = await this.uniqueFilename(`Backup_${backupStamp(now)}`);
    const createdBy = await this.actorLabel(actorUserId);
    const filePath = path.join(BACKUP_DIR, name);

    try {
      const models = Prisma.dmmf.datamodel.models;
      const modelNames = models.map((model) => model.name);
      const file = await fs.open(filePath, "w");
      try {
        await file.write(
          [
            SQL_HEADER,
            `-- Created: ${now.toISOString()}`,
            `-- Tables: ${models.length}`,
            "-- Data only: replaces every row in the tables below. Run it against a database that already has the ETALA tables.",
            "BEGIN;",
            // Suspends foreign-key checks for this transaction so tables can
            // be cleared/reloaded in any order — same as restore does.
            SQL_REPLICA_ROLE,
            ...models.map((model) => `DELETE FROM "${tableNameFor(model)}";`),
            "",
          ].join("\n"),
        );

        for (const model of models) {
          const delegate = (this.prisma as unknown as Record<string, PrismaModelDelegate>)[this.clientKeyFor(model.name)];
          const rows = (await withPrismaRetry(() => delegate.findMany())) as Record<string, unknown>[];
          const fields = model.fields.filter((field) => field.kind === "scalar" || field.kind === "enum");
          const insertPrefix = `INSERT INTO "${tableNameFor(model)}" (${fields.map((field) => `"${field.dbName ?? field.name}"`).join(", ")}) VALUES `;

          let tuples: string[] = [];
          let tupleBytes = 0;
          const flush = async () => {
            if (tuples.length === 0) return;
            await file.write(`${insertPrefix}${tuples.join(", ")};\n`);
            tuples = [];
            tupleBytes = 0;
          };
          for (const row of rows) {
            const tuple = `(${fields.map((field) => sqlValue(row[field.name], field)).join(", ")})`;
            tuples.push(tuple);
            tupleBytes += tuple.length;
            if (tuples.length >= SQL_INSERT_MAX_ROWS || tupleBytes >= SQL_INSERT_MAX_BYTES) await flush();
          }
          await flush();
        }

        await file.write("COMMIT;\n");
      } finally {
        await file.close();
      }

      const meta: BackupMeta = {
        name,
        createdAt: now.toISOString(),
        sizeBytes: (await fs.stat(filePath)).size,
        createdBy,
        status: "SUCCESS",
        tableCount: modelNames.length,
        trigger,
      };
      await fs.writeFile(path.join(BACKUP_DIR, metaFilename(name)), JSON.stringify(meta), "utf-8");
      await this.prisma.auditLog.create({
        data: {
          actorUserId,
          action: "CREATE_BACKUP",
          entityType: "Backup",
          entityId: name,
          newValues: { filename: name, sizeBytes: meta.sizeBytes, tableCount: modelNames.length, trigger },
        },
      });
      return meta;
    } catch (error) {
      // Don't leave a half-written file that could be mistaken for a backup.
      await fs.unlink(filePath).catch(() => undefined);
      const meta: BackupMeta = { name, createdAt: now.toISOString(), sizeBytes: 0, createdBy, status: "FAILED", trigger };
      await fs.writeFile(path.join(BACKUP_DIR, metaFilename(name)), JSON.stringify(meta), "utf-8").catch(() => undefined);
      await this.prisma.auditLog
        .create({
          data: {
            actorUserId,
            action: "CREATE_BACKUP_FAILED",
            entityType: "Backup",
            entityId: name,
            newValues: { filename: name, error: error instanceof Error ? error.message : String(error) },
          },
        })
        .catch(() => undefined);
      throw new InternalServerErrorException("Backup failed. Check server logs for details.");
    }
  }

  async getBackupFilePath(filename: string) {
    this.assertValidFilename(filename);
    const filePath = path.join(BACKUP_DIR, filename);
    try {
      await fs.access(filePath);
    } catch {
      throw new NotFoundException("Backup file not found.");
    }
    return filePath;
  }

  async deleteBackup(filename: string, actorUserId?: string) {
    this.assertValidFilename(filename);
    const filePath = path.join(BACKUP_DIR, filename);
    const metaPath = path.join(BACKUP_DIR, metaFilename(filename));
    try {
      await fs.unlink(filePath);
    } catch {
      throw new NotFoundException("Backup file not found.");
    }
    await fs.unlink(metaPath).catch(() => undefined);
    await this.prisma.auditLog.create({
      data: { actorUserId, action: "DELETE_BACKUP", entityType: "Backup", entityId: filename, oldValues: { filename } },
    });
  }

  private validatePayload(payload: unknown): asserts payload is BackupPayload {
    const knownModels = new Set(this.modelNames());
    if (
      !payload ||
      typeof payload !== "object" ||
      typeof (payload as BackupPayload).tables !== "object" ||
      (payload as BackupPayload).tables === null
    ) {
      throw new BadRequestException("This file doesn't look like a valid ETALA backup.");
    }
    const tableNames = Object.keys((payload as BackupPayload).tables);
    if (tableNames.length === 0 || !tableNames.every((name) => knownModels.has(name))) {
      throw new BadRequestException("This file doesn't look like a valid ETALA backup.");
    }
  }

  // Replaces every row in every table with the backup's rows, inside one
  // database transaction — if anything fails partway, Postgres rolls the
  // whole thing back and the live data is left exactly as it was.
  // session_replication_role=replica suspends foreign-key trigger checks for
  // the transaction so tables can be cleared/reloaded in any order (SET
  // LOCAL auto-resets at transaction end either way). A fresh backup of the
  // *current* data is taken immediately before touching anything, so a
  // restore that turns out to be wrong can itself be undone.
  private async runRestore(
    apply: (tx: Prisma.TransactionClient) => Promise<void>,
    tableCount: number,
    actorUserId?: string,
    sourceLabel?: string,
  ) {
    const preRestoreSnapshot = await this.createBackup(actorUserId, "pre-restore");

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
        await apply(tx);
        // A backup carries rows (with their ids) but not the positions of
        // the id sequences behind EMP-1001, LR-1001, ... — move each one past
        // the highest restored id so the next new record can't collide.
        await tx.$executeRawUnsafe("SELECT public.etala_sync_id_sequences()");
      }, RESTORE_TRANSACTION_OPTIONS);
    } catch (error) {
      await this.prisma.auditLog
        .create({
          data: {
            actorUserId,
            action: "RESTORE_BACKUP_FAILED",
            entityType: "Backup",
            entityId: sourceLabel,
            newValues: {
              source: sourceLabel,
              preRestoreSnapshot: preRestoreSnapshot.name,
              error: error instanceof Error ? error.message : String(error),
            },
          },
        })
        .catch(() => undefined);
      throw new InternalServerErrorException(
        `Restore failed — no changes were applied (the database transaction was rolled back). A safety backup of your data right before the attempt was saved as "${preRestoreSnapshot.name}".`,
      );
    }

    await this.prisma.auditLog.create({
      data: {
        actorUserId,
        action: "RESTORE_BACKUP",
        entityType: "Backup",
        entityId: sourceLabel,
        newValues: { source: sourceLabel, preRestoreSnapshot: preRestoreSnapshot.name, tableCount },
      },
    });

    return { restoredTables: tableCount, preRestoreSnapshot: preRestoreSnapshot.name };
  }

  // The older .json format.
  private async restoreFromPayload(payload: BackupPayload, actorUserId?: string, sourceLabel?: string) {
    this.validatePayload(payload);
    const tableNames = Object.keys(payload.tables);

    return this.runRestore(
      async (tx) => {
        for (const modelName of tableNames) {
          const delegate = (tx as unknown as Record<string, PrismaModelDelegate>)[this.clientKeyFor(modelName)];
          await delegate.deleteMany();
        }
        for (const modelName of tableNames) {
          const delegate = (tx as unknown as Record<string, PrismaModelDelegate>)[this.clientKeyFor(modelName)];
          const rows = payload.tables[modelName] ?? [];
          for (const batch of chunk(rows, 500)) {
            if (batch.length) await delegate.createMany({ data: batch });
          }
        }
      },
      tableNames.length,
      actorUserId,
      sourceLabel,
    );
  }

  // A .sql upload is never run as a script. It has to be a file this service
  // wrote: every line must be one of the fixed framing lines or a single
  // DELETE/INSERT against a table in schema.prisma — anything else (DROP,
  // UPDATE, a table the app doesn't own) rejects the whole file before the
  // database is touched. Each accepted line is then executed on its own.
  private parseSqlBackup(raw: string) {
    const invalid = () => new BadRequestException("This file doesn't look like a valid ETALA backup.");
    const lines = raw.split("\n").map((line) => line.replace(/\r$/, ""));
    if (lines[0] !== SQL_HEADER) throw invalid();

    const knownTables = new Set(Prisma.dmmf.datamodel.models.map(tableNameFor));
    const statements: string[] = [];
    const tables = new Set<string>();
    for (const line of lines) {
      if (!line || line.startsWith("--") || line === "BEGIN;" || line === "COMMIT;" || line === SQL_REPLICA_ROLE) continue;
      const deleteMatch = /^DELETE FROM "([A-Za-z0-9_]+)";$/.exec(line);
      const match = deleteMatch ?? /^INSERT INTO "([A-Za-z0-9_]+)" \(/.exec(line);
      if (!match || !knownTables.has(match[1])) throw invalid();
      if (!deleteMatch && !isSingleGeneratedInsert(line)) throw invalid();
      tables.add(match[1]);
      statements.push(line);
    }
    if (statements.length === 0) throw invalid();
    return { statements, tableCount: tables.size };
  }

  private restoreFromSql(raw: string, actorUserId?: string, sourceLabel?: string) {
    const { statements, tableCount } = this.parseSqlBackup(raw);
    return this.runRestore(
      async (tx) => {
        for (const statement of statements) await tx.$executeRawUnsafe(statement);
      },
      tableCount,
      actorUserId,
      sourceLabel,
    );
  }

  async restoreFromExisting(filename: string, actorUserId?: string) {
    const filePath = await this.getBackupFilePath(filename);
    const raw = await fs.readFile(filePath, "utf-8");
    if (filename.endsWith(".sql")) return this.restoreFromSql(raw, actorUserId, filename);
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new BadRequestException("This backup file is corrupted and can't be read.");
    }
    return this.restoreFromPayload(payload as BackupPayload, actorUserId, filename);
  }

  async restoreFromUpload(fileBuffer: Buffer, originalName: string, actorUserId?: string) {
    const raw = fileBuffer.toString("utf-8");
    if (raw.startsWith(SQL_HEADER)) return this.restoreFromSql(raw, actorUserId, originalName);
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new BadRequestException("This file doesn't look like a valid ETALA backup.");
    }
    return this.restoreFromPayload(payload as BackupPayload, actorUserId, originalName);
  }
}
