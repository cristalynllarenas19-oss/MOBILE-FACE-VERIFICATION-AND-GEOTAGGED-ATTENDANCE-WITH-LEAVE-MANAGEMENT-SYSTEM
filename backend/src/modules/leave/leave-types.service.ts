import { Injectable, ConflictException } from "@nestjs/common";
import { EmploymentStatus, LeaveTypeKind } from "@prisma/client";
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
      supportingDocumentAfterDays?: number;
      requiresHrValidation?: boolean;
      requiresEhsActivation?: boolean;
      allowWithoutPay?: boolean;
      isTransferable?: boolean;
      isAutoCredited?: boolean;
      applicableStatuses?: EmploymentStatus[];
      isUnlimitedDays?: boolean;
      requiresAdminGrant?: boolean;
      isSingleDayOnly?: boolean;
      advanceFilingAllowed?: boolean;
      kind?: LeaveTypeKind;
    },
    actorUserId?: string,
  ) {
    const existing = await this.prisma.leaveType.findUnique({ where: { name: dto.name } });
    if (existing) throw new ConflictException(`Leave type "${dto.name}" already exists.`);

    // Regular employees always get every leave type; admins only choose which
    // additional classifications (contractual-seasonal/piece-rate/separated) also get it.
    const applicableStatuses = Array.from(
      new Set<EmploymentStatus>(["REGULAR", ...(dto.applicableStatuses ?? [])]),
    );

    const created = await this.prisma.leaveType.create({
      data: {
        name: dto.name,
        defaultDays: dto.defaultDays,
        requiresDocument: dto.requiresDocument ?? false,
        supportingDocumentAfterDays: dto.supportingDocumentAfterDays,
        requiresHrValidation: dto.requiresHrValidation ?? false,
        requiresEhsActivation: dto.requiresEhsActivation ?? false,
        allowWithoutPay: dto.allowWithoutPay ?? false,
        isTransferable: dto.isTransferable ?? false,
        isAutoCredited: dto.isAutoCredited ?? false,
        applicableStatuses,
        isUnlimitedDays: dto.isUnlimitedDays ?? false,
        requiresAdminGrant: dto.requiresAdminGrant ?? false,
        isSingleDayOnly: dto.isSingleDayOnly ?? false,
        advanceFilingAllowed: dto.advanceFilingAllowed ?? true,
        kind: dto.kind ?? "GENERAL",
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
          supportingDocumentAfterDays: created.supportingDocumentAfterDays,
          requiresHrValidation: created.requiresHrValidation,
          requiresEhsActivation: created.requiresEhsActivation,
          allowWithoutPay: created.allowWithoutPay,
          isTransferable: created.isTransferable,
          isAutoCredited: created.isAutoCredited,
          applicableStatuses: created.applicableStatuses,
          isUnlimitedDays: created.isUnlimitedDays,
          requiresAdminGrant: created.requiresAdminGrant,
          isSingleDayOnly: created.isSingleDayOnly,
          advanceFilingAllowed: created.advanceFilingAllowed,
          kind: created.kind,
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
      supportingDocumentAfterDays?: number;
      requiresHrValidation?: boolean;
      requiresEhsActivation?: boolean;
      allowWithoutPay?: boolean;
      isTransferable?: boolean;
      isAutoCredited?: boolean;
      applicableStatuses?: EmploymentStatus[];
      isUnlimitedDays?: boolean;
      requiresAdminGrant?: boolean;
      isSingleDayOnly?: boolean;
      advanceFilingAllowed?: boolean;
      kind?: LeaveTypeKind;
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
        supportingDocumentAfterDays: dto.supportingDocumentAfterDays,
        requiresHrValidation: dto.requiresHrValidation,
        requiresEhsActivation: dto.requiresEhsActivation,
        allowWithoutPay: dto.allowWithoutPay,
        isTransferable: dto.isTransferable,
        isAutoCredited: dto.isAutoCredited,
        applicableStatuses,
        isUnlimitedDays: dto.isUnlimitedDays,
        requiresAdminGrant: dto.requiresAdminGrant,
        isSingleDayOnly: dto.isSingleDayOnly,
        advanceFilingAllowed: dto.advanceFilingAllowed,
        kind: dto.kind,
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
          supportingDocumentAfterDays: existing.supportingDocumentAfterDays,
          requiresHrValidation: existing.requiresHrValidation,
          requiresEhsActivation: existing.requiresEhsActivation,
          allowWithoutPay: existing.allowWithoutPay,
          isTransferable: existing.isTransferable,
          isAutoCredited: existing.isAutoCredited,
          applicableStatuses: existing.applicableStatuses,
          isUnlimitedDays: existing.isUnlimitedDays,
          requiresAdminGrant: existing.requiresAdminGrant,
          isSingleDayOnly: existing.isSingleDayOnly,
          advanceFilingAllowed: existing.advanceFilingAllowed,
          kind: existing.kind,
        },
        newValues: {
          name: updated.name,
          defaultDays: updated.defaultDays,
          requiresDocument: updated.requiresDocument,
          supportingDocumentAfterDays: updated.supportingDocumentAfterDays,
          requiresHrValidation: updated.requiresHrValidation,
          requiresEhsActivation: updated.requiresEhsActivation,
          allowWithoutPay: updated.allowWithoutPay,
          isTransferable: updated.isTransferable,
          isAutoCredited: updated.isAutoCredited,
          applicableStatuses: updated.applicableStatuses,
          isUnlimitedDays: updated.isUnlimitedDays,
          requiresAdminGrant: updated.requiresAdminGrant,
          isSingleDayOnly: updated.isSingleDayOnly,
          advanceFilingAllowed: updated.advanceFilingAllowed,
          kind: updated.kind,
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

  async setEhsActivation(id: string, ehsActivated: boolean, actorUserId?: string) {
    const updated = await this.prisma.leaveType.update({
      where: { id },
      data: { ehsActivated, updatedBy: actorUserId },
      include: {
        createdByUser: ACTOR_SELECT,
        updatedByUser: ACTOR_SELECT,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        actorUserId,
        action: ehsActivated ? "ACTIVATE_EHS_LEAVE_TYPE" : "DEACTIVATE_EHS_LEAVE_TYPE",
        entityType: "LeaveType",
        entityId: id,
        newValues: { ehsActivated },
      },
    });

    return updated;
  }

  async remove(id: string, actorUserId?: string) {
    const existing = await this.prisma.leaveType.findUniqueOrThrow({ where: { id } });

    const [requestCount, balanceCount] = await Promise.all([
      this.prisma.leaveRequest.count({ where: { leaveTypeId: id } }),
      this.prisma.leaveBalance.count({ where: { leaveTypeId: id } }),
    ]);
    if (requestCount > 0 || balanceCount > 0) {
      throw new ConflictException(
        `"${existing.name}" is in use and can't be deleted. Archive it instead.`,
      );
    }

    await this.prisma.leaveType.delete({ where: { id } });

    await this.prisma.auditLog.create({
      data: {
        actorUserId,
        action: "DELETE_LEAVE_TYPE",
        entityType: "LeaveType",
        entityId: id,
        oldValues: { name: existing.name },
      },
    });

    return existing;
  }
}