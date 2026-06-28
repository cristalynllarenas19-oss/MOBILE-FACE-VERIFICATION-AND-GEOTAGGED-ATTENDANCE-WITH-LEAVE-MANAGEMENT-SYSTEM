import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

type AuditLogFilters = {
  action?: string;
  entityType?: string;
  search?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
};

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

@Injectable()
export class AuditLogsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(filters: AuditLogFilters = {}) {
    const search = filters.search?.trim();
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, filters.pageSize ?? DEFAULT_PAGE_SIZE));

    const where = {
      ...(filters.action && filters.action !== "ALL" ? { action: filters.action } : {}),
      ...(filters.entityType && filters.entityType !== "ALL" ? { entityType: filters.entityType } : {}),
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

    const [items, total] = await Promise.all([
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

    return { items, total, page, pageSize };
  }
}
