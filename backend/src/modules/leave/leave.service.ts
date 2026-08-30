import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AuditLogContext, AuditLogsService } from "../audit-logs/audit-logs.service";
import { CreateLeaveRequestDto } from "./dto/create-leave-request.dto";
import { RejectLeaveRequestDto } from "./dto/reject-leave-request.dto";
import { ResubmitLeaveRequestDto } from "./dto/resubmit-leave-request.dto";
import { isEligibleForLeaveType } from "./leave-balances.service";
import { isDayOff, isNonWorkingDay } from "../../common/utils/schedule.util";

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
type LeaveRequestStatus =
  | "PENDING"
  | "SUPERVISOR_APPROVED"
  | "APPROVED"
  | "REJECTED"
  | "NEEDS_REVISION"
  | "CANCELLED"
  | "CANCELLATION_PENDING";

// Leave-type cutoff modes for approved self-cancellation. An ADMIN override
// cancelling on an employee's behalf is not bound by these windows.
const CANCELLATION_CUTOFF_UNITS = {
  WORKING_DAYS_BEFORE_START: "WORKING_DAYS_BEFORE_START",
  HOURS_BEFORE_SHIFT_START: "HOURS_BEFORE_SHIFT_START",
} as const;

// Local-midnight truncation, matching the same toDateString()-based same-day
// comparisons already used elsewhere in this file (see isSingleDayOnly check
// in create()) — keeps "today"/"already started" comparisons independent of
// time-of-day.
function toDateOnly(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function dateAtTime(date: Date, time: string | null | undefined) {
  const [hours = 0, minutes = 0] = (time ?? "00:00").split(":").map((part) => Number(part));
  const result = new Date(date);
  result.setHours(Number.isFinite(hours) ? hours : 0, Number.isFinite(minutes) ? minutes : 0, 0, 0);
  return result;
}

function subtractWorkingDays(date: Date, days: number) {
  const result = new Date(date);
  let remaining = Math.max(0, days);
  while (remaining > 0) {
    result.setDate(result.getDate() - 1);
    if (!isDayOff(result)) remaining -= 1;
  }
  return result;
}

@Injectable()
export class LeaveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async findAll(employeeId?: string, departmentId?: string, includeAttachments = true) {
    const requests = await this.prisma.leaveRequest.findMany({
      where: {
        ...(employeeId ? { employeeId } : {}),
        ...(departmentId ? { employee: { departmentId } } : {}),
      },
      // includeAttachments=false drops the base64 attachmentData blobs (used
      // by the employee-mobile list poll, which never renders that field —
      // only attachmentName). Admin callers omit the param and keep getting
      // attachments as before, since the review UI reads them off this same
      // list response.
      ...(includeAttachments ? {} : { omit: { attachmentData: true } }),
      include: {
        // employee/reviewer.employee default-include every Employee scalar,
        // including profilePhotoData (a base64 face photo) — dropped for the
        // same includeAttachments=false callers, none of which read employee
        // or reviewer off a leave request at all (mobile shows its own data;
        // the admin review UI doesn't use these photo fields either).
        employee: {
          include: { department: true },
          ...(includeAttachments ? {} : { omit: { profilePhotoData: true } }),
        },
        leaveType: true,
        reviewer: {
          include: {
            employee: includeAttachments ? true : { omit: { profilePhotoData: true } },
          },
        },
        notes: {
          orderBy: { createdAt: "asc" },
          ...(includeAttachments ? {} : { omit: { attachmentData: true } }),
        },
      },
      // Newest-filed request first (LIFO) — sorting by startDate instead would
      // bury a just-submitted request behind an older one whose leave dates
      // happen to be later.
      orderBy: { createdAt: "desc" },
    });

    const remarks = await this.prisma.auditLog.findMany({
      where: { entityType: "LeaveRequest", entityId: { in: requests.map((request) => request.id) } },
      orderBy: { createdAt: "desc" },
    });

    // The cutoff math below only ever runs for APPROVED requests (see the
    // early-return in getCancellationEligibility), so the schedule/shift join
    // — the heaviest part of this query — is only worth fetching for the
    // employees who actually have one. On a poll-heavy screen with mostly
    // non-APPROVED history, this keeps most calls to a two-table query.
    const employeeIdsNeedingSchedule = Array.from(
      new Set(requests.filter((request) => request.status === "APPROVED").map((request) => request.employeeId)),
    );
    const schedulesByEmployeeId = new Map<string, Array<{ startsOn: Date; endsOn: Date | null; shift: { startTime: string } }>>();
    if (employeeIdsNeedingSchedule.length > 0) {
      const schedules = await this.prisma.employeeSchedule.findMany({
        where: { employeeId: { in: employeeIdsNeedingSchedule }, isActive: true },
        select: { employeeId: true, startsOn: true, endsOn: true, shift: { select: { startTime: true } } },
        orderBy: { startsOn: "desc" },
      });
      for (const schedule of schedules) {
        const list = schedulesByEmployeeId.get(schedule.employeeId) ?? [];
        list.push(schedule);
        schedulesByEmployeeId.set(schedule.employeeId, list);
      }
    }

    return requests.map((request) => ({
      ...request,
      adminRemarks: remarks.find((remark) => remark.entityId === request.id)?.newValues,
      // Lets the employee self-service UI disable Cancel and explain why
      // instead of only finding out after a failed attempt — same rule the
      // cancel() endpoint enforces, computed here so the client never has to
      // duplicate the cutoff math (which needs the employee's shift).
      cancellation: this.getCancellationEligibility(request, schedulesByEmployeeId.get(request.employeeId) ?? [], request.notes),
    }));
  }

  // Whether an EMPLOYEE (not an ADMIN override) could cancel this request
  // right now, and why not if not. PENDING/SUPERVISOR_APPROVED never have a
  // cutoff; APPROVED is gated by the leave type's configured cutoff window.
  private getCancellationEligibility(
    request: {
      status: string;
      startDate: Date;
      leaveType: {
        name: string;
        cancellationAllowed: boolean;
        cancellationCutoffValue: number | null;
        cancellationCutoffUnit: string | null;
      };
    },
    schedules: Array<{ startsOn: Date; endsOn: Date | null; shift: { startTime: string } }>,
    // Once a Supervisor/Admin denies a cancellation request (see
    // denyCancellation), the request permanently loses the ability to
    // request another one — this is what a CANCELLATION_DENIED note means.
    // The request itself is untouched otherwise (still plain APPROVED), so
    // without this check it would look exactly like a leave that never had
    // a cancellation attempt at all.
    notes: Array<{ type: string }> = [],
  ): { allowed: boolean; reason?: string; deadline?: Date } {
    const cancellableStatuses: LeaveRequestStatus[] = ["PENDING", "SUPERVISOR_APPROVED", "APPROVED"];
    if (!cancellableStatuses.includes(request.status as LeaveRequestStatus)) {
      return { allowed: false };
    }
    if (request.status !== "APPROVED") {
      return { allowed: true };
    }
    if (notes.some((note) => note.type === "CANCELLATION_DENIED")) {
      return {
        allowed: false,
        reason: "Your supervisor already denied a request to cancel this leave. Please contact HR/Admin if you still need to cancel it.",
      };
    }

    if (!request.leaveType.cancellationAllowed) {
      return {
        allowed: false,
        reason: `${request.leaveType.name} is not available for employee cancellation. Please contact HR/Admin.`,
      };
    }
    if (request.leaveType.cancellationCutoffValue == null || !request.leaveType.cancellationCutoffUnit) {
      return {
        allowed: false,
        reason: `${request.leaveType.name} has no cancellation cutoff period configured. Please contact HR/Admin.`,
      };
    }

    const requestStart = toDateOnly(request.startDate);
    const schedule = schedules.find((assignment) => {
      const startsOn = toDateOnly(assignment.startsOn);
      const endsOn = assignment.endsOn ? toDateOnly(assignment.endsOn) : null;
      return startsOn <= requestStart && (!endsOn || endsOn >= requestStart);
    });
    const leaveStartAtShiftTime = dateAtTime(request.startDate, schedule?.shift.startTime);
    const cutoffValue = request.leaveType.cancellationCutoffValue;
    const cutoffUnit = request.leaveType.cancellationCutoffUnit;
    const cutoffDeadline =
      cutoffUnit === CANCELLATION_CUTOFF_UNITS.HOURS_BEFORE_SHIFT_START
        ? new Date(leaveStartAtShiftTime.getTime() - cutoffValue * 60 * 60 * 1000)
        : subtractWorkingDays(leaveStartAtShiftTime, cutoffValue);

    if (new Date() > cutoffDeadline) {
      return {
        allowed: false,
        reason: `The cutoff to cancel this approved ${request.leaveType.name} was ${cutoffDeadline.toLocaleString()}. Please contact HR/Admin.`,
        deadline: cutoffDeadline,
      };
    }
    return { allowed: true, deadline: cutoffDeadline };
  }

  async create(dto: CreateLeaveRequestDto, context: AuditLogContext = {}) {
    if (dto.attachmentData && Buffer.byteLength(dto.attachmentData, "base64") > MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException("Attachment must be 5MB or smaller.");
    }

    const leaveType = await this.prisma.leaveType.findUniqueOrThrow({ where: { id: dto.leaveTypeId } });

    // An employee can have multiple leave types in flight at once, but not two
    // requests of the *same* type — they must wait for the existing one to be
    // fully APPROVED (or REJECTED/CANCELLED) before filing another of that
    // type. A different type is always allowed.
    const activeRequestOfType = await this.prisma.leaveRequest.findFirst({
      where: {
        employeeId: dto.employeeId,
        leaveTypeId: dto.leaveTypeId,
        status: { in: ["PENDING", "SUPERVISOR_APPROVED", "NEEDS_REVISION"] },
      },
    });

    if (activeRequestOfType) {
      throw new BadRequestException(
        `You already have a ${leaveType.name} request awaiting review. Please wait until it is approved, rejected, or cancelled before filing another for this leave type.`,
      );
    }

    // Any date already covered by an APPROVED request of this *same* leave
    // type is off-limits for a new one of that type — until the approved
    // request is cancelled. Scoped to the same type only (not any type);
    // a different type filed over the same dates is a separate business
    // call this check doesn't make.
    const overlappingApproved = await this.prisma.leaveRequest.findFirst({
      where: {
        employeeId: dto.employeeId,
        leaveTypeId: dto.leaveTypeId,
        status: "APPROVED",
        startDate: { lte: new Date(dto.endDate) },
        endDate: { gte: new Date(dto.startDate) },
      },
    });

    if (overlappingApproved) {
      throw new BadRequestException(
        `These dates overlap your approved ${leaveType.name} ` +
          `(${overlappingApproved.startDate.toLocaleDateString()} – ${overlappingApproved.endDate.toLocaleDateString()}). ` +
          `Cancel that request first if you need to change it.`,
      );
    }

    // Only checked server-side here — the balances endpoint already filters
    // the dropdown to applicable types, but a crafted request could otherwise
    // bypass that (e.g. a Probationary employee submitting anything other
    // than Leave Without Pay before HR converts them to Regular).
    const employee = await this.prisma.employee.findUniqueOrThrow({
      where: { id: dto.employeeId },
      select: { employmentStatus: true, sex: true },
    });
    if (!leaveType.applicableStatuses.includes(employee.employmentStatus)) {
      throw new BadRequestException(`${leaveType.name} is not available for your employment status.`);
    }
    // Same bypass concern as above, for Maternity/Paternity — the frontend
    // dropdown already hides these from the wrong sex, but nothing stopped a
    // crafted request from filing one anyway.
    if (!isEligibleForLeaveType(leaveType.kind, employee.sex)) {
      throw new BadRequestException(`${leaveType.name} is not available for you.`);
    }

    // Sick Leave / Emergency Leave (and any other isSingleDayOnly type) are
    // always exactly one day — the frontend already forces this, but a
    // crafted request is validated the same way every other rule here is.
    if (leaveType.isSingleDayOnly) {
      const sameDay = new Date(dto.startDate).toDateString() === new Date(dto.endDate).toDateString();
      if (!sameDay || Number(dto.totalDays) !== 1) {
        throw new BadRequestException(`${leaveType.name} can only be requested for a single day.`);
      }
    }

    // Leave types flagged !advanceFilingAllowed (Sick Leave, Emergency Leave,
    // Adverse Weather Leave) cannot be filed for a future date — driven by
    // the leave type's own config, not the type's name, so HR can retune
    // which types this applies to without a code change. Compassionate Leave
    // (advanceFilingAllowed = true) is unaffected, including when the reason
    // given is a doctor's appointment — that's a reason under Compassionate
    // Leave, not a separate leave type.
    //
    // When it's *also* isSingleDayOnly (same-day emergency-style leave), the
    // date must be exactly today — not a past date either — since these are
    // meant to be filed the day the employee is actually out, not backfiled
    // days later. A multi-day !advanceFilingAllowed type (if HR ever
    // configures one) keeps the more lenient "today or earlier" rule.
    if (!leaveType.advanceFilingAllowed) {
      const requestedStart = toDateOnly(new Date(dto.startDate));
      const today = toDateOnly(new Date());
      if (leaveType.isSingleDayOnly) {
        if (requestedStart.getTime() !== today.getTime()) {
          throw new BadRequestException(`${leaveType.name} must be filed for today's date only.`);
        }
      } else if (requestedStart > today) {
        throw new BadRequestException(`${leaveType.name} cannot be filed in advance — the date must be today or earlier.`);
      }
    }

    // An employee can't file leave to cover a day they aren't scheduled to
    // work in the first place — mirrors the calendar's own day-off styling
    // (CalendarPickerModal's isDateNonWorking) so a crafted request can't
    // bypass it. Only the request's boundary dates are checked: the days in
    // between a multi-day range are already implicitly off as part of a
    // normal working-week span and don't need to individually pass.
    const boundaryDateStrings = new Set([dto.startDate, dto.endDate].map((d) => new Date(d).toDateString()));
    for (const dateString of boundaryDateStrings) {
      const date = new Date(dateString);
      const scheduleOnDate = await this.prisma.employeeSchedule.findFirst({
        where: {
          employeeId: dto.employeeId,
          isActive: true,
          startsOn: { lte: date },
          OR: [{ endsOn: null }, { endsOn: { gte: date } }],
        },
        orderBy: { startsOn: "desc" },
        select: { workingDays: true },
      });
      if (isNonWorkingDay(date, scheduleOnDate?.workingDays)) {
        throw new BadRequestException(
          `${date.toLocaleDateString()} is your day off / a non-working day — leave can only be filed for a working day.`,
        );
      }
    }

    // Paid, capped leave types must not be requestable past what's left in the
    // employee's balance for the year — allowWithoutPay/isUnlimitedDays types
    // (e.g. LWOP) are intentionally exempt, same as in adjustLeaveBalance below.
    if (!leaveType.allowWithoutPay && !leaveType.isUnlimitedDays) {
      const year = new Date(dto.startDate).getFullYear();
      const balance = await this.prisma.leaveBalance.findUnique({
        where: { employeeId_leaveTypeId_year: { employeeId: dto.employeeId, leaveTypeId: dto.leaveTypeId, year } },
      });

      // Admin-grant-only types (Solo Parent, Study Leave, Added Paternity
      // Leave) never fall back to the type's default allotment — an employee
      // has 0 days until HR/Admin explicitly grants them a balance.
      if (!balance && leaveType.requiresAdminGrant) {
        throw new BadRequestException(
          `${leaveType.name} must be granted by HR/Admin before you can request it. Please apply to HR/Admin first.`,
        );
      }

      const earnedDays = balance ? Number(balance.earnedDays) : Number(leaveType.defaultDays);
      const usedDays = balance ? Number(balance.usedDays) : 0;
      const remainingDays = Math.max(0, earnedDays - usedDays);

      if (remainingDays <= 0) {
        throw new BadRequestException("You have no remaining balance for this leave type.");
      }

      if (Number(dto.totalDays) > remainingDays) {
        throw new BadRequestException(
          `Insufficient ${leaveType.name} balance: you have ${remainingDays} day(s) remaining but requested ${dto.totalDays}.`,
        );
      }
    }

    // The 30-day unpaid extension only makes sense for a Maternity-kind leave
    // type — a crafted request against any other leave type is silently
    // ignored rather than trusted, even though the frontend already gates this.
    const extensionRequested = Boolean(dto.extensionRequested) && leaveType.kind === "MATERNITY";

    const request = await this.prisma.leaveRequest.create({
      data: {
        employeeId: dto.employeeId,
        leaveTypeId: dto.leaveTypeId,
        startDate: new Date(dto.startDate),
        endDate: new Date(dto.endDate),
        totalDays: dto.totalDays,
        reason: dto.reason,
        attachmentName: dto.attachmentName,
        attachmentMimeType: dto.attachmentMimeType,
        attachmentData: dto.attachmentData,
        extensionRequested,
      },
      include: {
        employee: { include: { supervisor: true, department: true } },
        leaveType: true,
      },
    });

    await this.notifySubmission(request);

    await this.auditLogs.record({
      ...context,
      action: "CREATE_LEAVE_REQUEST",
      module: "Leave",
      entityType: "LeaveRequest",
      entityId: request.id,
      description: `${request.employee.firstName} ${request.employee.lastName} filed a ${request.leaveType.name} leave request.`,
      newValues: {
        employeeId: request.employeeId,
        leaveType: request.leaveType.name,
        startDate: request.startDate,
        endDate: request.endDate,
        totalDays: request.totalDays,
        status: request.status,
      },
    });

    return request;
  }

  private async notifySubmission(request: {
    id: string;
    startDate: Date;
    endDate: Date;
    employee: { userId: string | null; firstName: string; lastName: string; supervisor: { userId: string | null } | null };
    leaveType: { name: string };
  }) {
    // A regular employee's request goes to their supervisor only; a supervisor has no
    // supervisor above them, so their own requests route to HR/Admin instead.
    const filerIsSupervisor = await this.notifications.userHasRole(request.employee.userId, "SUPERVISOR");
    const candidateIds = filerIsSupervisor
      ? await this.notifications.adminUserIds()
      : [request.employee.supervisor?.userId];
    const recipientIds = candidateIds.filter(
      (id): id is string => Boolean(id) && id !== request.employee.userId,
    );

    const employeeName = `${request.employee.firstName} ${request.employee.lastName}`;
    const dateRange = `${request.startDate.toLocaleDateString()} - ${request.endDate.toLocaleDateString()}`;

    await this.notifications.notifyUsers(recipientIds, {
      title: "New Leave Request",
      message: `${employeeName} filed a ${request.leaveType.name} request for ${dateRange}.`,
      type: "LEAVE_SUBMITTED",
      entityId: request.id,
    });
  }

  async updateStatus(
    id: string,
    status: LeaveRequestStatus,
    remarks?: string,
    context: AuditLogContext = {},
    scopeDepartmentId?: string,
    selfReviewEmployeeId?: string,
    // skipBalanceRestore: set by cancel() when the leave period has already
    // started — the days were already taken, so reversing an APPROVED status
    // must not hand the balance back. Every other caller (rejecting an
    // approved request, an admin reversing an approval) still restores in
    // full, which is why this defaults to false rather than being folded into
    // the wasApproved/isNowApproved check below.
    options: { skipBalanceRestore?: boolean } = {},
  ) {
    // Load the request first so we know its *current* status before changing anything.
    // This is what lets us tell "first time being approved" apart from "already approved,
    // admin clicked again" — without this check, usedDays could be deducted more than once
    // for the same request.
    const existing = await this.prisma.leaveRequest.findUniqueOrThrow({
      where: { id },
      include: { employee: { select: { departmentId: true } } },
    });

    if (scopeDepartmentId && existing.employee.departmentId !== scopeDepartmentId) {
      throw new ForbiddenException("You can only manage leave requests from your own department.");
    }

    // A Supervisor is also an employee of the department they scope-check
    // against above, so the department check alone would let them approve
    // their own request. Their own leave must stay PENDING until HR/Admin
    // (who never passes selfReviewEmployeeId) reviews it directly.
    if (selfReviewEmployeeId && existing.employeeId === selfReviewEmployeeId) {
      throw new ForbiddenException("You cannot approve or reject your own leave request — HR must review it.");
    }

    const wasApproved = existing.status === "APPROVED";
    const isNowApproved = status === "APPROVED";

    const request = await this.prisma.leaveRequest.update({
      where: { id },
      data: { status, reviewedAt: new Date(), reviewedBy: context.actorUserId },
      include: {
        employee: { include: { department: true } },
        leaveType: true,
        reviewer: { include: { employee: true } },
      },
    });

    const statusLabel: Record<LeaveRequestStatus, string> = {
      PENDING: "pending",
      SUPERVISOR_APPROVED: "approved by your supervisor (awaiting HR approval)",
      APPROVED: "approved",
      REJECTED: "rejected",
      NEEDS_REVISION: "returned for additional requirements",
      CANCELLED: "cancelled",
      // Not actually routed through this generic transition (see cancel(),
      // approveCancellation(), denyCancellation()) — present only so this
      // Record stays exhaustive over LeaveRequestStatus.
      CANCELLATION_PENDING: "awaiting approval to cancel",
    };

    if (request.employee.userId && status !== "PENDING") {
      await this.notifications.notifyUsers([request.employee.userId], {
        title:
          status === "APPROVED"
            ? "Leave Request Approved"
            : status === "REJECTED"
              ? "Leave Request Rejected"
              : status === "CANCELLED"
                ? "Leave Request Cancelled"
                : "Leave Request Supervisor-Approved",
        message: `Your ${request.leaveType.name} request for ${request.startDate.toLocaleDateString()} - ${request.endDate.toLocaleDateString()} was ${statusLabel[status]}.${remarks?.trim() ? ` Remarks: ${remarks.trim()}` : ""}`,
        type:
          status === "APPROVED"
            ? "LEAVE_APPROVED"
            : status === "REJECTED"
              ? "LEAVE_REJECTED"
              : status === "CANCELLED"
                ? "LEAVE_CANCELLED"
                : "LEAVE_SUPERVISOR_APPROVED",
        entityId: request.id,
      });
    }

    // Only touch the balance when the *final* approval state is actually changing:
    // - PENDING/SUPERVISOR_APPROVED/REJECTED -> APPROVED: deduct the days.
    // - APPROVED -> anything else (an admin reversing a prior approval): give the days back.
    // - SUPERVISOR_APPROVED is a pre-approval tier only — it never touches the balance,
    //   only the final HR-level APPROVED transition does.
    if (!wasApproved && isNowApproved) {
      await this.adjustLeaveBalance(request.employeeId, request.leaveTypeId, request.startDate, Number(request.totalDays));
    } else if (wasApproved && !isNowApproved && !options.skipBalanceRestore) {
      await this.adjustLeaveBalance(request.employeeId, request.leaveTypeId, request.startDate, -Number(request.totalDays));
    }

    const action =
      status === "APPROVED"
        ? "APPROVE_LEAVE"
        : status === "SUPERVISOR_APPROVED"
          ? "SUPERVISOR_APPROVE_LEAVE"
          : status === "CANCELLED"
            ? "CANCEL_LEAVE"
            : "REJECT_LEAVE";

    await this.auditLogs.record({
      ...context,
      action,
      module: "Leave",
      entityType: "LeaveRequest",
      entityId: id,
      description: `${statusLabel[status][0].toUpperCase()}${statusLabel[status].slice(1)} ${request.employee.firstName} ${request.employee.lastName}'s ${request.leaveType.name} leave request.`,
      oldValues: { status: existing.status },
      newValues: { remarks: remarks?.trim(), status },
    });

    return {
      ...request,
      adminRemarks: remarks?.trim() ? { remarks: remarks.trim(), status } : undefined,
    };
  }

  // Rejection is split out from updateStatus() because it can end in one of two
  // different statuses (a terminal REJECTED, or NEEDS_REVISION when the reviewer
  // flags that the employee just needs to attach something) and, unlike
  // approve/cancel, writes a LeaveRequestNote so the reject/resubmit thread stays
  // intact across however many loops the request goes through.
  async reject(
    id: string,
    dto: RejectLeaveRequestDto,
    context: AuditLogContext = {},
    scopeDepartmentId?: string,
    selfReviewEmployeeId?: string,
  ) {
    const existing = await this.prisma.leaveRequest.findUniqueOrThrow({
      where: { id },
      include: { employee: { select: { departmentId: true } } },
    });

    if (scopeDepartmentId && existing.employee.departmentId !== scopeDepartmentId) {
      throw new ForbiddenException("You can only manage leave requests from your own department.");
    }

    if (selfReviewEmployeeId && existing.employeeId === selfReviewEmployeeId) {
      throw new ForbiddenException("You cannot approve or reject your own leave request — HR must review it.");
    }

    const wasApproved = existing.status === "APPROVED";
    const requiresAdditionalRequirements = Boolean(dto.requiresAdditionalRequirements);
    const status: LeaveRequestStatus = requiresAdditionalRequirements ? "NEEDS_REVISION" : "REJECTED";
    const remarks = dto.remarks?.trim();
    const requirementDetails = dto.requirementDetails?.trim();

    const request = await this.prisma.leaveRequest.update({
      where: { id },
      data: { status, reviewedAt: new Date(), reviewedBy: context.actorUserId },
      include: {
        employee: { include: { department: true } },
        leaveType: true,
        reviewer: { include: { employee: true } },
      },
    });

    if (request.employee.userId) {
      const dateRange = `${request.startDate.toLocaleDateString()} - ${request.endDate.toLocaleDateString()}`;
      const message = requiresAdditionalRequirements
        ? `Your ${request.leaveType.name} request for ${dateRange} needs additional requirements before it can be approved.${remarks ? ` Reason: ${remarks}` : ""}${requirementDetails ? ` Requirement needed: ${requirementDetails}` : ""}`
        : `Your ${request.leaveType.name} request for ${dateRange} was rejected.${remarks ? ` Remarks: ${remarks}` : ""}`;

      await this.notifications.notifyUsers([request.employee.userId], {
        title: requiresAdditionalRequirements ? "Additional Requirements Needed" : "Leave Request Rejected",
        message,
        type: requiresAdditionalRequirements ? "LEAVE_NEEDS_REQUIREMENTS" : "LEAVE_REJECTED",
        entityId: request.id,
      });
    }

    // Reverse a prior approval's balance deduction if an admin is now rejecting
    // (or sending back for revision) a request that had already been approved.
    if (wasApproved) {
      await this.adjustLeaveBalance(request.employeeId, request.leaveTypeId, request.startDate, -Number(request.totalDays));
    }

    await this.prisma.leaveRequestNote.create({
      data: {
        leaveRequestId: id,
        type: "REJECTED",
        message: remarks,
        requiresAdditionalRequirements,
        requirementDetails,
        authorUserId: context.actorUserId,
      },
    });

    await this.auditLogs.record({
      ...context,
      action: "REJECT_LEAVE",
      module: "Leave",
      entityType: "LeaveRequest",
      entityId: id,
      description: `${requiresAdditionalRequirements ? "Requested additional requirements from" : "Rejected"} ${request.employee.firstName} ${request.employee.lastName}'s ${request.leaveType.name} leave request.`,
      oldValues: { status: existing.status },
      newValues: { remarks, requiresAdditionalRequirements, requirementDetails, status },
    });

    return {
      ...request,
      adminRemarks: remarks ? { remarks, status } : undefined,
    };
  }

  async cancel(id: string, context: AuditLogContext = {}, requestingEmployeeId?: string, note?: string) {
    const trimmedNote = note?.trim();
    if (!trimmedNote) {
      throw new BadRequestException("Please provide a reason for cancelling this leave request.");
    }

    const existing = await this.prisma.leaveRequest.findUniqueOrThrow({
      where: { id },
      include: {
        leaveType: true,
        notes: true,
        employee: {
          include: {
            schedules: {
              where: { isActive: true },
              include: { shift: true },
              orderBy: { startsOn: "desc" },
            },
          },
        },
      },
    });

    const cancellableStatuses: LeaveRequestStatus[] = ["PENDING", "SUPERVISOR_APPROVED", "APPROVED"];
    if (!cancellableStatuses.includes(existing.status as LeaveRequestStatus)) {
      throw new BadRequestException("Only a pending, supervisor-approved, or approved request can be cancelled.");
    }

    // requestingEmployeeId is undefined for an ADMIN override cancelling on an
    // employee's behalf; anyone else (including a SUPERVISOR) must only
    // cancel their own request — a Supervisor never cancels a subordinate's.
    if (requestingEmployeeId && existing.employeeId !== requestingEmployeeId) {
      throw new BadRequestException("You can only cancel your own leave request.");
    }

    // Approved leave self-cancellation follows the leave type's configured
    // cutoff (and is permanently blocked once a prior cancellation request
    // was denied — see getCancellationEligibility). HR/Admin cancellation
    // remains an override for manual correction, unaffected by either rule.
    if (existing.status === "APPROVED" && requestingEmployeeId) {
      const eligibility = this.getCancellationEligibility(existing, existing.employee.schedules, existing.notes);
      if (!eligibility.allowed) {
        throw new BadRequestException(eligibility.reason ?? "This request can no longer be cancelled.");
      }
    }

    // An employee cancelling an already-APPROVED leave doesn't take effect
    // immediately — the leave was already granted (balance deducted,
    // schedule/coverage planned around it), so it sits at
    // CANCELLATION_PENDING until a Supervisor/Admin approves or denies the
    // cancellation. Cancelling a PENDING/SUPERVISOR_APPROVED request (nothing
    // committed yet) or an ADMIN override still takes effect immediately.
    if (existing.status === "APPROVED" && requestingEmployeeId) {
      const request = await this.prisma.leaveRequest.update({
        where: { id },
        data: { status: "CANCELLATION_PENDING", preCancellationStatus: "APPROVED" },
        include: { employee: { include: { supervisor: { select: { userId: true } } } }, leaveType: true },
      });

      await this.prisma.leaveRequestNote.create({
        data: { leaveRequestId: id, type: "CANCELLED", message: trimmedNote, authorUserId: context.actorUserId },
      });

      // Same recipient routing as a fresh submission (notifySubmission) — a
      // regular employee's request goes to their supervisor only; a
      // supervisor cancelling their own approved leave routes to HR/Admin
      // instead, since they have no supervisor above them.
      const filerIsSupervisor = await this.notifications.userHasRole(request.employee.userId, "SUPERVISOR");
      const candidateIds = filerIsSupervisor
        ? await this.notifications.adminUserIds()
        : [request.employee.supervisor?.userId];
      const recipientIds = candidateIds.filter((rid): rid is string => Boolean(rid) && rid !== request.employee.userId);

      await this.notifications.notifyUsers(recipientIds, {
        title: "Leave Cancellation Requested",
        message: `${request.employee.firstName} ${request.employee.lastName} wants to cancel their approved ${request.leaveType.name} (${request.startDate.toLocaleDateString()} - ${request.endDate.toLocaleDateString()}). Reason: ${trimmedNote}`,
        type: "LEAVE_CANCELLATION_REQUESTED",
        entityId: request.id,
      });

      await this.auditLogs.record({
        ...context,
        action: "REQUEST_CANCEL_LEAVE",
        module: "Leave",
        entityType: "LeaveRequest",
        entityId: id,
        description: `${request.employee.firstName} ${request.employee.lastName} requested to cancel their ${request.leaveType.name} leave request.`,
        oldValues: { status: existing.status },
        newValues: { note: trimmedNote, status: "CANCELLATION_PENDING" },
      });

      return request;
    }

    // The leave period has already started (or passed) — the days were
    // already taken, so cancelling now must not hand the balance back.
    const alreadyUsed = existing.status === "APPROVED" && toDateOnly(existing.startDate) <= toDateOnly(new Date());

    const result = await this.updateStatus(id, "CANCELLED", undefined, context, undefined, undefined, {
      skipBalanceRestore: alreadyUsed,
    });

    await this.prisma.leaveRequestNote.create({
      data: {
        leaveRequestId: id,
        type: "CANCELLED",
        message: trimmedNote,
        authorUserId: context.actorUserId,
      },
    });

    return result;
  }

  // Approves an employee's pending request to cancel an already-APPROVED
  // leave — finalizes it to CANCELLED and restores the balance (unless the
  // leave period already started, same rule as an immediate cancel).
  async approveCancellation(id: string, context: AuditLogContext = {}, scopeDepartmentId?: string, selfReviewEmployeeId?: string) {
    const existing = await this.prisma.leaveRequest.findUniqueOrThrow({
      where: { id },
      include: { employee: { select: { departmentId: true } } },
    });
    if (existing.status !== "CANCELLATION_PENDING") {
      throw new BadRequestException("This request does not have a pending cancellation.");
    }
    if (scopeDepartmentId && existing.employee.departmentId !== scopeDepartmentId) {
      throw new ForbiddenException("You can only manage leave requests from your own department.");
    }
    if (selfReviewEmployeeId && existing.employeeId === selfReviewEmployeeId) {
      throw new ForbiddenException("You cannot approve or deny your own leave cancellation — HR must review it.");
    }

    const alreadyUsed = toDateOnly(existing.startDate) <= toDateOnly(new Date());
    if (!alreadyUsed) {
      await this.adjustLeaveBalance(existing.employeeId, existing.leaveTypeId, existing.startDate, -Number(existing.totalDays));
    }

    const request = await this.prisma.leaveRequest.update({
      where: { id },
      data: { status: "CANCELLED", preCancellationStatus: null, reviewedAt: new Date(), reviewedBy: context.actorUserId },
      include: { employee: true, leaveType: true },
    });

    if (request.employee.userId) {
      await this.notifications.notifyUsers([request.employee.userId], {
        title: "Leave Cancellation Approved",
        message: `Your request to cancel ${request.leaveType.name} (${request.startDate.toLocaleDateString()} - ${request.endDate.toLocaleDateString()}) was approved. This leave is now cancelled.`,
        type: "LEAVE_CANCELLED",
        entityId: request.id,
      });
    }

    await this.auditLogs.record({
      ...context,
      action: "APPROVE_CANCEL_LEAVE",
      module: "Leave",
      entityType: "LeaveRequest",
      entityId: id,
      description: `Approved ${request.employee.firstName} ${request.employee.lastName}'s request to cancel their ${request.leaveType.name} leave request.`,
      oldValues: { status: "CANCELLATION_PENDING" },
      newValues: { status: "CANCELLED" },
    });

    return request;
  }

  // Denies an employee's pending request to cancel an already-APPROVED
  // leave — the leave simply stays APPROVED, exactly as it was before the
  // cancellation was requested. Balance was never touched, so there's
  // nothing to reverse.
  async denyCancellation(
    id: string,
    remarks: string | undefined,
    context: AuditLogContext = {},
    scopeDepartmentId?: string,
    selfReviewEmployeeId?: string,
  ) {
    const existing = await this.prisma.leaveRequest.findUniqueOrThrow({
      where: { id },
      include: { employee: { select: { departmentId: true } } },
    });
    if (existing.status !== "CANCELLATION_PENDING") {
      throw new BadRequestException("This request does not have a pending cancellation.");
    }
    if (scopeDepartmentId && existing.employee.departmentId !== scopeDepartmentId) {
      throw new ForbiddenException("You can only manage leave requests from your own department.");
    }
    if (selfReviewEmployeeId && existing.employeeId === selfReviewEmployeeId) {
      throw new ForbiddenException("You cannot approve or deny your own leave cancellation — HR must review it.");
    }

    const revertTo = (existing.preCancellationStatus ?? "APPROVED") as LeaveRequestStatus;

    const request = await this.prisma.leaveRequest.update({
      where: { id },
      data: { status: revertTo, preCancellationStatus: null, reviewedAt: new Date(), reviewedBy: context.actorUserId },
      include: { employee: true, leaveType: true },
    });

    // Marks this request as permanently ineligible for another cancellation
    // request (see getCancellationEligibility) and is what the employee's
    // detail view reads to show "Cancellation denied by your supervisor"
    // instead of the request just quietly reverting to a plain APPROVED
    // leave with no record of the attempt.
    await this.prisma.leaveRequestNote.create({
      data: {
        leaveRequestId: id,
        type: "CANCELLATION_DENIED",
        message: remarks?.trim(),
        authorUserId: context.actorUserId,
      },
    });

    if (request.employee.userId) {
      await this.notifications.notifyUsers([request.employee.userId], {
        title: "Leave Cancellation Denied",
        message: `Your request to cancel ${request.leaveType.name} (${request.startDate.toLocaleDateString()} - ${request.endDate.toLocaleDateString()}) was denied — it remains approved.${remarks?.trim() ? ` Remarks: ${remarks.trim()}` : ""}`,
        type: "LEAVE_APPROVED",
        entityId: request.id,
      });
    }

    await this.auditLogs.record({
      ...context,
      action: "DENY_CANCEL_LEAVE",
      module: "Leave",
      entityType: "LeaveRequest",
      entityId: id,
      description: `Denied ${request.employee.firstName} ${request.employee.lastName}'s request to cancel their ${request.leaveType.name} leave request.`,
      oldValues: { status: "CANCELLATION_PENDING" },
      newValues: { remarks: remarks?.trim(), status: revertTo },
    });

    return request;
  }

  // The employee's side of the reject <-> resubmit loop: only valid while the
  // request is sitting in NEEDS_REVISION, and always hands it back to PENDING
  // so it re-enters the normal Supervisor/Admin review flow untouched.
  async resubmit(
    id: string,
    dto: ResubmitLeaveRequestDto,
    context: AuditLogContext = {},
    requestingEmployeeId?: string,
  ) {
    const existing = await this.prisma.leaveRequest.findUniqueOrThrow({ where: { id } });

    if (existing.status !== "NEEDS_REVISION") {
      throw new BadRequestException("Only a request awaiting additional requirements can be resubmitted.");
    }

    if (requestingEmployeeId && existing.employeeId !== requestingEmployeeId) {
      throw new BadRequestException("You can only resubmit your own leave request.");
    }

    if (Buffer.byteLength(dto.attachmentData, "base64") > MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException("Attachment must be 5MB or smaller.");
    }

    const note = dto.note?.trim();

    const request = await this.prisma.leaveRequest.update({
      where: { id },
      data: {
        status: "PENDING",
        reviewedBy: null,
        reviewedAt: null,
        attachmentName: dto.attachmentName,
        attachmentMimeType: dto.attachmentMimeType,
        attachmentData: dto.attachmentData,
      },
      include: {
        employee: { include: { supervisor: true, department: true } },
        leaveType: true,
      },
    });

    await this.prisma.leaveRequestNote.create({
      data: {
        leaveRequestId: id,
        type: "RESUBMITTED",
        message: note,
        attachmentName: dto.attachmentName,
        attachmentMimeType: dto.attachmentMimeType,
        attachmentData: dto.attachmentData,
        authorUserId: context.actorUserId,
      },
    });

    await this.notifyResubmission(request);

    await this.auditLogs.record({
      ...context,
      action: "RESUBMIT_LEAVE",
      module: "Leave",
      entityType: "LeaveRequest",
      entityId: id,
      description: `${request.employee.firstName} ${request.employee.lastName} resubmitted their ${request.leaveType.name} leave request with the requested attachment.`,
      oldValues: { status: existing.status },
      newValues: { status: "PENDING", note },
    });

    return request;
  }

  private async notifyResubmission(request: {
    id: string;
    employee: { userId: string | null; firstName: string; lastName: string; supervisor: { userId: string | null } | null };
    leaveType: { name: string };
  }) {
    const filerIsSupervisor = await this.notifications.userHasRole(request.employee.userId, "SUPERVISOR");
    const candidateIds = filerIsSupervisor
      ? await this.notifications.adminUserIds()
      : [request.employee.supervisor?.userId];
    const recipientIds = candidateIds.filter(
      (id): id is string => Boolean(id) && id !== request.employee.userId,
    );

    const employeeName = `${request.employee.firstName} ${request.employee.lastName}`;

    await this.notifications.notifyUsers(recipientIds, {
      title: "Leave Request Resubmitted",
      message: `${employeeName} resubmitted their ${request.leaveType.name} request with the requested attachment.`,
      type: "LEAVE_RESUBMITTED",
      entityId: request.id,
    });
  }

  async setExtensionDecision(id: string, extensionApproved: boolean, actorUserId?: string) {
    const updated = await this.prisma.leaveRequest.update({
      where: { id },
      data: { extensionApproved },
      include: {
        employee: { include: { department: true } },
        leaveType: true,
        reviewer: { include: { employee: true } },
      },
    });

    if (updated.employee.userId) {
      await this.notifications.notifyUsers([updated.employee.userId], {
        title: extensionApproved ? "Maternity Extension Approved" : "Maternity Extension Rejected",
        message: `Your request to extend your ${updated.leaveType.name} by 30 days without pay was ${extensionApproved ? "approved" : "rejected"}.`,
        type: extensionApproved ? "LEAVE_EXTENSION_APPROVED" : "LEAVE_EXTENSION_REJECTED",
        entityId: updated.id,
      });
    }

    await this.prisma.auditLog.create({
      data: {
        actorUserId,
        action: "SET_MATERNITY_EXTENSION",
        entityType: "LeaveRequest",
        entityId: id,
        newValues: { extensionApproved },
      },
    });

    return updated;
  }

  // Adds (or subtracts, for reversals) `deltaDays` from an employee's used-days balance
  // for the leave type and calendar year of the request's start date. Creates the
  // balance row on first use, seeded with the leave type's default annual allotment.
  // Never blocks on insufficient balance — usedDays is allowed to exceed earnedDays,
  // which is exactly how a `leaveType.allowWithoutPay` type (e.g. LWOP) stays usable
  // as a fallback once an employee's paid credits are exhausted.
  private async adjustLeaveBalance(employeeId: string, leaveTypeId: string, requestStartDate: Date, deltaDays: number) {
    const year = requestStartDate.getFullYear();

    const leaveType = await this.prisma.leaveType.findUniqueOrThrow({
      where: { id: leaveTypeId },
    });

    const existingBalance = await this.prisma.leaveBalance.findUnique({
      where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
    });

    if (existingBalance) {
      const nextUsedDays = Math.max(0, Number(existingBalance.usedDays) + deltaDays);
      await this.prisma.leaveBalance.update({
        where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
        data: { usedDays: nextUsedDays },
      });
    } else {
      // First time this employee has used this leave type in this year: seed a balance
      // row using the leave type's configured default allotment as earnedDays.
      await this.prisma.leaveBalance.create({
        data: {
          employeeId,
          leaveTypeId,
          year,
          earnedDays: leaveType.defaultDays,
          usedDays: Math.max(0, deltaDays),
        },
      });
    }
  }
}
