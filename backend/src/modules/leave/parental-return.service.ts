import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { ACTIVE_EXTENSION_STATUSES } from "./leave.service";
import {
  MATERNITY_ENDING_NOTICE_DAYS,
  MATERNITY_EXTENSION_MAX_DAYS,
  MATERNITY_EXTENSION_NOTICE_DAYS,
  MATERNITY_EXTENSION_EARLY_REMINDER_DAYS,
  PARENTAL_RETURN_CATCH_UP_DAYS,
  PATERNITY_ENDING_NOTICE_DAYS,
  LONG_UNPAID_LEAVE_DAYS,
  employeeEndingNoticeDue,
  extensionReminderDue,
  findReturnDay,
  lastParentalLeaveDay,
  parentalNoticeDue,
  toLocalMidnight,
} from "./parental-return.util";

export const PARENTAL_ENDING_NOTIFICATION_TYPE = "LEAVE_PARENTAL_ENDING";
export const PARENTAL_RETURN_NOTIFICATION_TYPE = "LEAVE_PARENTAL_RETURN";
export const EXTENSION_REMINDER_NOTIFICATION_TYPE = "LEAVE_EXTENSION_REMINDER";
// The employee's own heads-up that their leave ends tomorrow.
export const EMPLOYEE_ENDING_NOTIFICATION_TYPE = "LEAVE_ENDING_REMINDER";
// The employee's own "you're back at work tomorrow / today" notices.
export const EMPLOYEE_RETURN_NOTIFICATION_TYPE = "LEAVE_RETURN_REMINDER";
// A long Leave Without Pay ending tomorrow: to the employee, and to their
// supervisor and every Admin (a reviewer type — supervisor/admin inbox).
export const LWOP_ENDING_NOTIFICATION_TYPE = "LEAVE_LWOP_ENDING";
export const LWOP_ENDING_TEAM_NOTIFICATION_TYPE = "LEAVE_LWOP_ENDING_TEAM";
// The employee's "welcome back" on the day they're due back after it.
export const LWOP_RETURN_NOTIFICATION_TYPE = "LEAVE_LWOP_RETURN";
// How far back a long LWOP can have ended and still be due its return-day
// notice — covers rest days between its last day and the return day.
const LWOP_RETURN_LOOKBACK_DAYS = 10;
// Matched by name, like the employee portal's leave-type icons — it's a
// GENERAL-kind type with no LeaveTypeKind of its own.
const LEAVE_WITHOUT_PAY_NAME = "Leave Without Pay";

// Maternity and Paternity leave, plus Added Paternity Leave — the days a
// mother transfers from her Maternity Leave to the father (RA 11210), which
// is a GENERAL-kind type told apart by isTransferable.
const PARENTAL_LEAVE_TYPE: Prisma.LeaveTypeWhereInput = {
  OR: [{ kind: { in: ["MATERNITY", "PATERNITY"] } }, { isTransferable: true }],
};

// Furthest back a still-relevant parental leave can have ended: the
// maternity extension, plus the catch-up window, plus slack for rest days
// and any leave taken straight after it.
const LOOKBACK_DAYS = MATERNITY_EXTENSION_MAX_DAYS + PARENTAL_RETURN_CATCH_UP_DAYS + 60;
// How far past a parental leave to look for other approved leave that
// pushes the return day back.
const FOLLOWING_LEAVE_DAYS = 120;

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

// The employee's pronouns for a notice written about them — from their
// recorded sex, or "they" when it isn't recorded.
function pronounsFor(sex: string | null) {
  if (sex === "MALE") return { he: "he", He: "He", his: "his", is: "is" };
  if (sex === "FEMALE") return { he: "she", He: "She", his: "her", is: "is" };
  return { he: "they", He: "They", his: "their", is: "are" };
}

// A Maternity Leave extension is filed under the Maternity type itself.
function parentalLeaveName(request: { extensionOfId: string | null; leaveType: { name: string } }) {
  return request.extensionOfId ? `${request.leaveType.name} extension` : request.leaveType.name;
}

