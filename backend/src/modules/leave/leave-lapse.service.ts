import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AuditLogContext, AuditLogsService } from "../audit-logs/audit-logs.service";
import { decideLapse, lapseNotificationText, lapseTimelineText } from "./leave-lapse.util";
import { isOnShiftAt } from "../attendance/attendance-shift.util";

// A request in any of these is still waiting on someone: a reviewer, or (for
// NEEDS_REVISION) the employee to resubmit.
const UNDECIDED_STATUSES = ["PENDING", "SUPERVISOR_APPROVED", "NEEDS_REVISION"] as const;
// Only these are waiting on a reviewer — the ones a "decision overdue"
// reminder is worth sending for.
const AWAITING_REVIEW_STATUSES = ["PENDING", "SUPERVISOR_APPROVED"] as const;

function toLocalMidnight(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

// Keeps undecided leave requests from sitting pending forever:
// - when a request has gone undecided for the configured number of hours
//   after it was filed (per leave type, or the system default), each of its
//   reviewers is reminded once — during their own shift, so a reviewer who
//   is off duty when it comes due gets it when their next shift starts;
// - once its dates have passed, it lapses — immediately if the employee
//   worked those days anyway, otherwise after the configured grace period.
@Injectable()
export class LeaveLapseService {
  private readonly logger = new Logger(LeaveLapseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  // Every 10 minutes: every step is idempotent, a server that isn't up at
  // one fixed time of night would otherwise never run it, and a reminder
  // due "2 hours after filing" shouldn't wait for the top of the next hour.
  @Cron(CronExpression.EVERY_10_MINUTES)
  async runScheduled() {
    try {
      await this.process();
    } catch (error) {
      this.logger.error("Leave lapse processing failed", error instanceof Error ? error.stack : undefined);
    }
  }

  async getSettings() {
    return this.prisma.leaveSettings.upsert({
      where: { id: "singleton" },
      update: {},
      create: { id: "singleton" },
    });
  }

  async updateSettings(
    input: {
      lapseGraceDays?: number;
      reviewReminderHours?: number;
      resetMonth?: number;
      resetDay?: number;
    },
    context: AuditLogContext = {},
  ) {
    const existing = await this.getSettings();
    const lapseGraceDays = input.lapseGraceDays ?? existing.lapseGraceDays;
    const reviewReminderHours = input.reviewReminderHours ?? existing.reviewReminderHours;
    const resetMonth = input.resetMonth ?? existing.resetMonth;
    const resetDay = input.resetDay ?? existing.resetDay;
    if (!Number.isInteger(lapseGraceDays) || lapseGraceDays < 0 || lapseGraceDays > 365) {
      throw new BadRequestException("Grace period must be a whole number of days between 0 and 365.");
    }
    if (!Number.isInteger(reviewReminderHours) || reviewReminderHours < 1 || reviewReminderHours > 720) {
      throw new BadRequestException("Reminder time must be a whole number of hours between 1 and 720.");
    }
    // Checked against a non-leap year, so Feb 29 can't be picked as a reset
    // day that only exists every fourth year.
    const resetDate = new Date(2025, resetMonth - 1, resetDay);
    if (
      !Number.isInteger(resetMonth) ||
      !Number.isInteger(resetDay) ||
      resetMonth < 1 ||
      resetMonth > 12 ||
      resetDay < 1 ||
      resetDate.getMonth() !== resetMonth - 1 ||
      resetDate.getDate() !== resetDay
    ) {
      throw new BadRequestException("Leave reset date must be a valid month and day (Feb 29 is not allowed).");
    }
    const settings = await this.prisma.leaveSettings.update({
      where: { id: "singleton" },
      data: { lapseGraceDays, reviewReminderHours, resetMonth, resetDay, updatedBy: context.actorUserId },
    });
    await this.auditLogs.record({
      ...context,
      action: "UPDATE_LEAVE_SETTINGS",
      module: "Leave",
      entityType: "LeaveSettings",
      entityId: settings.id,
      description: `Updated leave settings: lapse grace period ${lapseGraceDays} day(s), review reminder after ${reviewReminderHours} hour(s), leave reset every ${resetDate.toLocaleDateString("en-US", { month: "long", day: "numeric" })}.`,
      oldValues: {
        lapseGraceDays: existing.lapseGraceDays,
        reviewReminderHours: existing.reviewReminderHours,
        resetMonth: existing.resetMonth,
        resetDay: existing.resetDay,
      },
      newValues: { lapseGraceDays, reviewReminderHours, resetMonth, resetDay },
    });
    return settings;
  }

  // Separated from the @Cron trigger so it can be run on demand.
  async process(now = new Date()) {
    const lapsed = await this.lapseUndecided(now);
    const reminded = await this.remindOverdue(now);
    if (lapsed > 0 || reminded > 0) {
      this.logger.log(`Leave lapse check: ${lapsed} lapsed, ${reminded} overdue reminder(s) sent.`);
    }
    return { lapsed, reminded };
  }

  private async lapseUndecided(now: Date): Promise<number> {
    const today = toLocalMidnight(now);
    const { lapseGraceDays } = await this.getSettings();

    const candidates = await this.prisma.leaveRequest.findMany({
      where: { status: { in: [...UNDECIDED_STATUSES] }, endDate: { lt: today } },
      include: {
        employee: { select: { userId: true, firstName: true, lastName: true } },
        leaveType: { select: { name: true } },
      },
    });

    let lapsed = 0;
    for (const request of candidates) {
      const attendance = await this.prisma.attendanceRecord.findMany({
        where: {
          employeeId: request.employeeId,
          timeInAt: { not: null },
          attendanceDate: { gte: toLocalMidnight(request.startDate), lte: toLocalMidnight(request.endDate) },
        },
        select: { attendanceDate: true },
      });
      const decision = decideLapse({
        startDate: request.startDate,
        endDate: request.endDate,
        now,
        graceDays: lapseGraceDays,
        attendedDates: attendance.map((record) => record.attendanceDate),
        filedAt: request.createdAt,
      });
      if (!decision.lapse) continue;

      // Guarded on the status it was read with, so a reviewer deciding the
      // request at the same moment always wins over the automatic lapse.
      const updated = await this.prisma.leaveRequest.updateMany({
        where: { id: request.id, status: request.status },
        data: { status: "LAPSED", lapseReason: decision.reason, reviewedAt: now, reviewedBy: null },
      });
      if (updated.count === 0) continue;
      lapsed += 1;

      const reasonText = lapseTimelineText(decision.reason, request.status);
      const dateRange = `${request.startDate.toLocaleDateString()} - ${request.endDate.toLocaleDateString()}`;

      await this.auditLogs.record({
        action: "LAPSE_LEAVE",
        module: "Leave",
        entityType: "LeaveRequest",
        entityId: request.id,
        description: `${request.employee.firstName} ${request.employee.lastName}'s ${request.leaveType.name} leave request lapsed.`,
        oldValues: { status: request.status },
        newValues: { status: "LAPSED", remarks: reasonText, reason: decision.reason },
      });

      if (request.employee.userId) {
        await this.notifications.notifyUsers([request.employee.userId], {
          title: "Leave Request Lapsed",
          message: `Your ${request.leaveType.name} request for ${dateRange} has lapsed because ${lapseNotificationText(decision.reason, request.status)}`,
          type: "LEAVE_LAPSED",
          entityId: request.id,
        });
      }
    }
    return lapsed;
  }

  // Reminds a request's reviewers once it has sat undecided for its leave
  // type's reminder time (or the system default) since it was filed — or
  // since it was last resubmitted, which restarts the wait. The clock runs
  // from that moment regardless of the hour, but each
  // reviewer only receives the reminder while on their own shift — one who
  // is off duty when it comes due gets it once their next shift starts.
  private async remindOverdue(now: Date): Promise<number> {
    const { reviewReminderHours: defaultHours } = await this.getSettings();

    const awaiting = await this.prisma.leaveRequest.findMany({
      where: { status: { in: [...AWAITING_REVIEW_STATUSES] }, overdueNotifiedAt: null },
      include: {
        employee: {
          select: { userId: true, firstName: true, lastName: true, supervisor: { select: { userId: true } } },
        },
        leaveType: { select: { name: true, reviewReminderHours: true } },
      },
    });
    const waitingSince = (request: { createdAt: Date; reviewClockStartedAt: Date | null }) =>
      request.reviewClockStartedAt ?? request.createdAt;
    const due = awaiting.filter((request) => {
      const hours = request.leaveType.reviewReminderHours ?? defaultHours;
      return now.getTime() >= waitingSince(request).getTime() + hours * 60 * 60000;
    });
    if (due.length === 0) return 0;

    const adminIds = await this.notifications.adminUserIds();
    const onDutyCache = new Map<string, boolean>();
    let reminded = 0;

    for (const request of due) {
      // Same people who got the original "New Leave Request" notification
      // (see LeaveService.notifySubmission): the employee's supervisor — or
      // HR/Admin when the filer is a supervisor themselves, or has no
      // supervisor to send it to.
      const filerIsSupervisor = await this.notifications.userHasRole(request.employee.userId, "SUPERVISOR");
      const supervisorId = request.employee.supervisor?.userId;
      const candidateIds = filerIsSupervisor || !supervisorId ? adminIds : [supervisorId];
      const recipientIds = Array.from(
        new Set(candidateIds.filter((id): id is string => Boolean(id) && id !== request.employee.userId)),
      );
      const outstanding = recipientIds.filter((id) => !request.overdueNotifiedUserIds.includes(id));

      const readyNow: string[] = [];
      for (const userId of outstanding) {
        if (!onDutyCache.has(userId)) onDutyCache.set(userId, await this.isReviewerOnDuty(userId, now));
        if (onDutyCache.get(userId)) readyNow.push(userId);
      }

      const notifiedUserIds = [...request.overdueNotifiedUserIds, ...readyNow];
      const everyoneReminded = recipientIds.every((id) => notifiedUserIds.includes(id));
      if (readyNow.length === 0 && !everyoneReminded) continue;

      // Guarded on the list it was read with, so two overlapping runs can't
      // both send the same reviewer the same reminder.
      const claimed = await this.prisma.leaveRequest.updateMany({
        where: { id: request.id, overdueNotifiedAt: null, overdueNotifiedUserIds: { equals: request.overdueNotifiedUserIds } },
        data: { overdueNotifiedUserIds: notifiedUserIds, ...(everyoneReminded ? { overdueNotifiedAt: now } : {}) },
      });
      if (claimed.count === 0 || readyNow.length === 0) continue;
      reminded += readyNow.length;

      const elapsedHours = Math.max(1, Math.floor((now.getTime() - waitingSince(request).getTime()) / (60 * 60000)));
      const verb = request.reviewClockStartedAt ? "resubmitted" : "filed";
      const waited =
        elapsedHours >= 24
          ? `${Math.floor(elapsedHours / 24)} day${elapsedHours >= 48 ? "s" : ""}`
          : `${elapsedHours} hour${elapsedHours === 1 ? "" : "s"}`;
      const dateRange = `${request.startDate.toLocaleDateString()} - ${request.endDate.toLocaleDateString()}`;
      await this.notifications.notifyUsers(readyNow, {
        title: "Reminder: Leave Request Pending",
        message: `Reminder: ${request.employee.firstName} ${request.employee.lastName} ${verb} a ${request.leaveType.name} request for ${dateRange} over ${waited} ago and it is still awaiting your decision.`,
        type: "LEAVE_DECISION_OVERDUE",
        entityId: request.id,
      });
    }
    return reminded;
  }

  // Whether a reviewer is on their shift right now. A reviewer with no
  // employee record or no schedule (e.g. an admin-only account) has no
  // shift to wait for, so they are always reachable.
  private async isReviewerOnDuty(userId: string, now: Date): Promise<boolean> {
    const employee = await this.prisma.employee.findFirst({ where: { userId }, select: { id: true } });
    if (!employee) return true;

    const schedule = await this.prisma.employeeSchedule.findFirst({
      where: {
        employeeId: employee.id,
        isActive: true,
        startsOn: { lte: now },
        OR: [{ endsOn: null }, { endsOn: { gte: now } }],
      },
      orderBy: { startsOn: "desc" },
      select: { workingDays: true, shift: { select: { startTime: true, endTime: true } } },
    });
    if (!schedule) return true;

    return isOnShiftAt(schedule.shift, schedule.workingDays, now);
  }
}
