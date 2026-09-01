import { BadRequestException, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { promises as fs } from "fs";
import * as path from "path";
import { PrismaService, withPrismaRetry } from "../../prisma/prisma.service";

const BACKUP_DIR = path.join(process.cwd(), "backups");
// "Backup_2026-08-31_0142AM.json", with an optional "-2"/"-3" disambiguator
// when two backups land in the same minute (see uniqueFilename below).
const FILENAME_PATTERN = /^Backup_\d{4}-\d{2}-\d{2}_\d{4}(AM|PM)(-\d+)?\.json$/;
const RESTORE_TRANSACTION_OPTIONS = { timeout: 5 * 60_000, maxWait: 30_000 };

function backupStamp(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  const hours24 = date.getHours();
  const hours12 = pad(hours24 % 12 || 12);
  const suffix = hours24 >= 12 ? "PM" : "AM";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${hours12}${pad(date.getMinutes())}${suffix}`;
}

function metaFilename(dataFilename: string) {
  return dataFilename.replace(/\.json$/, ".meta.json");
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
  private async uniqueFilename(baseName: string) {
    let candidate = baseName;
    let suffix = 2;
    while (true) {
      try {
        await fs.access(path.join(BACKUP_DIR, candidate));
        candidate = baseName.replace(/\.json$/, `-${suffix}.json`);
        suffix += 1;
      } catch {
        return candidate;
      }
    }
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

  // Exports every Prisma-tracked table to a single JSON file. This is a
  // logical, application-level backup (via Prisma), not a pg_dump: it covers
  // everything the app itself reads/writes — including base64-embedded face
  // photos and leave attachments, since those live in table columns, not on
  // disk — but it would miss any table that exists in the live database
  // outside schema.prisma (the DB has had drift/untracked tables before).
  async createBackup(actorUserId?: string, trigger: BackupTrigger = "manual"): Promise<BackupMeta> {
    await this.ensureDir();
    const now = new Date();
    const name = await this.uniqueFilename(`Backup_${backupStamp(now)}.json`);
    const createdBy = await this.actorLabel(actorUserId);

    try {
      const modelNames = this.modelNames();
      const tables: Record<string, unknown[]> = {};
      for (const modelName of modelNames) {
        const delegate = (this.prisma as unknown as Record<string, PrismaModelDelegate>)[this.clientKeyFor(modelName)];
        tables[modelName] = await withPrismaRetry(() => delegate.findMany());
      }

      const payload: BackupPayload = { createdAt: now.toISOString(), tableCount: modelNames.length, tables };
      const json = JSON.stringify(payload);
      await fs.writeFile(path.join(BACKUP_DIR, name), json, "utf-8");

      const meta: BackupMeta = {
        name,
        createdAt: now.toISOString(),
        sizeBytes: Buffer.byteLength(json),
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
  private async restoreFromPayload(payload: BackupPayload, actorUserId?: string, sourceLabel?: string) {
    this.validatePayload(payload);
    const preRestoreSnapshot = await this.createBackup(actorUserId, "pre-restore");
    const tableNames = Object.keys(payload.tables);

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
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
        newValues: { source: sourceLabel, preRestoreSnapshot: preRestoreSnapshot.name, tableCount: tableNames.length },
      },
    });

    return { restoredTables: tableNames.length, preRestoreSnapshot: preRestoreSnapshot.name };
  }

  async restoreFromExisting(filename: string, actorUserId?: string) {
    const filePath = await this.getBackupFilePath(filename);
    const raw = await fs.readFile(filePath, "utf-8");
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new BadRequestException("This backup file is corrupted and can't be read.");
    }
    return this.restoreFromPayload(payload as BackupPayload, actorUserId, filename);
  }

  async restoreFromUpload(fileBuffer: Buffer, originalName: string, actorUserId?: string) {
    let payload: unknown;
    try {
      payload = JSON.parse(fileBuffer.toString("utf-8"));
    } catch {
      throw new BadRequestException("This file doesn't look like a valid ETALA backup.");
    }
    return this.restoreFromPayload(payload as BackupPayload, actorUserId, originalName);
  }
}
