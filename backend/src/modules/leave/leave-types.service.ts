import { Injectable, ConflictException } from "@nestjs/common";
import { EmploymentStatus } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

const ACTOR_SELECT = {
  select: {
    email: true,
    employee: { select: { firstName: true, lastName: true } },
  },
} as const;

@Injectable()
export class LeaveTypesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.leaveType.findMany({
      orderBy: { name: "asc" },
      include: {
        createdByUser: ACTOR_SELECT,
        updatedByUser: ACTOR_SELECT,
      },
    });
  }

  async create(
    dto: {
      name: string;
      defaultDays: number;
      requiresDocument?: boolean;
      applicableStatuses?: EmploymentStatus[];
      isUnlimitedDays?: boolean;
    },
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
        isUnlimitedDays: dto.isUnlimitedDays ?? false,
        createdBy: actorUserId,
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
          isUnlimitedDays: created.isUnlimitedDays,
        },
      },
    });

    return created;
  }

  async update(
    id: string,
    dto: {
      name?: string;
      defaultDays?: number;
      requiresDocument?: boolean;
      applicableStatuses?: EmploymentStatus[];
      isUnlimitedDays?: boolean;
    },
    actorUserId?: string,
  ) {
    const existing = await this.prisma.leaveType.findUniqueOrThrow({ where: { id } });

    if (dto.name && dto.name !== existing.name) {
      const duplicate = await this.prisma.leaveType.findUnique({ where: { name: dto.name } });
      if (duplicate) throw new ConflictException(`Leave type "${dto.name}" already exists.`);
    }

    const applicableStatuses = dto.applicableStatuses
      ? Array.from(new Set<EmploymentStatus>(["REGULAR", ...dto.applicableStatuses]))
      : undefined;

    const updated = await this.prisma.leaveType.update({
      where: { id },
      data: {
        name: dto.name,
        defaultDays: dto.defaultDays,
        requiresDocument: dto.requiresDocument,
        applicableStatuses,
        isUnlimitedDays: dto.isUnlimitedDays,
        updatedBy: actorUserId,
      },
      include: {
        createdByUser: ACTOR_SELECT,
        updatedByUser: ACTOR_SELECT,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        actorUserId,
        action: "UPDATE_LEAVE_TYPE",
        entityType: "LeaveType",
        entityId: id,
        oldValues: {
          name: existing.name,
          defaultDays: existing.defaultDays,
          requiresDocument: existing.requiresDocument,
          applicableStatuses: existing.applicableStatuses,
          isUnlimitedDays: existing.isUnlimitedDays,
        },
        newValues: {
          name: updated.name,
          defaultDays: updated.defaultDays,
          requiresDocument: updated.requiresDocument,
          applicableStatuses: updated.applicableStatuses,
          isUnlimitedDays: updated.isUnlimitedDays,
        },
      },
    });

    return updated;
  }

  async setStatus(id: string, isActive: boolean, actorUserId?: string) {
    const updated = await this.prisma.leaveType.update({
      where: { id },
      data: { isActive, updatedBy: actorUserId },
      include: {
        createdByUser: ACTOR_SELECT,
        updatedByUser: ACTOR_SELECT,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        actorUserId,
        action: isActive ? "RESTORE_LEAVE_TYPE" : "ARCHIVE_LEAVE_TYPE",
        entityType: "LeaveType",
        entityId: id,
        newValues: { isActive },
      },
    });

    return updated;
  }
}