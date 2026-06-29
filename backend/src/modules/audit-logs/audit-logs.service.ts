import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

type AuditLogFilters = {
  action?: string;
  entityType?: string;
  module?: string;
  actorUserId?: string;
  search?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
};

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const EXPORT_MAX_ROWS = 5000;

// Groups the raw entityType strings stored on audit logs into the modules
// shown in the "Filter by Module" dropdown — keeps that filter meaningful
// without needing a schema change to track a module on each log row.
const MODULE_ENTITY_TYPES: Record<string, string[]> = {
  Leave: ["LeaveType", "LeaveRequest", "LeaveBalance"],
  Schedules: ["Shift", "EmployeeSchedule"],
  Employees: ["Employee"],
  Attendance: ["AttendanceRecord"],
};

@Injectable()
export class AuditLogsService {
  constructor(private readonly prisma: PrismaService) {}

  private buildWhere(filters: AuditLogFilters) {
    const search = filters.search?.trim();
    const entityTypes = filters.module && MODULE_ENTITY_TYPES[filters.module];

    return {
      ...(filters.action && filters.action !== "ALL" ? { action: filters.action } : {}),
      ...(filters.entityType && filters.entityType !== "ALL" ? { entityType: filters.entityType } : {}),
      ...(entityTypes ? { entityType: { in: entityTypes } } : {}),
      ...(filters.actorUserId && filters.actorUserId !== "ALL" ? { actorUserId: filters.actorUserId } : {}),
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
            actor: {
              OR: [
                { email: { contains: search, mode: "insensitive" as const } },
                { employee: { firstName: { contains: search, mode: "insensitive" as const } } },
                { employee: { lastName: { contains: search, mode: "insensitive" as const } } },
              ],
            },
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
          actor: { include: { employee: true } },
        },
        orderBy: { createdAt: "desc" },
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
        actor: { include: { employee: true } },
      },
      orderBy: { createdAt: "desc" },
      take: EXPORT_MAX_ROWS,
    });
    return this.withEntityNames(rawItems);
  }
}
