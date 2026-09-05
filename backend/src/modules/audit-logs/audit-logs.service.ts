import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

type AuditLogFilters = {
  action?: string;
  entityType?: string;
  module?: string;
  role?: string;
  actorUserId?: string;
  search?: string;
  from?: string;
  to?: string;
  sort?: "newest" | "oldest";
  page?: number;
  pageSize?: number;
};

export type AuditLogContext = {
  actorUserId?: string;
  actorRole?: string;
  ipAddress?: string;
  userAgent?: string;
};

type AuditLogInput = AuditLogContext & {
  action: string;
  module: string;
  entityType: string;
  entityId?: string | null;
  description: string;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
};

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const EXPORT_MAX_ROWS = 5000;

// Groups the raw entityType strings stored on audit logs into the modules
// shown in the "Filter by Module" dropdown — keeps that filter meaningful
// without needing a schema change to track a module on each log row.
const MODULE_ENTITY_TYPES: Record<string, string[]> = {
  Authentication: ["User"],
  Leave: ["LeaveType", "LeaveRequest", "LeaveBalance", "UndertimeFiling", "UndertimeSettings"],
  Schedules: ["Shift", "EmployeeSchedule"],
  Employees: ["Employee"],
  Attendance: ["AttendanceRecord"],
  Users: ["User", "UserRole", "RolePermission"],
  FaceVerification: ["FaceProfile", "FaceVerification"],
  Geotagging: ["WorkLocation", "WorkLocationEmployee"],
  Settings: ["SystemSetting", "Role", "Permission"],
};

@Injectable()
export class AuditLogsService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditLogInput) {
    const meta = {
      module: input.module,
      description: input.description,
      actorRole: input.actorRole,
      userAgent: input.userAgent,
    };