function isParentalLeaveType(leaveType: { kind: string; isTransferable: boolean }) {
  return leaveType.kind === "MATERNITY" || leaveType.kind === "PATERNITY" || leaveType.isTransferable;
}

// Lets the employee's Supervisor and HR/Admin plan for a return from
// maternity or paternity leave: a heads-up near the end of the leave, then a
// notice the day before the employee is due back at work and another on the
// day itself. Those go to the direct supervisor (when there is one) and every
// Admin, once each. The employee is also told, the day before the leave's
// last day, that it ends tomorrow — and, like the reviewers, the day before
// they're due back at work and on the day itself.
@Injectable()
export class ParentalReturnService {
  private readonly logger = new Logger(ParentalReturnService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  // Hourly: every step is idempotent, and a day-level notice doesn't need
  // to land at a precise minute.
  @Cron(CronExpression.EVERY_HOUR)
  async runScheduled() {
    try {
      await this.process();
    } catch (error) {
      this.logger.error("Parental leave return check failed", error instanceof Error ? error.stack : undefined);
    }
    try {
      await this.remindExtensionDeadlines();
    } catch (error) {
      this.logger.error("Maternity extension reminder check failed", error instanceof Error ? error.stack : undefined);
    }
    try {
      await this.remindLongUnpaidLeaveEnding();
    } catch (error) {
      this.logger.error("Leave Without Pay ending check failed", error instanceof Error ? error.stack : undefined);
    }
  }

  // A Leave Without Pay of LONG_UNPAID_LEAVE_DAYS or more straight days: the
  // day before it ends (or on its last day, if that was missed), the
  // employee is told it ends tomorrow and that being absent after it means a
  // letter from their supervisor; the supervisor and every Admin get the same
  // in the third person. On the day the employee is due back, they get a
  // "welcome back" with the same reminder. Each recipient once per notice.
  async remindLongUnpaidLeaveEnding(now = new Date()) {
    const today = toLocalMidnight(now);
    const candidates = await this.prisma.leaveRequest.findMany({
      where: {
        status: "APPROVED",
        leaveType: { name: { equals: LEAVE_WITHOUT_PAY_NAME, mode: "insensitive" } },
        // Ending today/tomorrow, or ended a few days ago and due back today.
        endDate: { gte: addDays(today, -LWOP_RETURN_LOOKBACK_DAYS), lt: addDays(today, 2) },
        employee: { employmentStatus: { not: "SEPARATED" } },
      },
      include: {
        employee: {
          select: { userId: true, firstName: true, lastName: true, sex: true, supervisor: { select: { userId: true } } },
        },
        leaveType: { select: { name: true } },
      },
    });
    if (candidates.length === 0) return { sent: 0 };

    const adminIds = await this.notifications.adminUserIds();
    let sent = 0;
    for (const request of candidates) {
      const lastLeaveDay = toLocalMidnight(request.endDate);
      const straightDays = Math.round((lastLeaveDay.getTime() - toLocalMidnight(request.startDate).getTime()) / 86_400_000) + 1;
      if (straightDays < LONG_UNPAID_LEAVE_DAYS) continue;

      const { returnDate } = await this.returnDayFor(request.employeeId, request.id, lastLeaveDay);
      const period = `${request.startDate.toLocaleDateString()} - ${request.endDate.toLocaleDateString()}`;
      const leave = `${straightDays}-day ${request.leaveType.name}`;
      const end = request.endDate.toLocaleDateString();
      const back = returnDate.toLocaleDateString();

      // Due back today: the employee's "welcome back".
      if (toLocalMidnight(returnDate).getTime() === today.getTime()) {
        const already = await this.prisma.notification.findFirst({
          where: { type: LWOP_RETURN_NOTIFICATION_TYPE, entityId: request.id, userId: request.employee.userId, createdAt: { gte: today } },
          select: { id: true },
        });
        if (!already) {
          await this.notifications.notifyUsers([request.employee.userId], {
            title: "Welcome Back to Work",
            message:
              `Welcome back! Your ${leave} (${period}) has ended, and you're expected back at work today (${back}). ` +
              `If you are absent, you will receive a letter from your supervisor.`,
            type: LWOP_RETURN_NOTIFICATION_TYPE,
            entityId: request.id,
          });
          sent += 1;
        }
        continue;
      }

      const due = employeeEndingNoticeDue({ startDate: request.startDate, lastLeaveDay, now });
      if (!due) continue;
      const when = due.daysUntilEnd === 0 ? "today" : "tomorrow";

      const notified = await this.prisma.notification.findMany({
        where: {
          type: { in: [LWOP_ENDING_NOTIFICATION_TYPE, LWOP_ENDING_TEAM_NOTIFICATION_TYPE] },
          entityId: request.id,
          createdAt: { gte: due.windowStart },
        },
        select: { userId: true },
      });
      const notifiedIds = new Set(notified.map((notification) => notification.userId));

      const employeeUserId = request.employee.userId;
      if (!notifiedIds.has(employeeUserId)) {
        await this.notifications.notifyUsers([employeeUserId], {
          title: `Your Leave Without Pay Ends ${when === "today" ? "Today" : "Tomorrow"}`,
          message:
            `Your ${leave} (${period}) ends ${when} (${end}). You're expected back at work on ${back}. ` +
            `If you are absent after your Leave Without Pay ends, you will receive a letter from your supervisor.`,
          type: LWOP_ENDING_NOTIFICATION_TYPE,
          entityId: request.id,
        });
        sent += 1;
      }

      const reviewers = Array.from(
        new Set([request.employee.supervisor?.userId, ...adminIds].filter((id): id is string => Boolean(id) && id !== employeeUserId)),
      ).filter((id) => !notifiedIds.has(id));
      if (reviewers.length > 0) {
        const name = `${request.employee.firstName} ${request.employee.lastName}`;
        const { he, He, his, is } = pronounsFor(request.employee.sex);
        await this.notifications.notifyUsers(reviewers, {
          title: "Leave Without Pay Ending",
          message:
            `${name}'s ${leave} (${period}) ends ${when} (${end}). ${He} ${is} expected back at work on ${back}. ` +
            `If ${he} ${is} absent after ${his} Leave Without Pay ends, ${he} will receive a letter from ${his} supervisor.`,
          type: LWOP_ENDING_TEAM_NOTIFICATION_TYPE,
          entityId: request.id,
        });
        sent += reviewers.length;
      }
    }

    if (sent > 0) this.logger.log(`Leave Without Pay ending check: ${sent} notification(s) sent.`);
    return { sent };
  }

  // Reminds the employee herself, twice per Maternity Leave, that the
  // extension can only be requested up to MATERNITY_EXTENSION_NOTICE_DAYS
  // (45) before the leave ends — MATERNITY_EXTENSION_EARLY_REMINDER_DAYS
  // before that deadline, and again on the deadline itself — only while she
  // hasn't requested one yet.
  async remindExtensionDeadlines(now = new Date()) {
    const today = toLocalMidnight(now);
    // Leaves whose deadline (endDate − 45) falls within the reminder window;
    // extensionReminderDue makes the exact call per request.
    const candidates = await this.prisma.leaveRequest.findMany({
      where: {
        status: "APPROVED",
        extensionOfId: null,
        extensionRequested: false,
        // A type configured with no extension (0 days) has nothing to remind about.
        leaveType: { kind: "MATERNITY", extensionDays: { gt: 0 } },
        endDate: {
          gte: addDays(today, MATERNITY_EXTENSION_NOTICE_DAYS),
          lt: addDays(today, MATERNITY_EXTENSION_NOTICE_DAYS + MATERNITY_EXTENSION_EARLY_REMINDER_DAYS + 1),
        },
        employee: { employmentStatus: { not: "SEPARATED" } },
      },
      include: {
        employee: { select: { userId: true } },
        leaveType: { select: { name: true, extensionDays: true } },
      },
    });
    if (candidates.length === 0) return { sent: 0 };

    const ids = candidates.map((request) => request.id);
    const [extensions, alreadyNotified] = await Promise.all([
      this.prisma.leaveRequest.findMany({
        where: { extensionOfId: { in: ids }, status: { in: ACTIVE_EXTENSION_STATUSES } },
        select: { extensionOfId: true },
      }),
      this.prisma.notification.findMany({
        where: { type: EXTENSION_REMINDER_NOTIFICATION_TYPE, entityId: { in: ids } },
        select: { entityId: true, createdAt: true },
      }),
    ]);
    const skip = new Set(extensions.map((extension) => extension.extensionOfId));

    let sent = 0;
    for (const request of candidates) {
      const userId = request.employee.userId;
      if (!userId || skip.has(request.id)) continue;
      const due = extensionReminderDue({ endDate: request.endDate, now });
      if (!due) continue;
      // This reminder (early or final) already went out.
      if (alreadyNotified.some((n) => n.entityId === request.id && n.createdAt >= due.windowStart)) continue;

      const period = `${request.startDate.toLocaleDateString()} - ${request.endDate.toLocaleDateString()}`;
      const deadline = due.deadline.toLocaleDateString();
      await this.notifications.notifyUsers([userId], {
        title: due.daysLeft === 0 ? "Maternity Leave Extension Deadline" : "Maternity Leave Extension Reminder",
        message:
          due.daysLeft === 0
            ? `Your ${request.leaveType.name} (${period}) ends in ${MATERNITY_EXTENSION_NOTICE_DAYS} days, on ${request.endDate.toLocaleDateString()}. ` +
              `If you need the ${request.leaveType.extensionDays}-day extension, request it by today (${deadline}) — ` +
              `after that it can no longer be requested.`
            : `Your ${request.leaveType.name} (${period}) ends on ${request.endDate.toLocaleDateString()}. ` +
              `If you need the ${request.leaveType.extensionDays}-day extension, request it by ${deadline} ` +
              `(in ${due.daysLeft} day${due.daysLeft === 1 ? "" : "s"}) — at least ${MATERNITY_EXTENSION_NOTICE_DAYS} days before the leave ends.`,
        type: EXTENSION_REMINDER_NOTIFICATION_TYPE,
        entityId: request.id,
      });
      sent += 1;
    }

    if (sent > 0) this.logger.log(`Maternity extension reminder: ${sent} notification(s) sent.`);
    return { sent };
  }

  // Separated from the @Cron trigger so it can be run on demand.
  async process(now = new Date()) {
    const today = toLocalMidnight(now);
    const candidates = await this.prisma.leaveRequest.findMany({
      where: {
        status: "APPROVED",
        leaveType: PARENTAL_LEAVE_TYPE,
        startDate: { lt: addDays(today, 1) },
        endDate: { gte: addDays(today, -LOOKBACK_DAYS) },
        employee: { employmentStatus: { not: "SEPARATED" } },
      },
      include: {
        employee: {
          select: { id: true, userId: true, firstName: true, lastName: true, supervisor: { select: { userId: true } } },
        },
        leaveType: { select: { name: true, kind: true, extensionDays: true } },
      },
    });
    if (candidates.length === 0) return { sent: 0 };

    const adminIds = await this.notifications.adminUserIds();
    let sent = 0;

    for (const request of candidates) {
      const isMaternity = request.leaveType.kind === "MATERNITY";
      const lastLeaveDay = lastParentalLeaveDay(request.endDate, request.extensionApproved, request.leaveType.extensionDays);
      const { returnDate, continuesAsParental } = await this.returnDayFor(request.employeeId, request.id, lastLeaveDay);
      if (continuesAsParental) continue;

      const employeeNotice = employeeEndingNoticeDue({ startDate: request.startDate, lastLeaveDay, now });
      if (employeeNotice) {
        sent += await this.notifyEmployeeEnding(request, lastLeaveDay, returnDate, employeeNotice);
      }

      const notice = parentalNoticeDue({
        startDate: request.startDate,
        lastLeaveDay,
        returnDate,
        noticeDays: isMaternity ? MATERNITY_ENDING_NOTICE_DAYS : PATERNITY_ENDING_NOTICE_DAYS,
        now,
      });
      if (!notice) continue;

      // The employee's own return notices go out on the same two days as the
      // reviewers' (never as a late catch-up — by then they're back).
      if (notice.kind === "RETURN" && notice.daysUntilReturn >= 0) {
        sent += await this.notifyEmployeeReturn(request, returnDate, notice);
      }

      const type = notice.kind === "ENDING" ? PARENTAL_ENDING_NOTIFICATION_TYPE : PARENTAL_RETURN_NOTIFICATION_TYPE;
      const recipientIds = Array.from(
        new Set(
          [request.employee.supervisor?.userId, ...adminIds].filter(
            (id): id is string => Boolean(id) && id !== request.employee.userId,
          ),
        ),
      );
      const alreadyNotified = await this.prisma.notification.findMany({
        where: { type, entityId: request.id, userId: { in: recipientIds }, createdAt: { gte: notice.windowStart } },
        select: { userId: true },
      });
      const notifiedIds = new Set(alreadyNotified.map((notification) => notification.userId));
      const outstanding = recipientIds.filter((id) => !notifiedIds.has(id));
      if (outstanding.length === 0) continue;

      const name = `${request.employee.firstName} ${request.employee.lastName}`;
      const leaveName = parentalLeaveName(request);
      // Added Paternity Leave reads as paternity leave in the title.
      const category = isMaternity ? "Maternity" : "Paternity";
      const period = `${request.startDate.toLocaleDateString()} - ${request.endDate.toLocaleDateString()}`;
      const back = returnDate.toLocaleDateString();

      if (notice.kind === "ENDING") {
        const extensionNote = request.extensionApproved
          ? ` (including the approved ${request.leaveType.extensionDays}-day extension without pay)`
          : "";
        const pendingExtensionNote =
          request.extensionRequested && request.extensionApproved === null
            ? ` A request to extend it by ${request.leaveType.extensionDays} days without pay is still awaiting HR/Admin's decision.`
            : "";
        await this.notifications.notifyUsers(outstanding, {
          title: `${category} Leave Ending Soon`,
          message: `${name}'s ${leaveName} (${period}) ends on ${lastLeaveDay.toLocaleDateString()}${extensionNote}. ${name} is expected back at work on ${back}.${pendingExtensionNote}`,
          type,
          entityId: request.id,
        });
      } else {
        await this.notifications.notifyUsers(outstanding, {
          title: `Returning from ${category} Leave`,
          message:
            notice.daysUntilReturn < 0
              ? `${name} was due back at work on ${back} after ${leaveName} (${period}).`
              : `${name} is due back at work ${
                  notice.daysUntilReturn === 0 ? "today" : notice.daysUntilReturn === 1 ? "tomorrow" : "on"
                } (${back}) after ${leaveName} (${period}).`,
          type,
          entityId: request.id,
        });
      }
      sent += outstanding.length;
    }

    if (sent > 0) this.logger.log(`Parental leave return check: ${sent} notification(s) sent.`);
    return { sent };
  }

  // "You're back at work tomorrow / today" to the employee, once each.
  private async notifyEmployeeReturn(
    request: {
      id: string;
      startDate: Date;
      endDate: Date;
      extensionOfId: string | null;
      employee: { userId: string };
      leaveType: { name: string; kind: string };
    },
    returnDate: Date,
    notice: { windowStart: Date; daysUntilReturn: number },
  ) {
    const userId = request.employee.userId;
    const already = await this.prisma.notification.findFirst({
      where: { type: EMPLOYEE_RETURN_NOTIFICATION_TYPE, entityId: request.id, userId, createdAt: { gte: notice.windowStart } },
      select: { id: true },
    });
    if (already) return 0;

    const back = returnDate.toLocaleDateString();
    const period = `${request.startDate.toLocaleDateString()} - ${request.endDate.toLocaleDateString()}`;
    const leaveName = parentalLeaveName(request);
    const today = notice.daysUntilReturn === 0;
    await this.notifications.notifyUsers([userId], {
      title: today ? "Welcome Back to Work" : "Back to Work Tomorrow",
      message: today
        ? `Welcome back! You're expected back at work today (${back}) after your ${leaveName} (${period}).`
        : `Your ${leaveName} (${period}) has ended. You're expected back at work tomorrow (${back}).`,
      type: EMPLOYEE_RETURN_NOTIFICATION_TYPE,
      entityId: request.id,
    });
    return 1;
  }

  // "Your leave ends tomorrow" to the employee, once per leave.
  private async notifyEmployeeEnding(
    request: {
      id: string;
      startDate: Date;
      endDate: Date;
      extensionOfId: string | null;
      employee: { userId: string };
      leaveType: { name: string; kind: string };
    },
    lastLeaveDay: Date,
    returnDate: Date,
    notice: { windowStart: Date; daysUntilEnd: number },
  ) {
    const userId = request.employee.userId;
    const already = await this.prisma.notification.findFirst({
      where: { type: EMPLOYEE_ENDING_NOTIFICATION_TYPE, entityId: request.id, userId, createdAt: { gte: notice.windowStart } },
      select: { id: true },
    });
    if (already) return 0;

    const when = notice.daysUntilEnd === 0 ? "today" : "tomorrow";
    const category = request.leaveType.kind === "MATERNITY" ? "Maternity" : "Paternity";
    const period = `${request.startDate.toLocaleDateString()} - ${request.endDate.toLocaleDateString()}`;
    await this.notifications.notifyUsers([userId], {
      title: `Your ${category} Leave Ends ${when === "today" ? "Today" : "Tomorrow"}`,
      message:
        `Your ${parentalLeaveName(request)} (${period}) ends ${when} (${lastLeaveDay.toLocaleDateString()}). ` +
        `You're expected back at work on ${returnDate.toLocaleDateString()}.`,
      type: EMPLOYEE_ENDING_NOTIFICATION_TYPE,
      entityId: request.id,
    });
    return 1;
  }

  // The employee's first working day after the leave, skipping rest days on
  // their schedule and any other approved leave that follows straight on.
  private async returnDayFor(employeeId: string, requestId: string, lastLeaveDay: Date) {
    const searchEnd = addDays(lastLeaveDay, FOLLOWING_LEAVE_DAYS);
    const [schedules, followingLeaves] = await Promise.all([
      this.prisma.employeeSchedule.findMany({
        where: { employeeId, isActive: true, startsOn: { lte: searchEnd }, OR: [{ endsOn: null }, { endsOn: { gt: lastLeaveDay } }] },
        orderBy: { startsOn: "desc" },
        select: { startsOn: true, endsOn: true, workingDays: true },
      }),
      this.prisma.leaveRequest.findMany({
        where: {
          employeeId,
          id: { not: requestId },
          status: { in: ["APPROVED", "CANCELLATION_PENDING"] },
          startDate: { lte: searchEnd },
          endDate: { gt: lastLeaveDay },
        },
        select: { startDate: true, endDate: true, leaveType: { select: { kind: true, isTransferable: true } } },
      }),
    ]);

    // Same "latest assignment in effect that day" rule as the shift lookup
    // in LeaveLapseService.isReviewerOnDuty.
    const workingDaysOn = (date: Date) =>
      schedules.find(
        (schedule) =>
          toLocalMidnight(schedule.startsOn).getTime() <= date.getTime() &&
          (!schedule.endsOn || toLocalMidnight(schedule.endsOn).getTime() >= date.getTime()),
      )?.workingDays;

    return findReturnDay(
      lastLeaveDay,
      workingDaysOn,
      followingLeaves.map((leave) => ({
        startDate: leave.startDate,
        endDate: leave.endDate,
        isParental: isParentalLeaveType(leave.leaveType),
      })),
    );
  }
}
