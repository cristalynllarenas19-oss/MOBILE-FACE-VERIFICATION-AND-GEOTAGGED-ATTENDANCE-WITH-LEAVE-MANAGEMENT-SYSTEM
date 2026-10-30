import { BadRequestException, Injectable, ConflictException } from "@nestjs/common";
import { EmploymentStatus, LeaveTypeKind } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { currentLeaveYear } from "./leave-year.util";

const ACTOR_SELECT = {
  select: {
    email: true,
    employee: { select: { firstName: true, lastName: true } },
  },
} as const;

// A monetizable type needs its per-employee cap: whole or half days, 0–365.
function assertMonetizationRule(dto: { isMonetizable?: boolean; maxMonetizableDays?: number }) {
  if (!dto.isMonetizable) return;
  const days = dto.maxMonetizableDays;
  if (days == null || !Number.isFinite(days) || days <= 0 || days > 365 || (days * 2) % 1 !== 0) {
    throw new BadRequestException("Max days to monetize must be between 0.5 and 365, in whole or half days.");
  }
}

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
      reviewReminderHours?: number | null;
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
      pastAbsenceFilingAllowed?: boolean;
      extensionDays?: number;
      kind?: LeaveTypeKind;
      cancellationAllowed?: boolean;
      cancellationCutoffValue?: number;
      cancellationCutoffUnit?: string;
      isMonetizable?: boolean;
      maxMonetizableDays?: number;
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

    assertMonetizationRule(dto);

    // Leave type ids carry a category code taken from the name (LT-VL-001),
    // so the database hands out the next number for that code rather than a
    // plain column default — see next_leave_type_id in prisma/sql.
    const [{ id }] = await this.prisma.$queryRaw<{ id: string }[]>`SELECT next_leave_type_id(${dto.name}) AS id`;

    const created = await this.prisma.leaveType.create({
      data: {
        id,
        name: dto.name,
        defaultDays: dto.defaultDays,
        requiresDocument: dto.requiresDocument ?? false,
        supportingDocumentAfterDays: dto.supportingDocumentAfterDays,
        reviewReminderHours: dto.reviewReminderHours,
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
        pastAbsenceFilingAllowed: dto.pastAbsenceFilingAllowed ?? false,
        // A new Maternity type gets the usual 30 days unless HR sets otherwise.
        extensionDays: (dto.kind ?? "GENERAL") === "MATERNITY" ? (dto.extensionDays ?? 30) : 0,
        kind: dto.kind ?? "GENERAL",
        cancellationAllowed: dto.cancellationAllowed ?? false,
        cancellationCutoffValue: dto.cancellationAllowed ? dto.cancellationCutoffValue : null,
        cancellationCutoffUnit: dto.cancellationAllowed ? dto.cancellationCutoffUnit : null,
        isMonetizable: dto.isMonetizable ?? false,
        maxMonetizableDays: dto.isMonetizable ? dto.maxMonetizableDays : null,
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
          reviewReminderHours: created.reviewReminderHours,
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
          pastAbsenceFilingAllowed: created.pastAbsenceFilingAllowed,
          extensionDays: created.extensionDays,
          kind: created.kind,
          cancellationAllowed: created.cancellationAllowed,
          cancellationCutoffValue: created.cancellationCutoffValue,
          cancellationCutoffUnit: created.cancellationCutoffUnit,
          isMonetizable: created.isMonetizable,
          maxMonetizableDays: created.maxMonetizableDays,
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
      reviewReminderHours?: number | null;
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
      pastAbsenceFilingAllowed?: boolean;
      extensionDays?: number;
      kind?: LeaveTypeKind;
      cancellationAllowed?: boolean;
      cancellationCutoffValue?: number;
      cancellationCutoffUnit?: string;
      isMonetizable?: boolean;
      maxMonetizableDays?: number;
    },
    actorUserId?: string,
  ) {
    const existing = await this.prisma.leaveType.findUniqueOrThrow({ where: { id } });

    if (dto.name && dto.name !== existing.name) {
      const duplicate = await this.prisma.leaveType.findUnique({ where: { name: dto.name } });
      if (duplicate) throw new ConflictException(`Leave type "${dto.name}" already exists.`);
    }

    assertMonetizationRule(dto);

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
        reviewReminderHours: dto.reviewReminderHours,
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
        pastAbsenceFilingAllowed: dto.pastAbsenceFilingAllowed,
        extensionDays: dto.extensionDays,
        kind: dto.kind,
        cancellationAllowed: dto.cancellationAllowed,
        cancellationCutoffValue:
          dto.cancellationAllowed === false
            ? null
            : dto.cancellationCutoffValue,
        cancellationCutoffUnit:
          dto.cancellationAllowed === false
            ? null
            : dto.cancellationCutoffUnit,
        isMonetizable: dto.isMonetizable,
        maxMonetizableDays: dto.isMonetizable === false ? null : dto.maxMonetizableDays,
        updatedBy: actorUserId,
      },
      include: {
        createdByUser: ACTOR_SELECT,
        updatedByUser: ACTOR_SELECT,
      },
    });

    // A new default allotment (or a switch from "As needed" to fixed days)
    // reaches this year's balances that still hold the old default — the
    // rows seeded from it. A balance HR adjusted for one employee, or an
    // admin-grant-only type's per-employee grant, is left alone.
    const oldDefault = existing.isUnlimitedDays ? 0 : Number(existing.defaultDays);
    const newDefault = updated.isUnlimitedDays ? 0 : Number(updated.defaultDays);
    if (newDefault !== oldDefault && !updated.requiresAdminGrant) {
      await this.prisma.leaveBalance.updateMany({
        where: { leaveTypeId: id, year: await currentLeaveYear(this.prisma), earnedDays: oldDefault },
        data: { earnedDays: newDefault },
      });
    }

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
          reviewReminderHours: existing.reviewReminderHours,
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
          pastAbsenceFilingAllowed: existing.pastAbsenceFilingAllowed,
          extensionDays: existing.extensionDays,
          kind: existing.kind,
          cancellationAllowed: existing.cancellationAllowed,
          cancellationCutoffValue: existing.cancellationCutoffValue,
          cancellationCutoffUnit: existing.cancellationCutoffUnit,
          isMonetizable: existing.isMonetizable,
          maxMonetizableDays: existing.maxMonetizableDays,
        },
        newValues: {
          name: updated.name,
          defaultDays: updated.defaultDays,
          requiresDocument: updated.requiresDocument,
          supportingDocumentAfterDays: updated.supportingDocumentAfterDays,
          reviewReminderHours: updated.reviewReminderHours,
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
          pastAbsenceFilingAllowed: updated.pastAbsenceFilingAllowed,
          extensionDays: updated.extensionDays,
          kind: updated.kind,
          cancellationAllowed: updated.cancellationAllowed,
          cancellationCutoffValue: updated.cancellationCutoffValue,
          cancellationCutoffUnit: updated.cancellationCutoffUnit,
          isMonetizable: updated.isMonetizable,
          maxMonetizableDays: updated.maxMonetizableDays,
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
