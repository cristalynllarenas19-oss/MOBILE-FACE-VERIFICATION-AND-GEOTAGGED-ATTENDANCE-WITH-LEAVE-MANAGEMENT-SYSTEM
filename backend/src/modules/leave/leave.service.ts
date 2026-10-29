import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AuditLogContext, AuditLogsService } from "../audit-logs/audit-logs.service";
import { CreateLeaveRequestDto } from "./dto/create-leave-request.dto";
import { CreateLeaveRequestsDto } from "./dto/create-leave-requests.dto";
import { RejectLeaveRequestDto } from "./dto/reject-leave-request.dto";
import { ResubmitLeaveRequestDto } from "./dto/resubmit-leave-request.dto";
import { RequestLeaveExtensionDto } from "./dto/request-leave-extension.dto";
import { isEligibleForLeaveType } from "./leave-balances.service";
import { isNonWorkingDay } from "../../common/utils/schedule.util";
import { resolveMissedDays } from "../attendance/attendance-missed-days.util";

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
type LeaveRequestStatus =
  | "PENDING"
  | "SUPERVISOR_APPROVED"
  | "APPROVED"
  | "REJECTED"
  | "NEEDS_REVISION"
  | "CANCELLED"
  | "CANCELLATION_PENDING"
  | "LAPSED";

// Audit actions that represent a step in a request's approval timeline —
// everything updateStatus/reject/cancel/resubmit/approveCancellation/
// denyCancellation already writes to AuditLog. Kept separate from other
// "Leave" module actions (e.g. leave type CRUD) so buildHistory() only ever
// surfaces events that belong to this one request's lifecycle.
const TIMELINE_ACTIONS = new Set([
  "SUPERVISOR_APPROVE_LEAVE",
  "APPROVE_LEAVE",
  "REJECT_LEAVE",
  "RESUBMIT_LEAVE",
  "CANCEL_LEAVE",
  "REQUEST_CANCEL_LEAVE",
  "APPROVE_CANCEL_LEAVE",
  "DENY_CANCEL_LEAVE",
  "LAPSE_LEAVE",
]);

// Local-midnight truncation, matching the same toDateString()-based same-day
// comparisons already used elsewhere in this file (see isSingleDayOnly check
// in create()) — keeps "today"/"already started" comparisons independent of
// time-of-day.
function toDateOnly(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

// A Maternity Leave can be extended once, by this many calendar days without
// pay, if the employee asks at least EXTENSION_NOTICE_DAYS before it ends
// (RA 11210) — see getExtensionEligibility / requestExtension.
const EXTENSION_DAYS = 30;
const EXTENSION_NOTICE_DAYS = 45;
// An extension in any of these still stands (or is still being decided), so
// another one can't be requested for the same Maternity Leave.
const ACTIVE_EXTENSION_STATUSES: LeaveRequestStatus[] = [
  "PENDING",
  "SUPERVISOR_APPROVED",
  "NEEDS_REVISION",
  "APPROVED",
  "CANCELLATION_PENDING",
];

// `value` moved by `days` calendar days, keeping its time of day — so a
// derived date is stored the same way as the one it came from.
function addDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setDate(result.getDate() + days);
  return result;
}