    try {
      return await this.prisma.auditLog.create({
        data: {
          actorUserId: input.actorUserId,
          action: input.action,
          entityType: input.entityType,
          entityId: input.entityId ?? null,
          ipAddress: input.ipAddress,
          ...(input.oldValues ? { oldValues: { ...input.oldValues, _audit: meta } } : {}),
          newValues: { ...(input.newValues ?? {}), _audit: meta },
        },
      });
    } catch (error) {
      console.error("Failed to write audit log", error);
      return null;
    }
  }

  private buildWhere(filters: AuditLogFilters) {
    const search = filters.search?.trim();
    const entityTypes = filters.module && MODULE_ENTITY_TYPES[filters.module];

    return {
      ...(filters.action && filters.action !== "ALL" ? { action: filters.action } : {}),
      ...(filters.entityType && filters.entityType !== "ALL" ? { entityType: filters.entityType } : {}),
      ...(entityTypes ? { entityType: { in: entityTypes } } : {}),
      ...(filters.actorUserId && filters.actorUserId !== "ALL" ? { actorUserId: filters.actorUserId } : {}),
      ...(filters.role && filters.role !== "ALL"
        ? { actor: { userRoles: { some: { role: { code: filters.role as any } } } } }
        : {}),
      ...(filters.from || filters.to
        ? {
            createdAt: {
              ...(filters.from ? { gte: new Date(filters.from) } : {}),
              ...(filters.to ? { lte: new Date(`${filters.to}T23:59:59.999`) } : {}),
            },
          }
        : {}),
      ...(search
        ? {
            OR: [
              { action: { contains: search, mode: "insensitive" as const } },
              { entityType: { contains: search, mode: "insensitive" as const } },
              { newValues: { path: ["_audit", "description"], string_contains: search } },
              { newValues: { path: ["_audit", "module"], string_contains: search } },
              { actor: {
              OR: [
                { email: { contains: search, mode: "insensitive" as const } },
                { employee: { firstName: { contains: search, mode: "insensitive" as const } } },
                { employee: { lastName: { contains: search, mode: "insensitive" as const } } },
              ],
              } },
            ],
          }
        : {}),
    };
  }

  // Audit logs only store entityType/entityId, so the affected record shows
  // up as a raw UUID unless we resolve it back to something readable. This
  // batches one lookup per distinct entityType present on the current page
  // rather than querying per-row.
  private async resolveEntityNames<T extends { entityType: string; entityId: string | null }>(
    items: T[],
  ): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const idsByType = new Map<string, Set<string>>();
    for (const item of items) {
      if (!item.entityId) continue;
      const set = idsByType.get(item.entityType) ?? new Set<string>();
      set.add(item.entityId);
      idsByType.set(item.entityType, set);
    }

    await Promise.all(
      Array.from(idsByType.entries()).map(async ([entityType, idSet]) => {
        const ids = Array.from(idSet);
        switch (entityType) {
          case "LeaveType": {
            const rows = await this.prisma.leaveType.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
            for (const row of rows) names.set(row.id, row.name);
            break;
          }
          case "Shift": {
            const rows = await this.prisma.shift.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
            for (const row of rows) names.set(row.id, row.name);
            break;
          }
          // FaceVerification logs its entityId as the verified employee's
          // id (see AttendanceService), not a separate table — same lookup.
          case "FaceVerification":
          case "Employee": {
            const rows = await this.prisma.employee.findMany({
              where: { id: { in: ids } },
              select: { id: true, firstName: true, lastName: true },
            });
            for (const row of rows) names.set(row.id, `${row.firstName} ${row.lastName}`);
            break;
          }
          case "LeaveRequest": {
            const rows = await this.prisma.leaveRequest.findMany({
              where: { id: { in: ids } },
              select: { id: true, employee: { select: { firstName: true, lastName: true } }, leaveType: { select: { name: true } } },
            });
            for (const row of rows) {
              names.set(row.id, `${row.employee.firstName} ${row.employee.lastName} — ${row.leaveType.name}`);
            }
            break;
          }
          case "UndertimeFiling": {
            const rows = await this.prisma.undertimeFiling.findMany({
              where: { id: { in: ids } },
              select: { id: true, employee: { select: { firstName: true, lastName: true } }, attendanceRecord: { select: { attendanceDate: true } } },
            });
            for (const row of rows) {
              names.set(row.id, `${row.employee.firstName} ${row.employee.lastName} — ${row.attendanceRecord.attendanceDate.toLocaleDateString()}`);
            }
            break;
          }
          case "AttendanceRecord": {
            const rows = await this.prisma.attendanceRecord.findMany({
              where: { id: { in: ids } },
              select: { id: true, attendanceDate: true, employee: { select: { firstName: true, lastName: true } } },
            });
            for (const row of rows) {
              names.set(row.id, `${row.employee.firstName} ${row.employee.lastName} — ${row.attendanceDate.toLocaleDateString()}`);
            }
            break;
          }
          case "AttendanceLog": {
            const rows = await this.prisma.attendanceLog.findMany({
              where: { id: { in: ids } },
              select: { id: true, capturedAt: true, employee: { select: { firstName: true, lastName: true } } },
            });
            for (const row of rows) {
              names.set(row.id, `${row.employee.firstName} ${row.employee.lastName} — ${row.capturedAt.toLocaleString()}`);
            }
            break;
          }
          case "FaceProfile": {
            const rows = await this.prisma.faceProfile.findMany({
              where: { id: { in: ids } },
              select: { id: true, employee: { select: { firstName: true, lastName: true } } },
            });
            for (const row of rows) names.set(row.id, `${row.employee.firstName} ${row.employee.lastName}`);
            break;
          }
          case "Department": {
            const rows = await this.prisma.department.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
            for (const row of rows) names.set(row.id, row.name);
            break;
          }
          case "WorkLocation": {
            const rows = await this.prisma.workLocation.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
            for (const row of rows) names.set(row.id, row.name);
            break;
          }
          case "WorkLocationEmployee": {
            const rows = await this.prisma.workLocationEmployee.findMany({
              where: { id: { in: ids } },
              select: {
                id: true,
                employee: { select: { firstName: true, lastName: true } },
                workLocation: { select: { name: true } },
              },
            });
            for (const row of rows) {
              names.set(row.id, `${row.employee.firstName} ${row.employee.lastName} — ${row.workLocation.name}`);
            }
            break;
          }
          case "LeaveBalance": {
            const rows = await this.prisma.leaveBalance.findMany({
              where: { id: { in: ids } },
              select: {
                id: true,
                employee: { select: { firstName: true, lastName: true } },
                leaveType: { select: { name: true } },
              },
            });
            for (const row of rows) {
              names.set(row.id, `${row.employee.firstName} ${row.employee.lastName} — ${row.leaveType.name}`);
            }
            break;
          }
          case "User": {
            const rows = await this.prisma.user.findMany({
              where: { id: { in: ids } },
              select: { id: true, email: true, employee: { select: { firstName: true, lastName: true } } },
            });
            for (const row of rows) {
              names.set(row.id, row.employee ? `${row.employee.firstName} ${row.employee.lastName}` : row.email);
            }
            break;
          }
          case "Announcement": {
            const rows = await this.prisma.announcement.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } });
            for (const row of rows) names.set(row.id, row.title);
            break;
          }
        }
      }),
    );

    return names;
  }

  private async withEntityNames<T extends { entityType: string; entityId: string | null }>(items: T[]) {
    const names = await this.resolveEntityNames(items);
    return items.map((item) => ({
      ...item,
      entityName: item.entityId ? names.get(item.entityId) ?? null : null,
    }));
  }

  async findAll(filters: AuditLogFilters = {}) {
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, filters.pageSize ?? DEFAULT_PAGE_SIZE));
    const where = this.buildWhere(filters);

    const [rawItems, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        include: {
          actor: { include: { employee: true, userRoles: { include: { role: true } } } },
        },
        orderBy: { createdAt: filters.sort === "oldest" ? "asc" : "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    const items = await this.withEntityNames(rawItems);
    return { items, total, page, pageSize };
  }

  async findForExport(filters: AuditLogFilters = {}) {
    const where = this.buildWhere(filters);
    const rawItems = await this.prisma.auditLog.findMany({
      where,
      include: {
        actor: { include: { employee: true, userRoles: { include: { role: true } } } },
      },
      orderBy: { createdAt: filters.sort === "oldest" ? "asc" : "desc" },
      take: EXPORT_MAX_ROWS,
    });
    return this.withEntityNames(rawItems);
  }
}
