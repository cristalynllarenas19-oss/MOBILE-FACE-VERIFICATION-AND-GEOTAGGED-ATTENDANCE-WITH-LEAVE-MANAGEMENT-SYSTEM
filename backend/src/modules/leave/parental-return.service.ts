import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import {
  MATERNITY_ENDING_NOTICE_DAYS,
  MATERNITY_EXTENSION_DAYS,
  PARENTAL_RETURN_CATCH_UP_DAYS,
  PATERNITY_ENDING_NOTICE_DAYS,
  findReturnDay,
  lastParentalLeaveDay,
  parentalNoticeDue,
  toLocalMidnight,
} from "./parental-return.util";

export const PARENTAL_ENDING_NOTIFICATION_TYPE = "LEAVE_PARENTAL_ENDING";
export const PARENTAL_RETURN_NOTIFICATION_TYPE = "LEAVE_PARENTAL_RETURN";

// Maternity and Paternity leave, plus Added Paternity Leave — the days a
// mother transfers from her Maternity Leave to the father (RA 11210), which
// is a GENERAL-kind type told apart by isTransferable.
const PARENTAL_LEAVE_TYPE: Prisma.LeaveTypeWhereInput = {
  OR: [{ kind: { in: ["MATERNITY", "PATERNITY"] } }, { isTransferable: true }],
};

// Furthest back a still-relevant parental leave can have ended: the
// maternity extension, plus the catch-up window, plus slack for rest days
// and any leave taken straight after it.
const LOOKBACK_DAYS = MATERNITY_EXTENSION_DAYS + PARENTAL_RETURN_CATCH_UP_DAYS + 60;
// How far past a parental leave to look for other approved leave that
// pushes the return day back.
const FOLLOWING_LEAVE_DAYS = 120;

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function isParentalLeaveType(leaveType: { kind: string; isTransferable: boolean }) {
  return leaveType.kind === "MATERNITY" || leaveType.kind === "PATERNITY" || leaveType.isTransferable;
}

// Lets the employee's Supervisor and HR/Admin plan for a return from
// maternity or paternity leave: a heads-up near the end of the leave, then a
// notice on the day the employee is due back at work. Both go to the direct
// supervisor (when there is one) and every Admin, once each.
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
        leaveType: { select: { name: true, kind: true } },
      },
    });
    if (candidates.length === 0) return { sent: 0 };

    const adminIds = await this.notifications.adminUserIds();
    let sent = 0;

    for (const request of candidates) {
      const isMaternity = request.leaveType.kind === "MATERNITY";
      const lastLeaveDay = lastParentalLeaveDay(request.endDate, request.extensionApproved);
      const { returnDate, continuesAsParental } = await this.returnDayFor(request.employeeId, request.id, lastLeaveDay);
      if (continuesAsParental) continue;

      const notice = parentalNoticeDue({
        startDate: request.startDate,
        lastLeaveDay,
        returnDate,
        noticeDays: isMaternity ? MATERNITY_ENDING_NOTICE_DAYS : PATERNITY_ENDING_NOTICE_DAYS,
        now,
      });
      if (!notice) continue;

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
      const leaveName = request.leaveType.name;
      // Added Paternity Leave reads as paternity leave in the title.
      const category = isMaternity ? "Maternity" : "Paternity";
      const period = `${request.startDate.toLocaleDateString()} - ${request.endDate.toLocaleDateString()}`;
      const back = returnDate.toLocaleDateString();

      if (notice.kind === "ENDING") {
        const extensionNote = request.extensionApproved
          ? ` (including the approved ${MATERNITY_EXTENSION_DAYS}-day extension without pay)`
          : "";
        const pendingExtensionNote =
          request.extensionRequested && request.extensionApproved === null
            ? ` A request to extend it by ${MATERNITY_EXTENSION_DAYS} days without pay is still awaiting HR/Admin's decision.`
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
          message: notice.late
            ? `${name} was due back at work on ${back} after ${leaveName} (${period}).`
            : `${name} is due back at work today (${back}) after ${leaveName} (${period}).`,
          type,
          entityId: request.id,
        });
      }
      sent += outstanding.length;
    }

    if (sent > 0) this.logger.log(`Parental leave return check: ${sent} notification(s) sent.`);
    return { sent };
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