// Every calendar day from start to end (local midnights), inclusive.
function calendarDays(start: Date, end: Date): Date[] {
  const days: Date[] = [];
  const last = toDateOnly(end).getTime();
  for (let day = toDateOnly(start); day.getTime() <= last; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
    days.push(day);
  }
  return days;
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

    // Requests split off another one also need that one's history (see
    // historyLineage) — fetched in the same query.
    const lineage = await this.historyLineage(requests);
    const ancestorIds = Array.from(lineage.values()).flatMap((chain) => chain.map((link) => link.id));
    const remarks = await this.prisma.auditLog.findMany({
      where: { entityType: "LeaveRequest", entityId: { in: [...requests.map((request) => request.id), ...ancestorIds] } },
      include: { actor: { include: { employee: true } } },
      orderBy: { createdAt: "desc" },
    });

    // Same rows as `remarks` above, just grouped per request — reused to
    // reconstruct each request's approval timeline (see buildHistory) without
    // a second query.
    const auditLogsByRequestId = new Map<string, typeof remarks>();
    for (const log of remarks) {
      if (!log.entityId) continue;
      const list = auditLogsByRequestId.get(log.entityId) ?? [];
      list.push(log);
      auditLogsByRequestId.set(log.entityId, list);
    }

    // The time-in check in getCancellationEligibility only ever runs for
    // APPROVED requests, so attendance is only fetched for those — one query
    // spanning every approved request's dates, then matched per request.
    const approvedRequests = requests.filter((request) => request.status === "APPROVED");
    const workedDatesByEmployeeId = new Map<string, Date[]>();
    if (approvedRequests.length > 0) {
      const worked = await this.prisma.attendanceRecord.findMany({
        where: {
          employeeId: { in: Array.from(new Set(approvedRequests.map((request) => request.employeeId))) },
          timeInAt: { not: null },
          attendanceDate: {
            gte: toDateOnly(new Date(Math.min(...approvedRequests.map((request) => request.startDate.getTime())))),
            lte: toDateOnly(new Date(Math.max(...approvedRequests.map((request) => request.endDate.getTime())))),
          },
        },
        select: { employeeId: true, attendanceDate: true },
      });
      for (const record of worked) {
        const list = workedDatesByEmployeeId.get(record.employeeId) ?? [];
        list.push(record.attendanceDate);
        workedDatesByEmployeeId.set(record.employeeId, list);
      }
    }

    return requests.map((request) => ({
      ...request,
      adminRemarks: remarks.find((remark) => remark.entityId === request.id)?.newValues,
      // Lets the employee self-service UI disable Cancel (or individual
      // days) and explain why instead of only finding out after a failed
      // attempt — same rule the cancel() endpoint enforces.
      cancellation: this.getCancellationEligibility(request, workedDatesByEmployeeId.get(request.employeeId) ?? [], request.notes),
      // Same idea for the 30-day Maternity Leave extension — its extension
      // (if any) is always in this same list, being the same employee's.
      extension: this.getExtensionEligibility(request, requests),
      history: this.buildHistory(request, [
        ...(auditLogsByRequestId.get(request.id) ?? []),
        ...(lineage.get(request.id) ?? []).flatMap((link) =>
          (auditLogsByRequestId.get(link.id) ?? []).filter((log) => log.createdAt <= link.until),
        ),
      ]),
    }));
  }

  // Fetches a single request with its attachment data included — unlike
  // findAll's employee-mobile poll (includeAttachments=false), this is only
  // called on demand (e.g. when an employee taps "view attachment"), so the
  // base64 payload here never bloats a recurring list poll.
  async findOne(id: string, requestingEmployeeId?: string, scopeDepartmentId?: string) {
    const request = await this.prisma.leaveRequest.findUniqueOrThrow({
      where: { id },
      include: {
        employee: { include: { department: true } },
        leaveType: true,
        reviewer: { include: { employee: true } },
        notes: { orderBy: { createdAt: "asc" } },
      },
    });

    if (requestingEmployeeId && request.employeeId !== requestingEmployeeId) {
      throw new ForbiddenException("You can only view your own leave request.");
    }
    if (scopeDepartmentId && request.employee.departmentId !== scopeDepartmentId) {
      throw new ForbiddenException("You can only view leave requests from your own department.");
    }

    const chain = (await this.historyLineage([request])).get(request.id) ?? [];
    const logs = await this.prisma.auditLog.findMany({
      where: { entityType: "LeaveRequest", entityId: { in: [id, ...chain.map((link) => link.id)] } },
      include: { actor: { include: { employee: true } } },
      orderBy: { createdAt: "asc" },
    });
    const ownAndInherited = logs.filter((log) => {
      if (log.entityId === id) return true;
      const link = chain.find((candidate) => candidate.id === log.entityId);
      return !!link && log.createdAt <= link.until;
    });

    return { ...request, history: this.buildHistory(request, ownAndInherited) };
  }

  // A request split off another one by a partial cancellation (see
  // splitForCancellation) has no audit history of its own from before the
  // split — its timeline inherits each request it came from, up to the
  // moment it was split off. Returns, per request, those ancestors with the
  // cutoff to apply to each one's history.
  private async historyLineage(requests: Array<{ id: string; splitFromId: string | null; splitAt: Date | null }>) {
    const known = new Map<string, { id: string; splitFromId: string | null; splitAt: Date | null }>(
      requests.map((request) => [request.id, request]),
    );
    let missing = Array.from(new Set(requests.map((request) => request.splitFromId).filter((id): id is string => !!id && !known.has(id))));
    while (missing.length > 0) {
      const rows = await this.prisma.leaveRequest.findMany({
        where: { id: { in: missing } },
        select: { id: true, splitFromId: true, splitAt: true },
      });
      for (const row of rows) known.set(row.id, row);
      missing = Array.from(new Set(rows.map((row) => row.splitFromId).filter((id): id is string => !!id && !known.has(id))));
    }

    const lineage = new Map<string, Array<{ id: string; until: Date }>>();
    for (const request of requests) {
      const chain: Array<{ id: string; until: Date }> = [];
      let parentId = request.splitFromId;
      let until = request.splitAt;
      while (parentId && until) {
        chain.push({ id: parentId, until });
        const parent = known.get(parentId);
        if (!parent) break;
        if (parent.splitAt && parent.splitAt < until) until = parent.splitAt;
        parentId = parent.splitFromId;
      }
      lineage.set(request.id, chain);
    }
    return lineage;
  }

  // Reconstructs a request's approval timeline — Filed, then whatever
  // review/cancel actions actually happened — straight from the AuditLog
  // rows every transition above already writes. Avoids adding dedicated
  // per-stage timestamp columns (SUPERVISOR_APPROVED is a single-tier
  // approval today — see the controller's approve() — so there's no fixed
  // number of stages to model; this just replays whatever really occurred).
  private buildHistory(
    request: { createdAt: Date; employee: { firstName: string; lastName: string } },
    logs: Array<{
      action: string;
      createdAt: Date;
      newValues: unknown;
      actor: { email: string; employee: { firstName: string; lastName: string } | null } | null;
    }>,
  ) {
    const actorName = (log: (typeof logs)[number]) =>
      log.actor?.employee ? `${log.actor.employee.firstName} ${log.actor.employee.lastName}` : (log.actor?.email ?? null);

    const events = logs
      .filter((log) => TIMELINE_ACTIONS.has(log.action))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((log) => {
        // REJECT_LEAVE/DENY_CANCEL_LEAVE write `remarks`; RESUBMIT_LEAVE and
        // REQUEST_CANCEL_LEAVE write `note` for the same "message from the
        // actor" purpose — normalized to one field so the client doesn't need
        // to know which action used which key.
        const values = (log.newValues ?? {}) as { status?: string; remarks?: string; note?: string; requirementDetails?: string };
        return {
          action: log.action,
          status: values.status ?? null,
          actorName: actorName(log),
          occurredAt: log.createdAt,
          remarks: values.remarks || values.note || null,
          requirementDetails: values.requirementDetails || null,
        };
      });

    return [
      {
        action: "FILED",
        status: "PENDING",
        actorName: `${request.employee.firstName} ${request.employee.lastName}`,
        occurredAt: request.createdAt,
        remarks: null,
        requirementDetails: null,
      },
      ...events,
    ];
  }

  // Whether an EMPLOYEE (not an ADMIN override) could cancel this request
  // right now, and why not if not. PENDING/SUPERVISOR_APPROVED can always be
  // cancelled; APPROVED needs a leave type HR allows employees to cancel, and
  // each day can be cancelled only while the employee hasn't timed in on it
  // — there is no cutoff before the leave starts. workedDates lists the days
  // that can no longer be picked.
  private getCancellationEligibility(
    request: {
      status: string;
      startDate: Date;
      endDate: Date;
      leaveType: {
        name: string;
        cancellationAllowed: boolean;
      };
    },
    // The employee's time-in dates — any range is fine, only the ones inside
    // this request's own dates count.
    workedDates: Date[],
    // Once a Supervisor/Admin denies a cancellation request (see
    // denyCancellation), the request permanently loses the ability to
    // request another one — this is what a CANCELLATION_DENIED note means.
    // The request itself is untouched otherwise (still plain APPROVED), so
    // without this check it would look exactly like a leave that never had
    // a cancellation attempt at all.
    notes: Array<{ type: string }> = [],
  ): { allowed: boolean; reason?: string; workedDates?: string[] } {
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
    const start = toDateOnly(request.startDate).getTime();
    const end = toDateOnly(request.endDate).getTime();
    const workedOnLeave = Array.from(
      new Set(
        workedDates
          .map((date) => toDateOnly(date).getTime())
          .filter((day) => day >= start && day <= end),
      ),
    ).sort((a, b) => a - b);
    if (workedOnLeave.length >= calendarDays(request.startDate, request.endDate).length) {
      return {
        allowed: false,
        reason: `You already timed in on every day of this ${request.leaveType.name}, so it can no longer be cancelled. Please contact HR/Admin.`,
      };
    }
    return { allowed: true, workedDates: workedOnLeave.map((day) => new Date(day).toISOString()) };
  }

  // Whether the employee could ask to extend this leave by 30 days without
  // pay right now, and why not if not — null for anything but an APPROVED
  // Maternity Leave (an extension itself can't be extended). It has to be
  // asked at least 45 days before the leave ends, and only once per leave
  // (a rejected or cancelled extension can be asked for again). startDate/
  // endDate are the days the extension would cover.
  private getExtensionEligibility(
    request: {
      id: string;
      status: string;
      endDate: Date;
      extensionOfId: string | null;
      leaveType: { kind: string; name: string };
    },
    // Any requests that may include this one's extension — only the ones
    // pointing back to it count.
    others: Array<{ id: string; status: string; extensionOfId: string | null }>,
  ): { allowed: boolean; reason?: string; deadline: string; startDate: string; endDate: string; extensionId?: string } | null {
    if (request.leaveType.kind !== "MATERNITY" || request.extensionOfId || request.status !== "APPROVED") {
      return null;
    }
    const deadline = addDays(toDateOnly(request.endDate), -EXTENSION_NOTICE_DAYS);
    const window = {
      deadline: deadline.toISOString(),
      startDate: addDays(request.endDate, 1).toISOString(),
      endDate: addDays(request.endDate, EXTENSION_DAYS).toISOString(),
    };

    const existing = others.find(
      (other) => other.extensionOfId === request.id && ACTIVE_EXTENSION_STATUSES.includes(other.status as LeaveRequestStatus),
    );
    if (existing) {
      return {
        ...window,
        allowed: false,
        extensionId: existing.id,
        reason:
          existing.status === "APPROVED" || existing.status === "CANCELLATION_PENDING"
            ? `This ${request.leaveType.name} has already been extended by ${EXTENSION_DAYS} days.`
            : `You already requested a ${EXTENSION_DAYS}-day extension of this ${request.leaveType.name} — it is awaiting review.`,
      };
    }
    if (toDateOnly(new Date()) > deadline) {
      return {
        ...window,
        allowed: false,
        reason: `A ${EXTENSION_DAYS}-day extension must be requested at least ${EXTENSION_NOTICE_DAYS} days before your ${request.leaveType.name} ends — the last day to request it was ${deadline.toLocaleDateString()}.`,
      };
    }
    return { ...window, allowed: true };
  }

  async create(dto: CreateLeaveRequestDto, context: AuditLogContext = {}) {
    const [request] = await this.fileRequests(
      dto,
      [{ startDate: new Date(dto.startDate), endDate: new Date(dto.endDate), totalDays: Number(dto.totalDays) }],
      false,
      context,
    );
    return request;
  }

  // Sick Leave picked for several days at once — any mix of today and past
  // absences. One single-day request per date (each reviewed on its own),
  // all validated before any of them is created, so a bad date files none.
  async createForDates(dto: CreateLeaveRequestsDto, context: AuditLogContext = {}) {
    // Each date is stored exactly as sent, same as create(); only its local
    // calendar day is used to drop a date picked twice.
    const byDay = new Map<number, Date>();
    for (const value of dto.dates) {
      const date = new Date(value);
      byDay.set(toDateOnly(date).getTime(), date);
    }
    const days = Array.from(byDay.values())
      .sort((a, b) => a.getTime() - b.getTime())
      .map((date) => ({ startDate: date, endDate: date, totalDays: 1 }));
    return this.fileRequests(dto, days, true, context);
  }

  private async fileRequests(
    dto: {
      employeeId: string;
      leaveTypeId: string;
      reason: string;
      attachmentName?: string;
      attachmentMimeType?: string;
      attachmentData?: string;
      extensionRequested?: boolean;
    },
    days: Array<{ startDate: Date; endDate: Date; totalDays: number }>,
    multipleDates: boolean,
    context: AuditLogContext,
  ) {
    if (dto.attachmentData && Buffer.byteLength(dto.attachmentData, "base64") > MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException("Attachment must be 5MB or smaller.");
    }

    const leaveType = await this.prisma.leaveType.findUniqueOrThrow({ where: { id: dto.leaveTypeId } });

    // Picking several dates in one go is only for single-day types that can
    // be backfiled onto absences (Sick Leave) — every other type files one
    // request (one date or one range) at a time.
    if (multipleDates && !(leaveType.isSingleDayOnly && leaveType.pastAbsenceFilingAllowed)) {
      throw new BadRequestException(`${leaveType.name} can only be filed for one date or date range per request.`);
    }

    // An employee can have multiple leave types in flight at once, but not two
    // requests of the *same* type — they must wait for the existing one to be
    // fully APPROVED (or REJECTED/CANCELLED) before filing another of that
    // type. A different type is always allowed. Dates picked together in one
    // multi-date filing count as one filing here.
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

    for (const day of days) {
      await this.assertDatesFileable(dto.employeeId, leaveType, day);
    }

    // Paid, capped leave types must not be requestable past what's left in the
    // employee's balance for the year — allowWithoutPay/isUnlimitedDays types
    // (e.g. LWOP) are intentionally exempt, same as in adjustLeaveBalance below.
    // Each request draws on its own start date's year, so a multi-date filing
    // that crosses New Year is checked against both years' balances.
    if (!leaveType.allowWithoutPay && !leaveType.isUnlimitedDays) {
      const requestedByYear = new Map<number, number>();
      for (const day of days) {
        const year = day.startDate.getFullYear();
        requestedByYear.set(year, (requestedByYear.get(year) ?? 0) + day.totalDays);
      }

      for (const [year, requestedDays] of requestedByYear) {
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

        if (requestedDays > remainingDays) {
          throw new BadRequestException(
            `Insufficient ${leaveType.name} balance: you have ${remainingDays} day(s) remaining but requested ${requestedDays}.`,
          );
        }
      }
    }

    // The 30-day unpaid extension only makes sense for a Maternity-kind leave
    // type — a crafted request against any other leave type is silently
    // ignored rather than trusted, even though the frontend already gates this.
    const extensionRequested = Boolean(dto.extensionRequested) && leaveType.kind === "MATERNITY";

    const requests = await this.prisma.$transaction(
      days.map((day) =>
        this.prisma.leaveRequest.create({
          data: {
            employeeId: dto.employeeId,
            leaveTypeId: dto.leaveTypeId,
            startDate: day.startDate,
            endDate: day.endDate,
            totalDays: day.totalDays,
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
        }),
      ),
    );

    await this.notifySubmission(requests);

    for (const request of requests) {
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
    }

    return requests;
  }

  // Every date rule a single request's [startDate, endDate] has to pass —
  // run once per request, so each date of a multi-date filing is held to
  // exactly the same rules as a request filed on its own.
  private async assertDatesFileable(
    employeeId: string,
    leaveType: {
      name: string;
      isSingleDayOnly: boolean;
      advanceFilingAllowed: boolean;
      pastAbsenceFilingAllowed: boolean;
    },
    day: { startDate: Date; endDate: Date; totalDays: number },
  ) {
    await this.assertNoOverlap(employeeId, day.startDate, day.endDate);

    // Sick Leave / Emergency Leave (and any other isSingleDayOnly type) are
    // always exactly one day — the frontend already forces this, but a
    // crafted request is validated the same way every other rule here is.
    if (leaveType.isSingleDayOnly) {
      const sameDay = day.startDate.toDateString() === day.endDate.toDateString();
      if (!sameDay || Number(day.totalDays) !== 1) {
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
    //
    // pastAbsenceFilingAllowed (Sick Leave, Compassionate Leave) additionally
    // opens up a past start date, but only one the employee was actually
    // ABSENT on — checked further down (mustBeAbsentOn), after the
    // day-off/worked-day checks so those keep their more specific messages.
    // Only the start date needs it: the overlap and worked-day checks already
    // rule out every other past day in the range that isn't an absence.
    let mustBeAbsentOn: Date | null = null;
    if (leaveType.advanceFilingAllowed) {
      const requestedStart = toDateOnly(day.startDate);
      if (leaveType.pastAbsenceFilingAllowed && requestedStart < toDateOnly(new Date())) {
        mustBeAbsentOn = requestedStart;
      }
    } else {
      const requestedStart = toDateOnly(day.startDate);
      const today = toDateOnly(new Date());
      if (requestedStart > today) {
        throw new BadRequestException(
          leaveType.isSingleDayOnly
            ? `${leaveType.name} must be filed for today's date${leaveType.pastAbsenceFilingAllowed ? " or a past day you were absent" : " only"}.`
            : `${leaveType.name} cannot be filed in advance — the date must be today or earlier.`,
        );
      }
      if (requestedStart < today) {
        if (leaveType.pastAbsenceFilingAllowed) {
          mustBeAbsentOn = requestedStart;
        } else if (leaveType.isSingleDayOnly) {
          throw new BadRequestException(`${leaveType.name} must be filed for today's date only.`);
        }
      }
    }

    // An employee can't file leave to cover a day they aren't scheduled to
    // work in the first place — mirrors the calendar's own day-off styling
    // (CalendarPickerModal's isDateNonWorking) so a crafted request can't
    // bypass it. Only the request's boundary dates are checked: the days in
    // between a multi-day range are already implicitly off as part of a
    // normal working-week span and don't need to individually pass.
    const boundaryDateStrings = new Set([day.startDate, day.endDate].map((d) => d.toDateString()));
    for (const dateString of boundaryDateStrings) {
      const date = new Date(dateString);
      const scheduleOnDate = await this.prisma.employeeSchedule.findFirst({
        where: {
          employeeId,
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

    // Same rule updateStatus enforces at approval — a day the employee already
    // worked can't become a leave day — checked here too so they find out
    // when filing instead of only when their reviewer tries to approve it.
    const workedDays = await this.workedDaysInRange(employeeId, day.startDate, day.endDate);
    if (workedDays) {
      throw new BadRequestException(
        `You already have attendance on ${workedDays}. A leave can't be filed for a day you worked.`,
      );
    }

    if (mustBeAbsentOn && !(await this.isAbsentDay(employeeId, mustBeAbsentOn))) {
      throw new BadRequestException(
        `${mustBeAbsentOn.toLocaleDateString()} isn't an absence on your record — ${leaveType.name} can only be filed for a past day you were absent.`,
      );
    }
  }

  // Any date already covered by another filed request — of *any* leave type,
  // whether still awaiting review or already approved (including one whose
  // cancellation is still pending) — is off-limits until that request is
  // rejected or cancelled. One day can only ever be covered by a single
  // leave.
  private async assertNoOverlap(employeeId: string, startDate: Date, endDate: Date) {
    const overlapping = await this.prisma.leaveRequest.findFirst({
      where: {
        employeeId,
        status: { in: ["PENDING", "SUPERVISOR_APPROVED", "NEEDS_REVISION", "APPROVED", "CANCELLATION_PENDING"] },
        startDate: { lte: endDate },
        endDate: { gte: startDate },
      },
      include: { leaveType: { select: { name: true } } },
    });

    if (overlapping) {
      const filedAs =
        overlapping.status === "APPROVED" || overlapping.status === "CANCELLATION_PENDING" ? "approved" : "pending";
      throw new BadRequestException(
        `These dates overlap your ${filedAs} ${overlapping.leaveType.name} ` +
          `(${overlapping.startDate.toLocaleDateString()} – ${overlapping.endDate.toLocaleDateString()}). ` +
          `Cancel that request first if you need to change it.`,
      );
    }
  }

  // The days in [startDate, endDate] the employee timed in, formatted for an
  // error message — or null when they worked none of them.
  private async workedDaysInRange(employeeId: string, startDate: Date, endDate: Date) {
    const worked = await this.prisma.attendanceRecord.findMany({
      where: {
        employeeId,
        timeInAt: { not: null },
        attendanceDate: { gte: toDateOnly(startDate), lte: toDateOnly(endDate) },
      },
      select: { attendanceDate: true },
      orderBy: { attendanceDate: "asc" },
    });
    if (worked.length === 0) return null;
    return Array.from(new Set(worked.map((record) => record.attendanceDate.toLocaleDateString()))).join(", ");
  }

  // Whether the employee was ABSENT on `date`, by the same reconstruction
  // their DTR uses (see resolveMissedDays): a scheduled working day, on or
  // after their hire date, with no attendance record and no leave — approved
  // or still awaiting a decision — already covering it.
  private async isAbsentDay(employeeId: string, date: Date) {
    const day = toDateOnly(date);
    const nextDay = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    const [employee, recorded, leaves, schedules] = await Promise.all([
      this.prisma.employee.findUnique({ where: { id: employeeId }, select: { hireDate: true } }),
      this.prisma.attendanceRecord.findMany({
        where: { employeeId, attendanceDate: { gte: day, lt: nextDay } },
        select: { attendanceDate: true },
      }),
      this.prisma.leaveRequest.findMany({
        where: {
          employeeId,
          status: { in: ["APPROVED", "CANCELLATION_PENDING", "PENDING", "SUPERVISOR_APPROVED", "NEEDS_REVISION"] },
          startDate: { lt: nextDay },
          endDate: { gte: day },
        },
        select: { status: true, startDate: true, endDate: true, leaveType: { select: { name: true } } },
      }),
      this.prisma.employeeSchedule.findMany({
        where: { employeeId, isActive: true },
        orderBy: { startsOn: "desc" },
        select: {
          startsOn: true,
          endsOn: true,
          workingDays: true,
          shift: { select: { name: true, startTime: true, endTime: true, lateThresholdMinutes: true } },
        },
      }),
    ]);
    if (!employee) return false;

    const missed = resolveMissedDays({
      windowStart: day,
      now: new Date(),
      hireDate: employee.hireDate,
      recordedDates: recorded.map((record) => record.attendanceDate),
      leaves: leaves.map((leave) => ({
        startDate: leave.startDate,
        endDate: leave.endDate,
        leaveTypeName: leave.leaveType.name,
        approved: leave.status === "APPROVED" || leave.status === "CANCELLATION_PENDING",
      })),
      schedules,
    });
    return missed.some((entry) => entry.status === "ABSENT" && entry.date.getTime() === day.getTime());
  }

  // One notification per filing — a multi-date Sick Leave filing lists all
  // its dates in a single message instead of one notification per day.
  private async notifySubmission(
    requests: Array<{
      id: string;
      startDate: Date;
      endDate: Date;
      employee: { userId: string | null; firstName: string; lastName: string; supervisor: { userId: string | null } | null };
      leaveType: { name: string };
    }>,
  ) {
    const [request] = requests;
    const recipientIds = await this.notifications.filingReviewerIds(
      request.employee.userId,
      request.employee.supervisor?.userId,
    );

    const employeeName = `${request.employee.firstName} ${request.employee.lastName}`;
    const message =
      requests.length === 1
        ? `${employeeName} filed a ${request.leaveType.name} request for ${request.startDate.toLocaleDateString()} - ${request.endDate.toLocaleDateString()}.`
        : `${employeeName} filed ${requests.length} ${request.leaveType.name} requests for ${requests.map((r) => r.startDate.toLocaleDateString()).join(", ")}.`;

    await this.notifications.notifyUsers(recipientIds, {
      title: "New Leave Request",
      message,
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

    // An employee on approved leave can't record attendance (see
    // AttendanceService.submit) — and the reverse has to hold too: a day
    // they actually worked can't afterwards be turned into a leave day.
    if (isNowApproved && !wasApproved) {
      const workedDays = await this.workedDaysInRange(existing.employeeId, existing.startDate, existing.endDate);
      if (workedDays) {
        throw new BadRequestException(
          `This employee has attendance on ${workedDays}. A leave can't be approved for a day the employee worked.`,
        );
      }
    }

    const request = await this.prisma.leaveRequest.update({
      where: { id },
      data: { status, lapseReason: null, reviewedAt: new Date(), reviewedBy: context.actorUserId },
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
      // Only ever set by LeaveLapseService, never through this transition.
      LAPSED: "lapsed",
    };

    // A Maternity Leave extension is reviewed like any request, but says so.
    const subject = request.extensionOfId ? `${EXTENSION_DAYS}-day ${request.leaveType.name} extension` : request.leaveType.name;

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
        message: `Your ${subject} request for ${request.startDate.toLocaleDateString()} - ${request.endDate.toLocaleDateString()} was ${statusLabel[status]}.${remarks?.trim() ? ` Remarks: ${remarks.trim()}` : ""}`,
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
    // - A Maternity Leave extension is without pay — it never touches the balance.
    const countsAgainstBalance = !request.extensionOfId;
    if (countsAgainstBalance && !wasApproved && isNowApproved) {
      await this.adjustLeaveBalance(request.employeeId, request.leaveTypeId, request.startDate, Number(request.totalDays));
    } else if (countsAgainstBalance && wasApproved && !isNowApproved && !options.skipBalanceRestore) {
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
    // The employee is told why in the rejection notification, so a reason is
    // mandatory — whether it's an outright rejection or a resubmission request.
    if (!remarks) {
      throw new BadRequestException("Please provide remarks explaining why this leave request is being rejected.");
    }

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

  async cancel(
    id: string,
    context: AuditLogContext = {},
    callerEmployeeId?: string,
    note?: string,
    supervisorDepartmentId?: string,
    // Optional supporting document for the cancellation — kept on the
    // CANCELLED note, the same way a resubmission's document is kept on its
    // RESUBMITTED note, so reviewers see it alongside the reason.
    attachment?: { attachmentName?: string; attachmentMimeType?: string; attachmentData?: string },
    // Only these days of the leave are cancelled — the rest stay, as their
    // own request(s) (see splitForCancellation). Omitted = the whole leave.
    dates?: string[],
  ) {
    const trimmedNote = note?.trim();
    if (!trimmedNote) {
      throw new BadRequestException("Please provide a reason for cancelling this leave request.");
    }
    if (attachment?.attachmentData && Buffer.byteLength(attachment.attachmentData, "base64") > MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException("Attachment must be 5MB or smaller.");
    }
    const noteAttachment = attachment?.attachmentData
      ? {
          attachmentName: attachment.attachmentName,
          attachmentMimeType: attachment.attachmentMimeType,
          attachmentData: attachment.attachmentData,
        }
      : {};

    const existing = await this.prisma.leaveRequest.findUniqueOrThrow({
      where: { id },
      include: {
        leaveType: true,
        notes: true,
        employee: true,
      },
    });

    const cancellableStatuses: LeaveRequestStatus[] = ["PENDING", "SUPERVISOR_APPROVED", "APPROVED"];
    if (!cancellableStatuses.includes(existing.status as LeaveRequestStatus)) {
      throw new BadRequestException("Only a pending, supervisor-approved, or approved request can be cancelled.");
    }

    // A SUPERVISOR cancelling someone else's request is an override like an
    // ADMIN's, but only inside their own department. Their own request is
    // not an override — it follows the self-cancel rules below.
    let requestingEmployeeId = callerEmployeeId;
    if (supervisorDepartmentId && existing.employeeId !== callerEmployeeId) {
      if (existing.employee.departmentId !== supervisorDepartmentId) {
        throw new ForbiddenException("You can only manage leave requests from your own department.");
      }
      requestingEmployeeId = undefined;
    }

    // requestingEmployeeId is undefined for an ADMIN/SUPERVISOR override
    // cancelling on an employee's behalf; anyone else must only cancel their
    // own request.
    if (requestingEmployeeId && existing.employeeId !== requestingEmployeeId) {
      throw new BadRequestException("You can only cancel your own leave request.");
    }

    // A Maternity Leave extension runs from the day after the leave ends, so
    // the leave itself can't change while an extension of it still stands.
    const standingExtension = await this.prisma.leaveRequest.findFirst({
      where: { extensionOfId: existing.id, status: { in: ACTIVE_EXTENSION_STATUSES } },
      select: { id: true },
    });
    if (standingExtension) {
      throw new BadRequestException(
        `This ${existing.leaveType.name} has a ${EXTENSION_DAYS}-day extension filed against it. Cancel the extension first.`,
      );
    }

    // Which days are being cancelled — every day of the leave unless the
    // employee picked specific ones.
    const leaveDays = calendarDays(existing.startDate, existing.endDate);
    const leaveDayKeys = new Set(leaveDays.map((day) => day.getTime()));
    let cancelDays = leaveDays;
    if (dates && dates.length > 0) {
      const picked = new Map<number, Date>();
      for (const value of dates) {
        const day = toDateOnly(new Date(value));
        if (!leaveDayKeys.has(day.getTime())) {
          throw new BadRequestException(`${day.toLocaleDateString()} isn't one of this leave's days.`);
        }
        picked.set(day.getTime(), day);
      }
      cancelDays = Array.from(picked.values()).sort((a, b) => a.getTime() - b.getTime());
    }

    // Approved leave self-cancellation is open for any day the employee
    // hasn't timed in on (and is permanently blocked once a prior
    // cancellation request was denied — see getCancellationEligibility).
    // HR/Admin cancellation remains an override for manual correction,
    // unaffected by either rule.
    if (existing.status === "APPROVED" && requestingEmployeeId) {
      const eligibility = this.getCancellationEligibility(existing, [], existing.notes);
      if (!eligibility.allowed) {
        throw new BadRequestException(eligibility.reason ?? "This request can no longer be cancelled.");
      }
      const worked = await this.prisma.attendanceRecord.findMany({
        where: {
          employeeId: existing.employeeId,
          timeInAt: { not: null },
          attendanceDate: { gte: toDateOnly(existing.startDate), lte: toDateOnly(existing.endDate) },
        },
        select: { attendanceDate: true },
      });
      const cancelKeys = new Set(cancelDays.map((day) => day.getTime()));
      const workedCancelDays = Array.from(
        new Set(
          worked
            .map((record) => toDateOnly(record.attendanceDate))
            .filter((day) => cancelKeys.has(day.getTime()))
            .map((day) => day.toLocaleDateString()),
        ),
      );
      if (workedCancelDays.length > 0) {
        throw new BadRequestException(
          `You already timed in on ${workedCancelDays.join(", ")}, so ${workedCancelDays.length === 1 ? "that day" : "those days"} can't be cancelled.`,
        );
      }
    }

    // An employee cancelling an already-APPROVED leave doesn't take effect
    // immediately — the leave was already granted (balance deducted,
    // schedule/coverage planned around it), so it sits at
    // CANCELLATION_PENDING until a Supervisor/Admin approves or denies the
    // cancellation. Cancelling a PENDING/SUPERVISOR_APPROVED request (nothing
    // committed yet) or an ADMIN override still takes effect immediately.
    const awaitDecision = existing.status === "APPROVED" && !!requestingEmployeeId;
    const targets =
      cancelDays.length < leaveDays.length
        ? await this.splitForCancellation(existing, cancelDays)
        : [{ id: existing.id, startDate: existing.startDate }];

    let result: unknown;
    for (const target of targets) {
      result = await this.cancelOne(target, existing.status, { awaitDecision, note: trimmedNote, noteAttachment, context });
    }
    return result;
  }

  // Cancels one request — the whole leave, or one cancelled piece of a
  // partial cancellation (see cancel()).
  private async cancelOne(
    target: { id: string; startDate: Date },
    previousStatus: string,
    opts: {
      awaitDecision: boolean;
      note: string;
      noteAttachment: { attachmentName?: string; attachmentMimeType?: string; attachmentData?: string };
      context: AuditLogContext;
    },
  ) {
    const { id } = target;
    const { note: trimmedNote, noteAttachment, context } = opts;
    if (opts.awaitDecision) {
      const request = await this.prisma.leaveRequest.update({
        where: { id },
        data: { status: "CANCELLATION_PENDING", preCancellationStatus: "APPROVED" },
        include: { employee: { include: { supervisor: { select: { userId: true } } } }, leaveType: true },
      });

      await this.prisma.leaveRequestNote.create({
        data: { leaveRequestId: id, type: "CANCELLED", message: trimmedNote, authorUserId: context.actorUserId, ...noteAttachment },
      });

      // Same recipient routing as a fresh submission (notifySubmission).
      const recipientIds = await this.notifications.filingReviewerIds(
        request.employee.userId,
        request.employee.supervisor?.userId,
      );

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
        oldValues: { status: previousStatus },
        newValues: { note: trimmedNote, status: "CANCELLATION_PENDING" },
      });

      return request;
    }

    // The leave period has already started (or passed) — the days were
    // already taken, so cancelling now must not hand the balance back.
    const alreadyUsed = previousStatus === "APPROVED" && toDateOnly(target.startDate) <= toDateOnly(new Date());

    const result = await this.updateStatus(id, "CANCELLED", undefined, context, undefined, undefined, {
      skipBalanceRestore: alreadyUsed,
    });

    await this.prisma.leaveRequestNote.create({
      data: {
        leaveRequestId: id,
        type: "CANCELLED",
        message: trimmedNote,
        authorUserId: context.actorUserId,
        ...noteAttachment,
      },
    });

    return result;
  }

  // Cancelling only some days of a multi-day request splits it into
  // contiguous pieces — runs of cancelled days and runs of days that stay —
  // so everything else (DTR, reports, balances, overlap checks) keeps reading
  // plain date ranges. The original request becomes the first piece; the
  // rest are new requests pointing back to it (splitFromId) whose timeline
  // inherits its history up to splitAt (see historyLineage). Every piece
  // keeps the original's status for now — cancelOne() then cancels the
  // cancelled pieces exactly like a whole request. Returns those pieces.
  private async splitForCancellation(
    existing: {
      id: string;
      employeeId: string;
      leaveTypeId: string;
      startDate: Date;
      endDate: Date;
      totalDays: unknown;
      reason: string;
      status: string;
      reviewedBy: string | null;
      reviewedAt: Date | null;
      createdAt: Date;
      attachmentPath: string | null;
      attachmentName: string | null;
      attachmentMimeType: string | null;
      attachmentData: string | null;
      extensionRequested: boolean;
      extensionApproved: boolean | null;
      reviewClockStartedAt: Date | null;
      extensionOfId: string | null;
    },
    cancelDays: Date[],
  ) {
    const cancelKeys = new Set(cancelDays.map((day) => day.getTime()));
    const days = calendarDays(existing.startDate, existing.endDate);
    const pieces: Array<{ start: Date; end: Date; cancel: boolean; dayCount: number }> = [];
    for (const day of days) {
      const cancel = cancelKeys.has(day.getTime());
      const last = pieces[pieces.length - 1];
      if (last && last.cancel === cancel) {
        last.end = day;
        last.dayCount += 1;
      } else {
        pieces.push({ start: day, end: day, cancel, dayCount: 1 });
      }
    }
    // The outer edges keep the request's own stored start/end values.
    pieces[0].start = existing.startDate;
    pieces[pieces.length - 1].end = existing.endDate;

    // Each piece's share of the request's days (normally one per calendar
    // day), to the half day.
    const daysPerCalendarDay = Number(existing.totalDays) / days.length;
    const pieceTotal = (piece: { dayCount: number }) => Math.round(piece.dayCount * daysPerCalendarDay * 2) / 2;

    const splitAt = new Date();
    const [first, ...rest] = pieces;
    const status = existing.status as LeaveRequestStatus;
    const results = await this.prisma.$transaction([
      this.prisma.leaveRequest.update({
        where: { id: existing.id },
        data: { startDate: first.start, endDate: first.end, totalDays: pieceTotal(first) },
        select: { id: true, startDate: true },
      }),
      ...rest.map((piece) =>
        this.prisma.leaveRequest.create({
          data: {
            employeeId: existing.employeeId,
            leaveTypeId: existing.leaveTypeId,
            startDate: piece.start,
            endDate: piece.end,
            totalDays: pieceTotal(piece),
            reason: existing.reason,
            status,
            reviewedBy: existing.reviewedBy,
            reviewedAt: existing.reviewedAt,
            createdAt: existing.createdAt,
            attachmentPath: existing.attachmentPath,
            attachmentName: existing.attachmentName,
            attachmentMimeType: existing.attachmentMimeType,
            attachmentData: existing.attachmentData,
            extensionRequested: existing.extensionRequested,
            extensionApproved: existing.extensionApproved,
            reviewClockStartedAt: existing.reviewClockStartedAt,
            extensionOfId: existing.extensionOfId,
            splitFromId: existing.id,
            splitAt,
          },
          select: { id: true, startDate: true },
        }),
      ),
    ]);

    return results.filter((_, index) => pieces[index].cancel);
  }

  // Approves an employee's pending request to cancel an already-APPROVED
  // leave — finalizes it to CANCELLED and restores the balance (unless the
  // leave period already started, same rule as an immediate cancel).
  async approveCancellation(
    id: string,
    context: AuditLogContext = {},
    scopeDepartmentId?: string,
    selfReviewEmployeeId?: string,
    // Optional note from the reviewer — sent to the employee and shown on
    // the request's timeline, same as denyCancellation's remarks.
    remarks?: string,
  ) {
    const trimmedRemarks = remarks?.trim() || undefined;
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
    // A Maternity Leave extension (without pay) never deducted anything.
    if (!alreadyUsed && !existing.extensionOfId) {
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
        message: `Your request to cancel ${request.leaveType.name} (${request.startDate.toLocaleDateString()} - ${request.endDate.toLocaleDateString()}) was approved. This leave is now cancelled.${trimmedRemarks ? ` Remarks: ${trimmedRemarks}` : ""}`,
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
      newValues: { status: "CANCELLED", remarks: trimmedRemarks },
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
    if (!remarks?.trim()) {
      throw new BadRequestException("Please provide remarks explaining why this cancellation is being denied.");
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

    // The update below overwrites attachment* with the new file, so the one
    // being replaced is about to be unrecoverable. Every later round after
    // this one is already safe — each resubmit leaves its own attachment
    // behind in a RESUBMITTED note below — but the very first round (the
    // original filed attachment) never got a note of its own. Archive it
    // here, once, the first time this request is ever resubmitted, so the
    // full document history (original + every resubmission) stays
    // reconstructable instead of silently losing round one.
    const priorResubmissionCount = await this.prisma.leaveRequestNote.count({
      where: { leaveRequestId: id, type: "RESUBMITTED" },
    });
    if (priorResubmissionCount === 0 && existing.attachmentName) {
      await this.prisma.leaveRequestNote.create({
        data: {
          leaveRequestId: id,
          type: "RESUBMITTED",
          // Backdated to when it was actually filed (not "now") so it sorts
          // before this round's own RESUBMITTED note below and reads as the
          // original submission rather than a second resubmission that just
          // happened to occur in the same instant.
          createdAt: existing.createdAt,
          attachmentName: existing.attachmentName,
          attachmentMimeType: existing.attachmentMimeType,
          attachmentData: existing.attachmentData,
        },
      });
    }

    const request = await this.prisma.leaveRequest.update({
      where: { id },
      data: {
        status: "PENDING",
        reviewedBy: null,
        reviewedAt: null,
        // The request is waiting on a reviewer again: restart the "still
        // awaiting a decision" reminder from now (see LeaveLapseService).
        reviewClockStartedAt: new Date(),
        overdueNotifiedAt: null,
        overdueNotifiedUserIds: [],
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
    const recipientIds = await this.notifications.filingReviewerIds(
      request.employee.userId,
      request.employee.supervisor?.userId,
    );

    const employeeName = `${request.employee.firstName} ${request.employee.lastName}`;

    await this.notifications.notifyUsers(recipientIds, {
      title: "Leave Request Resubmitted",
      message: `${employeeName} resubmitted their ${request.leaveType.name} request with the requested attachment.`,
      type: "LEAVE_RESUBMITTED",
      entityId: request.id,
    });
  }

  // The employee asks to extend an APPROVED Maternity Leave by 30 calendar
  // days without pay — at least 45 days before it ends, and once (see
  // getExtensionEligibility). Filed as its own request (extensionOfId) for
  // the 30 days right after the leave, so the normal Supervisor/Admin
  // approve/reject/cancel flow, the DTR, and the overlap checks all treat it
  // like any other leave; only the balance is never touched (updateStatus).
  async requestExtension(
    id: string,
    dto: RequestLeaveExtensionDto,
    context: AuditLogContext = {},
    requestingEmployeeId?: string,
  ) {
    const reason = dto.reason?.trim();
    if (!reason) {
      throw new BadRequestException("Please provide a reason for extending your leave.");
    }
    if (dto.attachmentData && Buffer.byteLength(dto.attachmentData, "base64") > MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException("Attachment must be 5MB or smaller.");
    }

    const existing = await this.prisma.leaveRequest.findUniqueOrThrow({
      where: { id },
      include: { leaveType: true },
    });
    if (requestingEmployeeId && existing.employeeId !== requestingEmployeeId) {
      throw new ForbiddenException("You can only extend your own leave.");
    }

    const extensions = await this.prisma.leaveRequest.findMany({
      where: { extensionOfId: id },
      select: { id: true, status: true, extensionOfId: true },
    });
    const eligibility = this.getExtensionEligibility(existing, extensions);
    if (!eligibility) {
      throw new BadRequestException("Only an approved Maternity Leave can be extended.");
    }
    if (!eligibility.allowed) {
      throw new BadRequestException(eligibility.reason);
    }

    const startDate = new Date(eligibility.startDate);
    const endDate = new Date(eligibility.endDate);
    await this.assertNoOverlap(existing.employeeId, startDate, endDate);

    const request = await this.prisma.leaveRequest.create({
      data: {
        employeeId: existing.employeeId,
        leaveTypeId: existing.leaveTypeId,
        startDate,
        endDate,
        totalDays: EXTENSION_DAYS,
        reason,
        attachmentName: dto.attachmentData ? dto.attachmentName : undefined,
        attachmentMimeType: dto.attachmentData ? dto.attachmentMimeType : undefined,
        attachmentData: dto.attachmentData || undefined,
        extensionOfId: id,
      },
      include: {
        employee: { include: { supervisor: true, department: true } },
        leaveType: true,
      },
    });

    const recipientIds = await this.notifications.filingReviewerIds(
      request.employee.userId,
      request.employee.supervisor?.userId,
    );
    const employeeName = `${request.employee.firstName} ${request.employee.lastName}`;
    await this.notifications.notifyUsers(recipientIds, {
      title: "Maternity Leave Extension Requested",
      message: `${employeeName} requested a ${EXTENSION_DAYS}-day extension of their ${request.leaveType.name}, without pay, for ${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}.`,
      type: "LEAVE_SUBMITTED",
      entityId: request.id,
    });

    await this.auditLogs.record({
      ...context,
      action: "CREATE_LEAVE_REQUEST",
      module: "Leave",
      entityType: "LeaveRequest",
      entityId: request.id,
      description: `${employeeName} requested a ${EXTENSION_DAYS}-day extension of their ${request.leaveType.name}.`,
      newValues: {
        employeeId: request.employeeId,
        leaveType: request.leaveType.name,
        extensionOfId: id,
        startDate: request.startDate,
        endDate: request.endDate,
        totalDays: request.totalDays,
        status: request.status,
      },
    });

    return request;
  }

  async setExtensionDecision(id: string, extensionApproved: boolean, remarks: string | undefined, actorUserId?: string) {
    const trimmedRemarks = remarks?.trim();
    if (!extensionApproved && !trimmedRemarks) {
      throw new BadRequestException("Please provide remarks explaining why this extension is being rejected.");
    }

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
        message: `Your request to extend your ${updated.leaveType.name} by 30 days without pay was ${extensionApproved ? "approved" : "rejected"}.${trimmedRemarks ? ` Remarks: ${trimmedRemarks}` : ""}`,
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
        newValues: { extensionApproved, remarks: trimmedRemarks },
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
