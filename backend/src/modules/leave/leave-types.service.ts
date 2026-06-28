import { Injectable, ConflictException } from "@nestjs/common";
import { EmploymentStatus } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class LeaveTypesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.leaveType.findMany({ orderBy: { name: "asc" } });
  }

  async create(
    dto: { name: string; defaultDays: number; requiresDocument?: boolean; applicableStatuses?: EmploymentStatus[] },
    actorUserId?: string,
  ) {
    const existing = await this.prisma.leaveType.findUnique({ where: { name: dto.name } });
    if (existing) throw new ConflictException(`Leave type "${dto.name}" already exists.`);

    // Regular employees always get every leave type; admins only choose which
    // additional classifications (probationary/contractual/separated) also get it.
    const applicableStatuses = Array.from(
      new Set<EmploymentStatus>(["REGULAR", ...(dto.applicableStatuses ?? [])]),
    );

    const created = await this.prisma.leaveType.create({
      data: {
        name: dto.name,
        defaultDays: dto.defaultDays,
        requiresDocument: dto.requiresDocument ?? false,
        applicableStatuses,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        actorUserId,
        action: "CREATE_LEAVE_TYPE",
        entityType: "LeaveType",
        entityId: created.id,
        newValues: {
          name: created.name,
          defaultDays: created.defaultDays,
          requiresDocument: created.requiresDocument,
          applicableStatuses: created.applicableStatuses,
        },
      },
    });

    return created;
  }
}