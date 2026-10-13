import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { AttendanceRecord } from "@prisma/client";
import { randomUUID } from "crypto";
import { PrismaService, withPrismaRetry } from "../../prisma/prisma.service";
import { FaceVerificationService } from "../face-verification/face-verification.service";
import { GeolocationService } from "../geolocation/geolocation.service";
import { AuditLogContext, AuditLogsService } from "../audit-logs/audit-logs.service";
import { NotificationsService } from "../notifications/notifications.service";
import { SubmitAttendanceDto } from "./dto/submit-attendance.dto";
import {
  canContinueOvernightRecord,
  computeAbsenceCutoff,
  computeBreakMinutes,
  computeExpectedTimeOut,
  computeMinutesLate,
  computeMinutesOvertime,
  computeMinutesUndertime,
  computeRenderTimeIn,
  findBestMatchingShift,
  isInsidePreviousDayShift,
  resolveBreakKind,
  roundToInterval,
} from "./attendance-shift.util";
import { getApprovedLeaveByEmployee } from "../../common/utils/on-leave.util";
import { resolveMissedDays } from "./attendance-missed-days.util";
import { isDayOff, isNonWorkingDay } from "../../common/utils/schedule.util";

// How far back the employee's own DTR rebuilds absent/on-leave days when
// their real records don't already reach that far.
const HISTORY_MISSED_DAYS_WINDOW = 30;

type AttendanceFilters = {
  department?: string;
  departmentId?: string;
  status?: string;
  recordType?: string;
  date?: string;
  from?: string;
  to?: string;
};

// Parses a "YYYY-MM-DD" query param into a local-midnight Date, matching how
// attendanceDate is written in submit() (new Date(year, month, day)). Using
// `new Date(string)` instead would parse as UTC midnight and, on any server
// not running in the UTC timezone, shift the day boundary and silently
// exclude that day's records.
function parseLocalDate(value: string | undefined, endOfDay = false): Date | undefined {
  const match = value ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!match) return undefined;
  const [, year, month, day] = match;
  return endOfDay
    ? new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 59, 999)
    : new Date(Number(year), Number(month) - 1, Number(day));
}

// A same-day streak of borderline ("PENDING_REVIEW") flagged attempts
// reaching this many notifies the employee's supervisor. Every flagged
// attempt is still written to the admin/supervisor review queue
// immediately regardless of the count — this only delays the notification,
// so an isolated bad-lighting/angle misfire doesn't page a supervisor over
// a single attempt, while a real, repeated buddy-punching attempt still
// gets surfaced quickly. Mirrors FaceVerificationService's
// MISMATCH_NOTIFY_THRESHOLD for the confident-mismatch path.
const FLAGGED_NOTIFY_THRESHOLD = 3;

// Role codes only, alongside an attendance row's employee — the attendance
// viewers show a Supervisor/Admin's highest role in place of their position
// title, since they log attendance like any other employee.
const EMPLOYEE_ROLE_CODES_SELECT = { userRoles: { select: { role: { select: { code: true } } } } } as const;

const FLAGGED_LOG_TYPE_LABEL: Record<string, string> = {
  TIME_IN: "time in",
  TIME_OUT: "time out",
  LUNCH_OUT: "break start",
  LUNCH_IN: "break end",
};

// TEMPORARY, for trial runs: employees whose flagged-attempt card and
// notifications always say "supervisor", even though the normal rule would
// say "HR/Admin" for them (EMP-1010, Sheena Emperador, is a supervisor with
// no supervisor of her own). Wording only — who actually gets notified and
// reviews is unchanged. Empty this list once the trial is over.
const TRIAL_SUPERVISOR_WORDING_EMPLOYEE_IDS = ["EMP-1010"];

// One wording for the flagged-attempt hold, used by both the employee's
// "Attendance Disabled" notification and the attendance screen's red card.
function buildFlagHoldMessage(logType: string, reviewerLabel: string) {
  const label = FLAGGED_LOG_TYPE_LABEL[logType] ?? "attendance";
  return `Repeated unauthorized ${label} attempts were detected on your account and your ${reviewerLabel} has been notified. Attendance is disabled until they review it.`;
}

// One wording for a same-day rejected flagged attempt, used by both the
// employee's "Attendance Rejected" notification and the attendance screen's
// card that follows it.
function buildFlagRejectedMessage(logType: string, reviewerLabel: string) {
  const label = FLAGGED_LOG_TYPE_LABEL[logType] ?? "attendance";
  return `Your flagged ${label} attempt was reviewed and rejected. Attendance is enabled again. Log your attendance now to record your ${label} for today, and report to your ${reviewerLabel} immediately.`;
}

// Longest from/to range findAll() rebuilds Absent/On-Leave rows for, one day
// at a time. Those rows are never stored, so each day costs its own leave
// and schedule lookups.
const MAX_RECONSTRUCTED_DAYS = 31;
// How far back the unfiltered list rebuilds them.
const DEFAULT_RECONSTRUCTED_DAYS = 14;
// Row cap on real records per findAll() call.
const MAX_LISTED_RECORDS = 100;

@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly geolocation: GeolocationService,
    private readonly faceVerification: FaceVerificationService,
    private readonly auditLogs: AuditLogsService,
    private readonly notifications: NotificationsService,
  ) {}

  async findAll(filters: AttendanceFilters = {}) {
    const attendanceDate = parseLocalDate(filters.date);
    const fromDate = parseLocalDate(filters.from);
    const toDate = parseLocalDate(filters.to, true);

    const records = await this.prisma.attendanceRecord.findMany({
      where: {
        ...(filters.status && filters.status !== "ALL" ? { status: filters.status as any } : {}),
        ...(filters.recordType && filters.recordType !== "ALL" ? { recordType: filters.recordType as any } : {}),
        ...(attendanceDate
          ? { attendanceDate }
          : fromDate || toDate
            ? {
                attendanceDate: {
                  ...(fromDate ? { gte: fromDate } : {}),
                  ...(toDate ? { lte: toDate } : {}),
                },
              }
            : {}),
        ...(filters.departmentId
          ? { employee: { departmentId: filters.departmentId } }
          : filters.department && filters.department !== "ALL"
            ? { employee: { department: { name: filters.department } } }
            : {}),
      },
      include: {
        employee: { include: { department: true, position: { select: { title: true } }, user: { select: EMPLOYEE_ROLE_CODES_SELECT }, faceProfiles: { orderBy: { enrolledAt: "desc" }, take: 1 } } },
        workLocation: { select: { name: true } },
        logs: { orderBy: { capturedAt: "desc" } },
        shift: { select: { startTime: true, endTime: true, lateThresholdMinutes: true, lunchBreakMinutes: true, breakStartTime: true, breakKind: true } },
      },
      orderBy: [{ attendanceDate: "desc" }, { visitNumber: "asc" }],
      take: MAX_LISTED_RECORDS,
    });

    const remarks = await this.prisma.auditLog.findMany({
      where: { entityType: "AttendanceRecord", entityId: { in: records.map((record) => record.id) } },
      orderBy: { createdAt: "desc" },
    });

    const withRemarks = records.map(({ shift, ...record }) => ({
      ...record,
      breakKind: resolveBreakKind(shift),
      adminRemarks: remarks.find((remark) => remark.entityId === record.id)?.newValues,
    }));

    // A specific single day — `date`, `from`/`to` narrowed to the same
    // calendar day (e.g. landing here from the Dashboard's "View in
    // Attendance" button), or only one of `from`/`to` set (the admin filters
    // the Attendance Management list by a single date using just one of the
    // two date inputs) — is the only case where Absent/On-Leave employees
    // can be reconstructed from one date: neither ever gets a real
    // AttendanceRecord row, so without this they'd be invisible here even
    // though the Dashboard already counts them.
    const singleDay =
      attendanceDate ??
      (fromDate && toDate
        ? (fromDate.toDateString() === toDate.toDateString() ? fromDate : undefined)
        : (fromDate ?? toDate));

    // When the admin applies no date filter at all (the default Attendance
    // Management view), the last DEFAULT_RECONSTRUCTED_DAYS days up to today
    // are reconstructed, so recent no-shows are listed without having to
    // pick a date first. A genuine multi-day range is reconstructed day by day,
    // up to MAX_RECONSTRUCTED_DAYS and never past today; a longer range
    // returns real records only.
    const hasDateFilter = Boolean(filters.date || filters.from || filters.to);
    const today = new Date();
    const todayLocalMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const toLocalMidnight = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate());

    const syntheticDays: Date[] = [];
    if (singleDay) {
      syntheticDays.push(toLocalMidnight(singleDay));
    } else if (!hasDateFilter) {
      // If the real-record cap was hit, days older than the oldest returned
      // record would list only their absentees, so they're left out.
      const oldestLoaded =
        records.length === MAX_LISTED_RECORDS ? toLocalMidnight(records[records.length - 1].attendanceDate) : undefined;
      for (let offset = DEFAULT_RECONSTRUCTED_DAYS - 1; offset >= 0; offset -= 1) {
        const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
        if (!oldestLoaded || day >= oldestLoaded) syntheticDays.push(day);
      }
    } else if (fromDate && toDate) {
      const lastDay = toDate < todayLocalMidnight ? toLocalMidnight(toDate) : todayLocalMidnight;
      for (
        let day = toLocalMidnight(fromDate);
        day <= lastDay;
        day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
      ) {
        syntheticDays.push(day);
      }
      if (syntheticDays.length > MAX_RECONSTRUCTED_DAYS) syntheticDays.length = 0;
    }
    if (syntheticDays.length === 0) return withRemarks;

    const employees = await this.prisma.employee.findMany({
      where: {
        employmentStatus: { not: "SEPARATED" },
        ...(filters.departmentId
          ? { departmentId: filters.departmentId }
          : filters.department && filters.department !== "ALL"
            ? { department: { name: filters.department } }
            : {}),
      },
      select: {
        id: true,
        employeeNo: true,
        firstName: true,
        lastName: true,
        hireDate: true,
        department: { select: { name: true } },
        position: { select: { title: true } },
        user: { select: EMPLOYEE_ROLE_CODES_SELECT },
      },
    });
    const employeeIds = employees.map((e) => e.id);

    // Who really has a record on each reconstructed day. Queried on its own
    // (ids + dates only, no status/type filter, no row cap) rather than read
    // off withRemarks — that list is capped and filtered, so relying on it
    // would mark someone Absent on a day they actually timed in.
    const recordedRows = await this.prisma.attendanceRecord.findMany({
      where: {
        employeeId: { in: employeeIds },
        attendanceDate: {
          gte: syntheticDays[0],
          lte: new Date(syntheticDays[syntheticDays.length - 1].getTime() + 24 * 60 * 60000 - 1),
        },
      },
      select: { employeeId: true, attendanceDate: true },
    });
    const recordedKeys = new Set(
      recordedRows.map((record) => `${record.employeeId}::${record.attendanceDate.toDateString()}`),
    );

    const now = new Date();
    const wantsStatus = (status: "ABSENT" | "ON_LEAVE") => !filters.status || filters.status === "ALL" || filters.status === status;
    // Synthetic Absent/On-Leave rows always carry recordType OFFICE (no real
    // visit happened), so a FIELD-only filter should exclude them entirely.
    const wantsSyntheticRecordType = !filters.recordType || filters.recordType === "ALL" || filters.recordType === "OFFICE";

    const syntheticRows = [];
    for (const syntheticDay of wantsSyntheticRecordType ? syntheticDays : []) {
      const onLeaveByEmployee = await getApprovedLeaveByEmployee(this.prisma, employeeIds, syntheticDay);

      // Whichever schedule was actually active for each employee ON
      // syntheticDay (not "today", unless that's what syntheticDay is) — same
      // rule the Dashboard uses, but resolved per the specific day being
      // reconstructed so browsing a past date stays historically accurate even
      // if the employee's shift has since changed.
      const schedulesOnDay = await this.prisma.employeeSchedule.findMany({
        where: {
          employeeId: { in: employeeIds },
          startsOn: { lte: syntheticDay },
          OR: [{ endsOn: null }, { endsOn: { gte: syntheticDay } }],
        },
        orderBy: { startsOn: "desc" },
        select: {
          employeeId: true,
          workingDays: true,
          shift: { select: { startTime: true, endTime: true, lateThresholdMinutes: true } },
        },
      });
      const scheduleByEmployee = new Map<
        string,
        { workingDays: number[]; shift: { startTime: string; endTime: string; lateThresholdMinutes: number } }
      >();
      for (const schedule of schedulesOnDay) {
        if (!scheduleByEmployee.has(schedule.employeeId)) {
          scheduleByEmployee.set(schedule.employeeId, schedule);
        }
      }
      // An employee with no schedule active on that day has nothing to
      // compare arrival against, so they're never no-show-absent — same rule
      // the Dashboard uses. For a past syntheticDay the cutoff has necessarily
      // already elapsed; for today it may not have (both fall out of this
      // comparison naturally since it's anchored to syntheticDay).
      const isPastAbsenceCutoff = (employeeId: string) => {
        const schedule = scheduleByEmployee.get(employeeId);
        if (!schedule) return false;
        return now >= computeAbsenceCutoff(schedule.shift, syntheticDay);
      };
      const isWorkingDay = (employeeId: string) => {
        const schedule = scheduleByEmployee.get(employeeId);
        if (!schedule) return true;
        return schedule.workingDays.includes(syntheticDay.getDay());
      };

      const dayKey = `${syntheticDay.getFullYear()}-${String(syntheticDay.getMonth() + 1).padStart(2, "0")}-${String(syntheticDay.getDate()).padStart(2, "0")}`;

      for (const employee of employees) {
        if (recordedKeys.has(`${employee.id}::${syntheticDay.toDateString()}`)) continue;
        const onLeave = onLeaveByEmployee.get(employee.id);
        const base = {
          id: `${onLeave ? "leave" : "absent"}-${employee.id}-${dayKey}`,
          attendanceDate: syntheticDay,
          recordType: "OFFICE" as const,
          visitNumber: 1,
          workLocationId: null,
          workLocation: null,
          timeInAt: null,
          timeOutAt: null,
          lunchOutAt: null,
          lunchInAt: null,
          totalMinutes: 0,
          lateMinutes: 0,
          undertimeMinutes: 0,
          shiftId: null,
          employeeId: employee.id,
          employee: {
            employeeNo: employee.employeeNo,
            firstName: employee.firstName,
            lastName: employee.lastName,
            department: employee.department,
            position: employee.position,
            user: employee.user,
            faceProfiles: [],
          },
          logs: [],
          adminRemarks: undefined,
          isSynthetic: true,
        };

        if (onLeave && wantsStatus("ON_LEAVE")) {
          syntheticRows.push({ ...base, status: "ON_LEAVE" as const, leaveTypeName: onLeave.leaveTypeName });
        } else if (
          !onLeave &&
          !isDayOff(syntheticDay) &&
          employee.hireDate <= syntheticDay &&
          wantsStatus("ABSENT") &&
          isPastAbsenceCutoff(employee.id) &&
          isWorkingDay(employee.id)
        ) {
          syntheticRows.push({ ...base, status: "ABSENT" as const });
        }
      }
    }

    // Final newest-first sort across real + synthetic rows together — a
    // stable sort, so same-date ties keep their existing relative order
    // (Prisma's attendanceDate desc/visitNumber asc for real rows; synthetic
    // rows trailing after real rows on the same date).
    return [...withRemarks, ...syntheticRows].sort(
      (a, b) => b.attendanceDate.getTime() - a.attendanceDate.getTime(),
    );
  }

  async updateStatus(
    id: string,
    status: "PRESENT",
    remarks?: string,
    context: AuditLogContext = {},
    scopeDepartmentId?: string,
  ) {
    const before = await this.prisma.attendanceRecord.findUniqueOrThrow({
      where: { id },
      select: { status: true, employee: { select: { departmentId: true } } },
    });

    if (scopeDepartmentId && before.employee.departmentId !== scopeDepartmentId) {
      throw new ForbiddenException("You can only manage attendance records from your own department.");
    }

    const record = await this.prisma.attendanceRecord.update({
      where: { id },
      data: { status },
      include: {
        employee: { include: { department: true, faceProfiles: { orderBy: { enrolledAt: "desc" }, take: 1 } } },
        logs: { orderBy: { capturedAt: "desc" } },
      },
    });

    await this.auditLogs.record({
      ...context,
      action: "CORRECT_ATTENDANCE",
      module: "Attendance",
      entityType: "AttendanceRecord",
      entityId: id,
      description: `Updated attendance status for ${record.employee.firstName} ${record.employee.lastName} to ${status}.`,
      oldValues: { status: before.status },
      newValues: { remarks: remarks?.trim(), status },
    });

    return {
      ...record,
      adminRemarks: remarks?.trim() ? { remarks: remarks.trim(), status } : undefined,
    };
  }

  async getTodayAttendance(
  employeeId: string,
) {
  const now = new Date();

  // The working day this moment belongs to — the previous calendar day
  // while an overnight shift that started then is still running. FIELD
  // visits have no shift to span midnight, so they always use today.
  const employee = await this.prisma.employee.findUnique({
    where: { id: employeeId },
    select: { attendanceMode: true },
  });
  const attendanceDate =
    employee?.attendanceMode === "FIELD"
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate())
      : await this.resolveOfficeAttendanceDate(employeeId, now);

  // findFirst ordered by timeInAt desc, rather than findUnique on
  // visitNumber 1, so a FIELD employee's most recent visit today is
  // returned regardless of its recordType — visitNumber alone isn't a
  // reliable recency signal since it's now scoped per recordType, and an
  // office visit and a field visit on the same day can both be visitNumber 1.
  // For FIXED employees (always a single OFFICE record) this returns the
  // exact same single row findUnique would have.
  const record = await this.prisma.attendanceRecord.findFirst({
    where: { employeeId, attendanceDate },
    orderBy: { timeInAt: "desc" },
  });

  const flagHoldMessage = await this.getFlaggedAttemptHoldMessage(employeeId, attendanceDate);
  const flagRejectedMessage = flagHoldMessage
    ? null
    : await this.getFlagRejectedMessage(employeeId, attendanceDate);

  // Set when this working day is covered by an approved leave and nothing
  // has been timed in — the client locks its buttons instead of letting the
  // employee scan first and be refused after (see submit()).
  const approvedLeave = record?.timeInAt
    ? undefined
    : (await getApprovedLeaveByEmployee(this.prisma, [employeeId], attendanceDate)).get(employeeId);

  // The effective start time (rounded to shift rules where applicable) drives
  // the "expected time out" shown to the employee, same as it drives
  // totalMinutes math in upsertAttendanceRecord. The resolved shift's own
  // span (not a flat assumption) decides how far past that start the
  // expected time-out falls — see computeExpectedTimeOut.
  const effectiveStart = record?.renderTimeInAt ?? record?.timeInAt ?? null;
  const resolvedShift = record?.shiftId
    ? await this.prisma.shift.findUnique({ where: { id: record.shiftId } })
    : null;
  // Before Time In there's no record to carry a shift yet, so fall back to
  // whichever shift is currently assigned.
  const breakShift = resolvedShift ?? (record ? null : await this.resolveActiveShift(employeeId, now));

  return {
    ...(record ?? {
      attendanceDate,
      status: isDayOff(attendanceDate) ? "DAY_OFF" : "ABSENT",
      timeInAt: null,
      timeOutAt: null,
      lunchOutAt: null,
      lunchInAt: null,
    }),
    expectedTimeOutAt: effectiveStart ? computeExpectedTimeOut(effectiveStart, resolvedShift ?? undefined) : null,
    breakKind: resolveBreakKind(breakShift),
    onLeave: approvedLeave ? { leaveTypeName: approvedLeave.leaveTypeName } : null,
    hasUnresolvedFlaggedAttempt: flagHoldMessage !== null,
    flagHoldMessage,
    flagRejectedMessage,
  };
}

  // Whether this employee's attendance buttons should still be locked, once
  // their same-day flagged-attempt count has already reached
  // FLAGGED_NOTIFY_THRESHOLD. The mobile client uses this to warn on the
  // next tap of ANY attendance button (Time In, Time Out, Lunch Out/In —
  // whichever is currently applicable) that an unauthorized attempt was
  // detected on the account, rather than opening the camera straight away.
  // Deliberately account-wide rather than scoped to the specific logType
  // that was flagged: a Time Out attempt failing to match the enrolled face
  // is just as much a reason to double-check the next Time In as it is the
  // next Time Out.
  //
  // Only a supervisor/admin review lifts the hold — the employee can't clear
  // it themselves with another scan. It holds while the *most recent*
  // flagged attempt is still newer than the *most recent* review of any of
  // that day's attempts (validate, reject or archive), so one decision frees
  // the account without the reviewer having to work through every queued
  // attempt first, and a fresh flag after that review holds it again.
  //
  // Returns the employee-facing explanation while the hold is active (the
  // same text as the "Attendance Disabled" notification, shown on the
  // attendance screen's red card), or null when attendance is allowed.
  private async getFlaggedAttemptHoldMessage(employeeId: string, attendanceDate: Date): Promise<string | null> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { userId: true, supervisorId: true, flaggedAttemptCount: true, flaggedAttemptCountDate: true },
    });
    if (!employee) return null;

    const isSameDay = employee.flaggedAttemptCountDate?.getTime() === attendanceDate.getTime();
    if (!isSameDay || employee.flaggedAttemptCount < FLAGGED_NOTIFY_THRESHOLD) return null;

    const latestUnresolvedFlag = await this.prisma.attendanceLog.findFirst({
      where: { employeeId, attendanceDate, verificationStatus: "PENDING_REVIEW", attendanceRecordId: null },
      orderBy: { capturedAt: "desc" },
      select: { capturedAt: true, logType: true },
    });
    if (!latestUnresolvedFlag) return null;

    const reviewedSince = await this.prisma.attendanceLog.findFirst({
      where: { employeeId, attendanceDate, reviewedAt: { gt: latestUnresolvedFlag.capturedAt } },
      select: { id: true },
    });
    if (reviewedSince) return null;

    return buildFlagHoldMessage(latestUnresolvedFlag.logType, await this.resolveReviewerLabel(employeeId, employee));
  }

  // The card that replaces the hold once a reviewer has rejected a flagged
  // attempt for this working day: the same text as the "Attendance
  // Rejected" notification, shown until the employee records an approved
  // scan of their own after that rejection. Null otherwise.
  private async getFlagRejectedMessage(employeeId: string, attendanceDate: Date): Promise<string | null> {
    const rejected = await this.prisma.attendanceLog.findFirst({
      where: { employeeId, attendanceDate, verificationStatus: "FAKE_ATTEMPT", reviewedAt: { not: null } },
      orderBy: { reviewedAt: "desc" },
      select: { reviewedAt: true, logType: true },
    });
    if (!rejected?.reviewedAt) return null;

    const approvedSince = await this.prisma.attendanceLog.findFirst({
      where: { employeeId, attendanceDate, verificationStatus: "APPROVED", capturedAt: { gt: rejected.reviewedAt } },
      select: { id: true },
    });
    if (approvedSince) return null;

    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { userId: true, supervisorId: true },
    });
    if (!employee) return null;

    return buildFlagRejectedMessage(rejected.logType, await this.resolveReviewerLabel(employeeId, employee));
  }

  // Who an employee is told to report to about a flagged attempt — the same
  // routing notifyFlaggedAttempt uses for who actually gets notified: their
  // direct supervisor, or HR/Admin for a supervisor or anyone without one.
  private async resolveReviewerLabel(
    employeeId: string,
    employee: { userId: string | null; supervisorId: string | null },
  ) {
    if (TRIAL_SUPERVISOR_WORDING_EMPLOYEE_IDS.includes(employeeId)) return "Supervisor";
    const isSupervisor = employee.userId
      ? await this.notifications.userHasRole(employee.userId, "SUPERVISOR")
      : false;
    return !isSupervisor && employee.supervisorId ? "Supervisor" : "HR/Admin";
  }

  // Resolves the Shift template governing an employee's attendance at a given
  // moment, via whichever EmployeeSchedule assignment is currently active
  // (startsOn <= at, and endsOn is null or still in the future).
  private async resolveActiveShift(employeeId: string, at: Date) {
    return (await this.resolveActiveSchedule(employeeId, at))?.shift ?? null;
  }

  private async resolveActiveSchedule(employeeId: string, at: Date) {
    return this.prisma.employeeSchedule.findFirst({
      where: {
        employeeId,
        startsOn: { lte: at },
        OR: [{ endsOn: null }, { endsOn: { gte: at } }],
      },
      orderBy: { startsOn: "desc" },
      include: { shift: true },
    });
  }

  // Which calendar day an OFFICE scan made at `now` is filed under. Normally
  // today — but a shift that crosses midnight is one working day filed under
  // the date it started on, so a scan after midnight resolves to yesterday
  // when either:
  // - yesterday's record is still open on an overnight shift (the break
  //   punches and Time Out all happen after midnight); or
  // - the employee's overnight shift from yesterday is still running and
  //   yesterday was one of their working days (a Time In that arrives after
  //   midnight is a very late arrival for that shift, not an early one for
  //   tonight's).
  private async resolveOfficeAttendanceDate(employeeId: string, now: Date): Promise<Date> {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

    const previous = await this.prisma.attendanceRecord.findUnique({
      where: {
        employeeId_attendanceDate_recordType_visitNumber: {
          employeeId,
          attendanceDate: yesterday,
          recordType: "OFFICE",
          visitNumber: 1,
        },
      },
      include: { shift: true },
    });
    if (
      previous?.timeInAt &&
      !previous.timeOutAt &&
      previous.shift &&
      canContinueOvernightRecord(previous.shift, yesterday, now)
    ) {
      return yesterday;
    }

    const schedule = await this.resolveActiveSchedule(employeeId, now);
    if (
      schedule &&
      isInsidePreviousDayShift(schedule.shift, now) &&
      !isNonWorkingDay(yesterday, schedule.workingDays)
    ) {
      return yesterday;
    }

    return today;
  }

  // Computes shift-based lateness/undertime and upserts the day's
  // AttendanceRecord. Shared by submit()'s auto-approve path (effectiveTime
  // = the moment of the scan) and validateFlaggedLog() (effectiveTime = the
  // flagged log's original capturedAt) — a later admin validation must
  // record the DTR as of when the employee actually scanned, not when the
  // admin got around to reviewing it.
  private async upsertAttendanceRecord(params: {
    employeeId: string;
    attendanceDate: Date;
    recordType: "OFFICE" | "FIELD";
    visitNumber: number;
    workLocationId: string;
    logType: "TIME_IN" | "TIME_OUT" | "LUNCH_OUT" | "LUNCH_IN";
    isField: boolean;
    existingRecord: AttendanceRecord | null;
    effectiveTime: Date;
  }) {
    const { employeeId, attendanceDate, recordType, visitNumber, workLocationId, logType, isField, existingRecord, effectiveTime } = params;

    // Shift-based lateness/undertime is only meaningful for the OFFICE/FIXED
    // path — FIELD visits keep their existing always-PRESENT behavior, and an
    // employee with no active EmployeeSchedule assignment also falls back to
    // that same existing behavior (nothing to compare arrival against).
    let attendanceStatus: "PRESENT" | "LATE" = "PRESENT";
    let lateMinutes = 0;
    let resolvedShiftId: string | undefined;
    let renderTimeInValue: Date | undefined;
    let undertimeMinutesValue: number | undefined;
    let overtimeMinutesValue: number | undefined;
    let breakMinutesTotal = 0;

    if (!isField) {
      if (logType === "TIME_IN") {
        const shift = await this.resolveActiveShift(employeeId, effectiveTime);
        if (shift) {
          const arrivalForRules = shift.enableRounding
            ? roundToInterval(effectiveTime, shift.roundingIntervalMinutes)
            : effectiveTime;
          let effectiveShift = shift;
          let minutesLate = computeMinutesLate(shift, arrivalForRules, attendanceDate);

          if (minutesLate > 0 && shift.autoShiftAdjustment) {
            const otherShifts = await this.prisma.shift.findMany({
              where: { isActive: true, id: { not: shift.id } },
            });
            const matched = findBestMatchingShift(otherShifts, arrivalForRules, attendanceDate);
            if (matched) {
              effectiveShift = matched;
              minutesLate = computeMinutesLate(matched, arrivalForRules, attendanceDate);
            }
          }

          resolvedShiftId = effectiveShift.id;
          lateMinutes = minutesLate;
          attendanceStatus = minutesLate > 0 ? "LATE" : "PRESENT";
          renderTimeInValue = computeRenderTimeIn(effectiveShift, effectiveTime, attendanceDate);
        }
      } else if (logType === "TIME_OUT" && existingRecord?.shiftId) {
        const shift = await this.prisma.shift.findUnique({ where: { id: existingRecord.shiftId } });
        if (shift) {
          const departureForRules = shift.enableRounding
            ? roundToInterval(effectiveTime, shift.roundingIntervalMinutes)
            : effectiveTime;
          undertimeMinutesValue = computeMinutesUndertime(shift, departureForRules, attendanceDate);
          overtimeMinutesValue = computeMinutesOvertime(shift, departureForRules, attendanceDate);
          const workStart = existingRecord.renderTimeInAt ?? existingRecord.timeInAt;
          if (workStart) {
            breakMinutesTotal = computeBreakMinutes(shift, attendanceDate, workStart, effectiveTime, {
              lunchOutAt: existingRecord.lunchOutAt,
              lunchInAt: existingRecord.lunchInAt,
            });
          }
        }
      }
    }

    return this.prisma.attendanceRecord.upsert({
      where: {
        employeeId_attendanceDate_recordType_visitNumber: {
          employeeId,
          attendanceDate,
          recordType,
          visitNumber,
        },
      },

      create: {
        employeeId,
        attendanceDate,
        recordType,
        visitNumber,
        workLocationId,

        status: logType === "TIME_IN" && !isField ? attendanceStatus : "PRESENT",

        timeInAt: logType === "TIME_IN" ? effectiveTime : null,
        timeOutAt: logType === "TIME_OUT" ? effectiveTime : null,

        ...(logType === "TIME_IN" && !isField
          ? { lateMinutes, shiftId: resolvedShiftId, renderTimeInAt: renderTimeInValue }
          : {}),
      },

      update: {
        ...(logType === "TIME_IN"
          ? {
              timeInAt: effectiveTime,
              status: !isField ? attendanceStatus : "PRESENT",
              ...(!isField ? { lateMinutes, shiftId: resolvedShiftId, renderTimeInAt: renderTimeInValue } : {}),
            }
          : {}),

        ...(logType === "TIME_OUT" && existingRecord?.timeInAt
          ? {
              timeOutAt: effectiveTime,
              // Raw elapsed time minus the break minutes that fell inside it
              // (0 for FIELD or when no shift was resolved) — see
              // computeBreakMinutes. Floored at 0 so a time-out recorded
              // implausibly soon after time-in never goes negative.
              totalMinutes: Math.max(
                0,
                Math.round(
                  (effectiveTime.getTime() - (existingRecord.renderTimeInAt ?? existingRecord.timeInAt).getTime()) / 60000,
                ) - breakMinutesTotal,
              ),
              ...(!isField && undertimeMinutesValue !== undefined ? { undertimeMinutes: undertimeMinutesValue } : {}),
              ...(!isField && overtimeMinutesValue !== undefined ? { overtimeMinutes: overtimeMinutesValue } : {}),
            }
          : {}),

        // Recorded here for late/undertime purposes to stay unaffected by
        // lunch timing; totalMinutes at Time Out uses these two timestamps
        // instead of the shift's scheduled break window once both exist — see
        // computeBreakMinutes.
        ...(logType === "LUNCH_OUT" ? { lunchOutAt: effectiveTime } : {}),
        ...(logType === "LUNCH_IN" ? { lunchInAt: effectiveTime } : {}),
      },
    });
  }

  async createSession(employeeId?: string) {
    const location =
      employeeId ? await this.geolocation.getLocationForEmployee(employeeId) : null;

    return {
      sessionId: randomUUID(),
      workLocation: location,
      expiresInSeconds: 300,
    };
  }

  async submit(dto: SubmitAttendanceDto, context: AuditLogContext = {}) {
    const employee =
      await this.prisma.employee.findUnique({
        where: { id: dto.employeeId },
      });

    if (!employee) {
      throw new NotFoundException(
        "Employee not found",
      );
    }

    const now = new Date();
    const isField = employee.attendanceMode === "FIELD";

    // The working day this scan belongs to — yesterday for the after-midnight
    // half of an overnight shift (see resolveOfficeAttendanceDate), so its
    // break punches and Time Out land on the record its Time In opened.
    const attendanceDate = isField
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate())
      : await this.resolveOfficeAttendanceDate(dto.employeeId, now);

    // Enforced here, not just by the clients disabling their buttons: while
    // a flagged-attempt hold is active, nothing is recorded until a
    // supervisor/admin has reviewed it.
    const holdMessage = await this.getFlaggedAttemptHoldMessage(dto.employeeId, attendanceDate);
    if (holdMessage) {
      throw new ForbiddenException(holdMessage);
    }

    // Sunday is a company-wide rest day for every role — employee, supervisor,
    // and admin/HR alike — so no attendance is taken or required from anyone.
    // Checked against the working day, not the clock: a Saturday night shift
    // still closes out on Sunday morning.
    if (isDayOff(attendanceDate)) {
      throw new BadRequestException("Today is a scheduled day off (Sunday). Attendance is not required.");
    }

    // For a FIXED employee, recordType is always OFFICE. For a FIELD
    // employee, recordType is auto-detected per visit from the classification
    // of the WorkLocation they actually checked into (see WorkLocation.type)
    // — a field technician who visits an office-classified area is recorded
    // as an OFFICE visit rather than always being tagged FIELD. Kept as its
    // own column (rather than derived on read) so the DTR screen's
    // Office/Field tabs are a simple query.
    let recordType: "OFFICE" | "FIELD" = isField ? "FIELD" : "OFFICE";

    let existingRecord: AttendanceRecord | null;
    let logType: "TIME_IN" | "TIME_OUT" | "LUNCH_OUT" | "LUNCH_IN" | null;
    let visitNumber: number;
    let location: any;

    if (isField) {
      // Field technicians may log several sequential site visits per day,
      // possibly at a mix of office- and field-classified areas — the latest
      // visit overall (by time in, not visitNumber, since visitNumber is now
      // scoped per recordType) decides whether this scan opens a new visit
      // or closes the one already in progress.
      const latestVisit = await this.prisma.attendanceRecord.findFirst({
        where: { employeeId: dto.employeeId, attendanceDate },
        orderBy: { timeInAt: "desc" },
      });

      const hasOpenVisit = Boolean(latestVisit?.timeInAt && !latestVisit?.timeOutAt);

      if (hasOpenVisit) {
        // Closing an open visit reuses its own recordType/site rather than
        // re-resolving from a (possibly different) newly submitted location.
        existingRecord = latestVisit;
        logType = "TIME_OUT";
        recordType = latestVisit!.recordType as "OFFICE" | "FIELD";
        visitNumber = latestVisit!.visitNumber;
        location = await this.geolocation.getLocationById(latestVisit!.workLocationId);
      } else {
        existingRecord = null;
        logType = "TIME_IN";
        location = await this.resolveFieldVisitLocation(dto.employeeId, dto.workLocationId);
        recordType = location?.type ?? "FIELD";

        const latestVisitOfType = await this.prisma.attendanceRecord.findFirst({
          where: { employeeId: dto.employeeId, attendanceDate, recordType },
          orderBy: { visitNumber: "desc" },
        });
        visitNumber = (latestVisitOfType?.visitNumber ?? 0) + 1;
      }
    } else {
      existingRecord = await this.prisma.attendanceRecord.findUnique({
        where: {
          employeeId_attendanceDate_recordType_visitNumber: {
            employeeId: dto.employeeId,
            attendanceDate,
            recordType: "OFFICE",
            visitNumber: 1,
          },
        },
      });

      // The server, not the button the employee tapped, is the authority on whether
      // this scan is a Time In or Time Out, derived from the latest attendance entry.
      // The one exception is the window after Time In and before Time Out: lunch
      // break is optional, so Time Out, Lunch Out, and Lunch In can all be legal
      // next actions simultaneously — state alone can't disambiguate them, so the
      // client's requested `action` decides which one this scan is for. The server
      // still validates it's actually legal for the current state below.
      if (!existingRecord?.timeInAt) {
        logType = "TIME_IN";
      } else if (existingRecord.timeOutAt) {
        logType = null;
      } else if (dto.action === "LUNCH_OUT") {
        if (existingRecord.lunchOutAt) {
          throw new BadRequestException("Lunch break has already started.");
        }
        logType = "LUNCH_OUT";
      } else if (dto.action === "LUNCH_IN") {
        if (!existingRecord.lunchOutAt) {
          throw new BadRequestException("Start your lunch break before ending it.");
        }
        if (existingRecord.lunchInAt) {
          throw new BadRequestException("Lunch break has already ended.");
        }
        logType = "LUNCH_IN";
      } else {
        logType = "TIME_OUT";
      }
      visitNumber = 1;

      if (!logType) {
        throw new BadRequestException("You have already completed your attendance for today.");
      }

      location = await this.geolocation.getLocationForEmployee(dto.employeeId);
    }

    // An employee on approved leave can't record attendance for that day.
    // Only a Time In is refused — a record already open (e.g. an overnight
    // shift that began before the leave) can still be closed out. A leave
    // that is merely pending doesn't block anything: working that day is
    // simply recorded as present.
    if (logType === "TIME_IN") {
      const onLeave = (await getApprovedLeaveByEmployee(this.prisma, [dto.employeeId], attendanceDate)).get(dto.employeeId);
      if (onLeave) {
        throw new BadRequestException(
          `You are on approved ${onLeave.leaveTypeName} today. Attendance can't be recorded while on leave.`,
        );
      }
    }

    if (!location) {
      throw new NotFoundException(
        isField
          ? "Select one of your assigned client/work sites for this visit"
          : "No active work location is assigned to this employee",
      );
    }

    // allowedAccuracyMeters is configured phone-GPS-tight (tens of meters).
    // A desktop/laptop browser has no GPS chip — navigator.geolocation falls
    // back to Wi-Fi/IP-based positioning, which routinely reports accuracy
    // in the hundreds or thousands of meters even standing right at the
    // site, so the same threshold would reject web check-ins outright
    // regardless of actual distance. Only the accuracy *tolerance* is
    // loosened for web (identified by the fixed deviceId the web client
    // sends — see AttendancePage.tsx); the actual distance-to-site check
    // below is unchanged, and mobile keeps its original tight tolerance.
    const isWebClient = dto.deviceId === "web-browser";
    const WEB_ACCURACY_FALLBACK_METERS = 2000;
    const allowedAccuracyMeters = isWebClient
      ? Math.max(Number(location.allowedAccuracyMeters), WEB_ACCURACY_FALLBACK_METERS)
      : Number(location.allowedAccuracyMeters);

    const geoResult =
      this.geolocation.validateGeofence({
        latitude: dto.latitude,
        longitude: dto.longitude,
        accuracyMeters:
          dto.accuracyMeters,

        siteLatitude: Number(
          location.latitude,
        ),

        siteLongitude: Number(
          location.longitude,
        ),

        radiusMeters: Number(
          location.radiusMeters,
        ),

        allowedAccuracyMeters,
      });

    // Location is validated before anything face-related runs at all: a
    // request outside the allowed area is rejected immediately, without ever
    // loading the employee's FaceProfile or running descriptor
    // extraction/comparison. This mirrors the mobile client, which must
    // never open the camera in this case either — and it means a request
    // that bypasses the mobile UI and hits this endpoint directly still
    // cannot buy an approval by lying about face verification, since
    // approval never depends on anything the client claims about its own
    // face check, and no face data is even processed until location clears.
    if (!geoResult.approved) {
      return {
        approved: false,
        verificationStatus: "REJECTED" as const,
        logType,
        faceResult: {
          status: "REJECTED" as const,
          reason: "Face verification unavailable — outside the allowed area",
          similarityScore: 0,
        },
        geoResult,
        attendanceRecordId: existingRecord?.id ?? null,
        similarityScore: 0,
        faceImage: null,
        capturedAt: null,
      };
    }

    const faceProfile = (await this.prisma.faceProfile.findFirst({
      where: { employeeId: dto.employeeId, enrollmentStatus: "ACTIVE", isArchived: false },
      orderBy: { enrolledAt: "desc" },
    })) as any;

    const enrolledDescriptor = Array.isArray(faceProfile?.descriptors) ? faceProfile.descriptors[0] : null;

    if (!faceProfile?.referenceImageData || !Array.isArray(enrolledDescriptor)) {
      throw new NotFoundException("No active face profile is enrolled for this employee");
    }

    // Auto-levels the capture before matching/storing it: front-camera
    // selfies taken indoors with no flash are routinely underexposed, which
    // both looks bad in the saved photo and starves the descriptor of the
    // contrast it needs for an accurate match.
    const capturedImage = await this.faceVerification.brightenImage(
      this.decodeImageBase64(dto.faceImageBase64),
    );

    const capturedDescriptor = await this.faceVerification.extractDescriptor(capturedImage.buffer);

    const distance = capturedDescriptor
      ? this.faceVerification.compareDescriptors(enrolledDescriptor, capturedDescriptor)
      : null;

    const livenessScore = 100;

    const faceResult = this.faceVerification.evaluateMatch(livenessScore, distance);
    const similarityScore = faceResult.similarityScore;

    // geoResult.approved is already guaranteed true here (see the
    // short-circuit above), so approval now rests solely on the face match.
    const approved = faceResult.status === "APPROVED" && geoResult.approved;

    // Any scan where a face was found but didn't cleanly match the enrolled
    // one is escalated to the supervisor/admin for a human decision — both a
    // borderline match (evaluateMatch's PENDING_REVIEW) and a flat mismatch
    // (its "Face does not match enrolled profile" REJECTED). With a single
    // enrolled sample, the real employee in poor lighting routinely scores
    // as a flat mismatch, so rejecting those outright just told a genuine
    // employee to keep retrying; flagging puts the captured photo in front
    // of a reviewer instead, who can tell impersonation from a bad scan.
    // No face found, or a failed liveness check, is still a plain rejection
    // — there's nothing for a reviewer to judge. A geofence failure is never
    // escalated this way either (wrong location isn't evidence of
    // impersonation) — geoResult.approved is already guaranteed true here
    // regardless, per the short-circuit above.
    const faceMismatched =
      faceResult.status === "PENDING_REVIEW" ||
      (faceResult.status === "REJECTED" && faceResult.reason === "Face does not match enrolled profile");
    const shouldFlag = faceMismatched && geoResult.approved;

    const verificationStatus = approved ? "APPROVED" : shouldFlag ? "PENDING_REVIEW" : "REJECTED";

    const logTypeLabel: Record<typeof logType & string, string> = {
      TIME_IN: "time in",
      TIME_OUT: "time out",
      LUNCH_OUT: "break start",
      LUNCH_IN: "break end",
    };

    // Neither a flat rejection nor a flagged/borderline attempt creates or
    // touches the day's attendance record — only a fully approved scan does.
    // A flagged attempt gets its own AttendanceLog (attendanceRecordId null)
    // below, and only becomes a real AttendanceRecord once an admin/
    // supervisor validates it (see validateFlaggedLog()).
    const record = approved
      ? await this.upsertAttendanceRecord({
          employeeId: dto.employeeId,
          attendanceDate,
          recordType,
          visitNumber,
          workLocationId: location.id,
          logType: logType!,
          isField,
          existingRecord,
          effectiveTime: now,
        })
      : existingRecord;

    // Only set on the shouldFlag branch below — how many same-day flagged
    // (PENDING_REVIEW) attempts this employee now has, so the mobile client
    // can tell the employee whether this is their 1st/2nd/3rd unclear
    // attempt today instead of always showing the same generic message.
    let flaggedAttemptCount: number | null = null;

    // Resolved once, server-side, and reused for whichever branch below
    // creates a log — see AttendanceLog.address's schema comment for why
    // this happens here instead of each DTR viewer re-geocoding on its own.
    // Skipped for an outright rejection, which never creates a log row.
    const address =
      approved || shouldFlag ? await this.geolocation.reverseGeocode(dto.latitude, dto.longitude) : null;

    if (approved) {
      await this.prisma.attendanceLog.create({
        data: {
          attendanceRecordId: record?.id ?? null,
          employeeId: dto.employeeId,
          logType,
          attendanceDate,
          recordType,
          visitNumber,
          latitude: dto.latitude,
          longitude: dto.longitude,
          address,
          gpsAccuracyMeters: dto.accuracyMeters,
          distanceFromSiteMeters: geoResult.distanceMeters,
          workLocationId: location.id,
          faceLivenessScore: livenessScore,
          faceSimilarityScore: similarityScore,
          verificationStatus,
          deviceId: dto.deviceId,
          failureReason: faceResult.reason ?? geoResult.reason,
          faceImageData: capturedImage.data,
          faceImageMimeType: capturedImage.mimeType,
        },
      });

      // Not awaited: record() already swallows its own errors (see
      // AuditLogsService), and the employee's result doesn't depend on
      // whether this write has landed yet — waiting on it here just adds a
      // DB round trip to how long they stare at a spinner before the
      // approved/rejected modal shows.
      void this.auditLogs.record({
        ...context,
        actorUserId: context.actorUserId,
        action: logType,
        module: "Attendance",
        entityType: "AttendanceRecord",
        entityId: record?.id ?? null,
        description: `${employee.firstName} ${employee.lastName} recorded ${logTypeLabel[logType]}.`,
        newValues: {
          employeeId: dto.employeeId,
          logType,
          verificationStatus,
          workLocationId: location.id,
          deviceId: dto.deviceId,
          latitude: dto.latitude,
          longitude: dto.longitude,
        },
      });

      void this.auditLogs.record({
        ...context,
        actorUserId: context.actorUserId,
        action: "FACE_VERIFICATION",
        module: "Face Verification",
        entityType: "FaceVerification",
        entityId: dto.employeeId,
        description: `Face verification ${verificationStatus.toLowerCase()} for ${employee.firstName} ${employee.lastName}.`,
        newValues: { employeeId: dto.employeeId, verificationStatus, similarityScore, deviceId: dto.deviceId },
      });
    } else if (shouldFlag) {
      const flaggedLog = await this.prisma.attendanceLog.create({
        data: {
          attendanceRecordId: null,
          employeeId: dto.employeeId,
          logType,
          attendanceDate,
          recordType,
          visitNumber,
          latitude: dto.latitude,
          longitude: dto.longitude,
          address,
          gpsAccuracyMeters: dto.accuracyMeters,
          distanceFromSiteMeters: geoResult.distanceMeters,
          workLocationId: location.id,
          faceLivenessScore: livenessScore,
          faceSimilarityScore: similarityScore,
          verificationStatus: "PENDING_REVIEW",
          deviceId: dto.deviceId,
          failureReason: faceResult.reason ?? geoResult.reason,
          faceImageData: capturedImage.data,
          faceImageMimeType: capturedImage.mimeType,
        },
      });

      // Only the latest failed attempt is kept in the review queue: any
      // earlier same-day attempt still awaiting review is superseded by this
      // one, so the attendance table shows one row per employee instead of
      // one per retry. reviewedAt is deliberately left null — nobody reviewed
      // these, and getFlaggedAttemptHoldMessage treats a reviewedAt newer
      // than the latest flag as the hold being lifted.
      await this.prisma.attendanceLog.updateMany({
        where: {
          employeeId: dto.employeeId,
          attendanceDate,
          verificationStatus: "PENDING_REVIEW",
          attendanceRecordId: null,
          id: { not: flaggedLog.id },
        },
        data: { verificationStatus: "ARCHIVED", reviewRemarks: "Superseded by a later attempt." },
      });

      // recordFlaggedAttempt stays awaited: its return value is the
      // flaggedAttemptCount the mobile client uses to pick its 1st/2nd/3rd
      // modal copy, so it's part of the answer, not a side effect. Sending
      // the notification and writing the audit log are pure side effects
      // the employee's own result doesn't depend on, so — like the approved
      // branch above — they're fired without awaiting to keep this response
      // as fast as the actual verification work allows.
      flaggedAttemptCount = await this.recordFlaggedAttempt(dto.employeeId, attendanceDate);
      if (flaggedAttemptCount === FLAGGED_NOTIFY_THRESHOLD) {
        void this.notifyFlaggedAttempt(employee, flaggedLog.id, logType!, logTypeLabel).catch((error) =>
          console.error("Failed to notify supervisor of flagged attendance attempt", error),
        );
        // The account owner gets their own persistent notification too, not
        // just the in-the-moment result modal — so it's still there if they
        // dismissed that modal without reading it.
        void this.notifyEmployeeOfLock(employee, logType!).catch((error) =>
          console.error("Failed to notify employee of attendance lock", error),
        );
      }

      void this.auditLogs.record({
        ...context,
        actorUserId: context.actorUserId,
        action: "FLAG_ATTENDANCE_MISMATCH",
        module: "Attendance",
        entityType: "AttendanceLog",
        entityId: flaggedLog.id,
        description: `${employee.firstName} ${employee.lastName}'s account was used for a ${logTypeLabel[logType]} attempt whose face did not match the enrolled profile. Flagged for admin review.`,
        newValues: {
          employeeId: dto.employeeId,
          logType,
          verificationStatus: "PENDING_REVIEW",
          similarityScore,
          workLocationId: location.id,
          deviceId: dto.deviceId,
        },
      });
    }

    return {
      approved,
      verificationStatus,
      logType,
      faceResult,
      geoResult,
      attendanceRecordId:
        record?.id ?? null,
      similarityScore,
      flaggedAttemptCount,
      faceImage: `data:${capturedImage.mimeType};base64,${capturedImage.data}`,
      // The exact instant this scan was recorded against — same `now` passed
      // as upsertAttendanceRecord's effectiveTime, so it equals the raw
      // timeInAt/timeOutAt/lunchOutAt/lunchInAt that ends up on the
      // AttendanceRecord (and therefore the DTR). Only meaningful when
      // approved; a client should never derive a displayed timestamp from
      // its own clock, since that drifts from the DTR by however long face
      // verification took plus network latency.
      capturedAt: approved ? now.toISOString() : null,
    };
  }

  // Tracks same-day borderline flagged-attempt streaks and returns the
  // resulting count, so submit() can decide whether this attempt just
  // crossed FLAGGED_NOTIFY_THRESHOLD. Resets whenever a flag lands on a day
  // different from the one last recorded, mirroring
  // FaceVerificationService.recordFaceMismatch().
  private async recordFlaggedAttempt(employeeId: string, today: Date): Promise<number> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { flaggedAttemptCount: true, flaggedAttemptCountDate: true },
    });
    if (!employee) return 0;

    const isSameDay = employee.flaggedAttemptCountDate?.getTime() === today.getTime();
    const nextCount = isSameDay ? employee.flaggedAttemptCount + 1 : 1;

    await this.prisma.employee.update({
      where: { id: employeeId },
      data: { flaggedAttemptCount: nextCount, flaggedAttemptCountDate: today },
    });

    return nextCount;
  }

  // Mirrors leave.service.ts's notifySubmission(): a regular employee's
  // flagged attempt routes to their direct supervisor; a supervisor (or an
  // employee with no assigned supervisor) has no one above them to escalate
  // to, so it routes to HR/Admin instead. Only called once the same-day
  // flagged-attempt count reaches FLAGGED_NOTIFY_THRESHOLD (see submit()) —
  // every flagged attempt is still queued for review immediately regardless,
  // this just delays the notification itself.
  private async notifyFlaggedAttempt(
    employee: { userId: string; supervisorId: string | null; firstName: string; lastName: string },
    logId: string,
    logType: "TIME_IN" | "TIME_OUT" | "LUNCH_OUT" | "LUNCH_IN",
    logTypeLabel: Record<string, string>,
  ) {
    const isSupervisor = await this.notifications.userHasRole(employee.userId, "SUPERVISOR");

    let recipientIds: string[];
    if (!isSupervisor && employee.supervisorId) {
      const supervisor = await this.prisma.employee.findUnique({
        where: { id: employee.supervisorId },
        select: { userId: true },
      });
      recipientIds = supervisor?.userId ? [supervisor.userId] : await this.notifications.adminUserIds();
    } else {
      recipientIds = await this.notifications.adminUserIds();
    }

    await this.notifications.notifyUsers(recipientIds, {
      title: "Attendance Verification Flagged",
      message: `${employee.firstName} ${employee.lastName}'s account has had ${FLAGGED_NOTIFY_THRESHOLD} flagged ${logTypeLabel[logType]} attempts today where the captured face did not clearly match the enrolled profile. Review required.`,
      type: "ATTENDANCE_FLAGGED",
      entityId: logId,
    });
  }

  // The account owner's own copy of the same escalation notifyFlaggedAttempt
  // just sent their supervisor — a persistent notification (not just the
  // in-the-moment result modal, which they may have dismissed without
  // reading) telling them attendance is disabled until it's reviewed, and
  // who to report to. Same wording as the attendance screen's red card
  // (see getFlaggedAttemptHoldMessage).
  private async notifyEmployeeOfLock(
    employee: { id: string; userId: string; supervisorId: string | null },
    logType: "TIME_IN" | "TIME_OUT" | "LUNCH_OUT" | "LUNCH_IN",
  ) {
    const reviewerLabel = await this.resolveReviewerLabel(employee.id, employee);
    await this.notifications.notifyUsers([employee.userId], {
      title: `Attendance Disabled — Report to Your ${reviewerLabel}`,
      message: buildFlagHoldMessage(logType, reviewerLabel),
      type: "ATTENDANCE_LOCKED",
    });
  }

  // Flagged attempts awaiting a human decision: geofence passed but the
  // face didn't cleanly match the account being used. No AttendanceRecord
  // exists for these yet (attendanceRecordId is null) — see submit()'s
  // shouldFlag branch.
  async findFlaggedLogs(filters: { departmentId?: string } = {}) {
    return this.prisma.attendanceLog.findMany({
      where: {
        verificationStatus: "PENDING_REVIEW",
        attendanceRecordId: null,
        ...(filters.departmentId ? { employee: { departmentId: filters.departmentId } } : {}),
      },
      include: {
        employee: {
          include: {
            department: true,
            position: { select: { title: true } },
            user: { select: EMPLOYEE_ROLE_CODES_SELECT },
            faceProfiles: { orderBy: { enrolledAt: "desc" }, take: 1 },
          },
        },
        workLocation: { select: { name: true } },
      },
      orderBy: { capturedAt: "desc" },
    });
  }

  // The earlier same-day failed attempts a flagged log superseded (see
  // submit()'s shouldFlag branch), oldest first, so the reviewer can still
  // compare them against the latest one. Loaded lazily by the review modal
  // rather than inlined into findFlaggedLogs(), since each carries a photo.
  // reviewedAt: null is what tells a superseded attempt apart from one a
  // reviewer archived by hand.
  async findPreviousFlaggedAttempts(logId: string, scopeDepartmentId?: string) {
    const log = await this.prisma.attendanceLog.findUniqueOrThrow({
      where: { id: logId },
      select: { employeeId: true, attendanceDate: true, capturedAt: true, employee: { select: { departmentId: true } } },
    });

    if (scopeDepartmentId && log.employee.departmentId !== scopeDepartmentId) {
      throw new ForbiddenException("You can only manage attendance records from your own department.");
    }
    if (!log.attendanceDate) return [];

    return this.prisma.attendanceLog.findMany({
      where: {
        employeeId: log.employeeId,
        attendanceDate: log.attendanceDate,
        verificationStatus: "ARCHIVED",
        attendanceRecordId: null,
        reviewedAt: null,
        capturedAt: { lt: log.capturedAt },
      },
      select: {
        id: true,
        logType: true,
        capturedAt: true,
        latitude: true,
        longitude: true,
        distanceFromSiteMeters: true,
        faceSimilarityScore: true,
        verificationStatus: true,
        failureReason: true,
        faceImageData: true,
        faceImageMimeType: true,
      },
      orderBy: { capturedAt: "asc" },
    });
  }

  // Admin/supervisor confirms a flagged attempt was actually the account
  // owner (e.g. a borderline match under bad lighting): creates the DTR
  // dated to the *original* scan time, not the moment of this review.
  async validateFlaggedLog(logId: string, remarks: string | undefined, context: AuditLogContext = {}, scopeDepartmentId?: string) {
    const log = await this.prisma.attendanceLog.findUniqueOrThrow({
      where: { id: logId },
      include: {
        employee: { select: { departmentId: true, firstName: true, lastName: true, userId: true, attendanceMode: true } },
      },
    });

    if (log.verificationStatus !== "PENDING_REVIEW" || log.attendanceRecordId) {
      throw new BadRequestException("This attendance attempt has already been reviewed.");
    }

    if (scopeDepartmentId && log.employee.departmentId !== scopeDepartmentId) {
      throw new ForbiddenException("You can only manage attendance records from your own department.");
    }

    const { attendanceDate, recordType, visitNumber, workLocationId } = log;
    if (!attendanceDate || !recordType || visitNumber === null || !workLocationId) {
      throw new BadRequestException("This flagged attempt is missing data required to record it.");
    }

    const isField = log.employee.attendanceMode === "FIELD";

    const existingRecord = await this.prisma.attendanceRecord.findUnique({
      where: {
        employeeId_attendanceDate_recordType_visitNumber: {
          employeeId: log.employeeId,
          attendanceDate,
          recordType,
          visitNumber,
        },
      },
    });

    const record = await this.upsertAttendanceRecord({
      employeeId: log.employeeId,
      attendanceDate,
      recordType,
      visitNumber,
      workLocationId,
      logType: log.logType as "TIME_IN" | "TIME_OUT" | "LUNCH_OUT" | "LUNCH_IN",
      isField,
      existingRecord,
      effectiveTime: log.capturedAt,
    });

    const updatedLog = await this.prisma.attendanceLog.update({
      where: { id: logId },
      data: {
        attendanceRecordId: record.id,
        verificationStatus: "APPROVED",
        reviewedAt: new Date(),
        reviewedBy: context.actorUserId,
        reviewRemarks: remarks?.trim() || null,
      },
    });

    await this.auditLogs.record({
      ...context,
      action: "VALIDATE_FLAGGED_ATTENDANCE",
      module: "Attendance",
      entityType: "AttendanceLog",
      entityId: logId,
      description: `Validated ${log.employee.firstName} ${log.employee.lastName}'s flagged attendance attempt as legitimate.`,
      oldValues: { verificationStatus: log.verificationStatus },
      newValues: { remarks: remarks?.trim(), verificationStatus: "APPROVED" },
    });

    if (log.employee.userId) {
      await this.notifications.notifyUsers([log.employee.userId], {
        title: "Attendance Validated",
        message: `Your ${log.capturedAt.toLocaleDateString()} attendance attempt was reviewed and validated. It has been recorded.`,
        type: "ATTENDANCE_VALIDATED",
        entityId: logId,
      });
    }

    return updatedLog;
  }

  // Admin/supervisor confirms a flagged attempt was impersonation: tagged as
  // a fake attendance attempt, no DTR is ever created for it.
  async rejectFlaggedLog(logId: string, remarks: string | undefined, context: AuditLogContext = {}, scopeDepartmentId?: string) {
    const log = await this.prisma.attendanceLog.findUniqueOrThrow({
      where: { id: logId },
      include: { employee: { select: { departmentId: true, firstName: true, lastName: true, userId: true, supervisorId: true } } },
    });

    if (log.verificationStatus !== "PENDING_REVIEW" || log.attendanceRecordId) {
      throw new BadRequestException("This attendance attempt has already been reviewed.");
    }

    if (scopeDepartmentId && log.employee.departmentId !== scopeDepartmentId) {
      throw new ForbiddenException("You can only manage attendance records from your own department.");
    }

    const updatedLog = await this.prisma.attendanceLog.update({
      where: { id: logId },
      data: {
        verificationStatus: "FAKE_ATTEMPT",
        reviewedAt: new Date(),
        reviewedBy: context.actorUserId,
        reviewRemarks: remarks?.trim() || null,
      },
    });

    await this.auditLogs.record({
      ...context,
      action: "REJECT_FLAGGED_ATTENDANCE",
      module: "Attendance",
      entityType: "AttendanceLog",
      entityId: logId,
      description: `Confirmed a fake attendance attempt on ${log.employee.firstName} ${log.employee.lastName}'s account.`,
      oldValues: { verificationStatus: log.verificationStatus },
      newValues: { remarks: remarks?.trim(), verificationStatus: "FAKE_ATTEMPT" },
    });

    if (log.employee.userId) {
      // A same-day rejection is also what lifts the flagged-attempt hold
      // (see getFlaggedAttemptHoldMessage), so it tells the employee to
      // record their real attendance now. An older attempt rejected after
      // the fact has no attendance left to record for that day.
      const isSameDay = log.capturedAt.toDateString() === new Date().toDateString();
      const label = FLAGGED_LOG_TYPE_LABEL[log.logType] ?? "attendance";
      const reviewerLabel = await this.resolveReviewerLabel(log.employeeId, log.employee);
      await this.notifications.notifyUsers([log.employee.userId], isSameDay
        ? {
            title: "Attendance Rejected — Log Your Attendance Now",
            message: buildFlagRejectedMessage(log.logType, reviewerLabel),
            type: "ATTENDANCE_FAKE_ATTEMPT",
            entityId: logId,
          }
        : {
            title: "Unauthorized Attendance Attempt",
            message: `A ${log.capturedAt.toLocaleDateString()} attendance attempt on your account did not pass verification and was flagged as unauthorized. Contact HR if this wasn't you.`,
            type: "ATTENDANCE_FAKE_ATTEMPT",
            entityId: logId,
          });
    }

    return updatedLog;
  }

  // Admin/supervisor dismisses a flagged attempt without deciding it was
  // legitimate or impersonation — e.g. a stale/unreachable attempt not worth
  // pursuing. Removes it from the flagged review queue with no DTR created
  // and no notification to the employee, since no decision about them is
  // being communicated.
  async archiveFlaggedLog(logId: string, remarks: string | undefined, context: AuditLogContext = {}, scopeDepartmentId?: string) {
    const log = await this.prisma.attendanceLog.findUniqueOrThrow({
      where: { id: logId },
      include: { employee: { select: { departmentId: true, firstName: true, lastName: true } } },
    });

    if (log.verificationStatus !== "PENDING_REVIEW" || log.attendanceRecordId) {
      throw new BadRequestException("This attendance attempt has already been reviewed.");
    }

    if (scopeDepartmentId && log.employee.departmentId !== scopeDepartmentId) {
      throw new ForbiddenException("You can only manage attendance records from your own department.");
    }

    const updatedLog = await this.prisma.attendanceLog.update({
      where: { id: logId },
      data: {
        verificationStatus: "ARCHIVED",
        reviewedAt: new Date(),
        reviewedBy: context.actorUserId,
        reviewRemarks: remarks?.trim() || null,
      },
    });

    await this.auditLogs.record({
      ...context,
      action: "ARCHIVE_FLAGGED_ATTENDANCE",
      module: "Attendance",
      entityType: "AttendanceLog",
      entityId: logId,
      description: `Archived a flagged attendance attempt on ${log.employee.firstName} ${log.employee.lastName}'s account.`,
      oldValues: { verificationStatus: log.verificationStatus },
      newValues: { remarks: remarks?.trim(), verificationStatus: "ARCHIVED" },
    });

    return updatedLog;
  }

  // Resolves which assigned site a FIELD employee is starting a new visit
  // at: the explicitly selected site if one was sent, otherwise — to stay
  // robust during a mobile-app rollout window where an older build might
  // omit it — the technician's sole assigned site, if they only have one.
  private async resolveFieldVisitLocation(employeeId: string, workLocationId?: string) {
    if (workLocationId) {
      return this.geolocation.findLocationForFieldVisit(employeeId, workLocationId);
    }

    const assignedLocations = await this.geolocation.getLocationsForEmployee(employeeId);
    return assignedLocations.length === 1 ? assignedLocations[0] : null;
  }

  async getHistory(employeeId: string, limit = 30) {
    return withPrismaRetry(async () => {
      const records = await this.prisma.attendanceRecord.findMany({
        where: { employeeId },
        orderBy: [{ attendanceDate: "desc" }, { visitNumber: "asc" }],
        take: limit,
        include: {
          workLocation: { select: { name: true } },
          undertimeFilings: { where: { status: "APPROVED" }, select: { id: true }, take: 1 },
          shift: { select: { startTime: true, endTime: true, lateThresholdMinutes: true, lunchBreakMinutes: true, breakStartTime: true, breakKind: true } },
          // Include every attempt for the day, not just the approved
          // TIME_IN/TIME_OUT ones — rejected attempts still have a captured
          // photo and the employee should be able to review it too.
          // faceImageData/faceImageMimeType are deliberately NOT selected
          // here — inlining every log's full base64 photo for up to `limit`
          // records made this response tens of megabytes (e.g. 35MB for 26
          // records), which reliably timed out over mobile wifi even though
          // it loaded fine over localhost/LAN. The photo itself is fetched
          // on demand via getRecordPhotos() only for the record the viewer
          // actually opens — see attendance.controller.ts's
          // "records/:id/photos" route.
          logs: {
            orderBy: { capturedAt: "asc" },
            select: {
              id: true,
              logType: true,
              capturedAt: true,
              verificationStatus: true,
              failureReason: true,
              latitude: true,
              longitude: true,
              address: true,
            },
          },
        },
      });

      const recordIds = records.map((record) => record.id);
      const logsWithPhoto = recordIds.length
        ? await this.prisma.attendanceLog.findMany({
            where: { attendanceRecordId: { in: recordIds }, faceImageData: { not: null } },
            select: { attendanceRecordId: true },
            distinct: ["attendanceRecordId"],
          })
        : [];
      const recordIdsWithPhoto = new Set(logsWithPhoto.map((log) => log.attendanceRecordId));

      const realRows = records.map(({ undertimeFilings, shift, ...record }) => ({
        ...record,
        breakKind: resolveBreakKind(shift),
        hasPhoto: recordIdsWithPhoto.has(record.id),
        hasApprovedUndertime: undertimeFilings.length > 0,
      }));

      // Absent and on-leave days have no AttendanceRecord, so they're rebuilt
      // here for the same span the real rows cover (at least the last
      // HISTORY_MISSED_DAYS_WINDOW days) — see resolveMissedDays.
      const missedRows = await this.buildMissedDayRows(employeeId, records.at(-1)?.attendanceDate);

      return [...realRows, ...missedRows].sort((a, b) => b.attendanceDate.getTime() - a.attendanceDate.getTime());
    });
  }

  private async buildMissedDayRows(employeeId: string, oldestRecordDate?: Date) {
    const now = new Date();
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { hireDate: true, attendanceMode: true },
    });
    if (!employee) return [];

    const defaultStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - HISTORY_MISSED_DAYS_WINDOW);
    const windowStart =
      oldestRecordDate && oldestRecordDate.getTime() < defaultStart.getTime() ? oldestRecordDate : defaultStart;

    const [recorded, leaves, schedules] = await Promise.all([
      this.prisma.attendanceRecord.findMany({
        where: { employeeId, attendanceDate: { gte: windowStart } },
        select: { attendanceDate: true },
      }),
      this.prisma.leaveRequest.findMany({
        where: {
          employeeId,
          status: { in: ["APPROVED", "PENDING", "SUPERVISOR_APPROVED", "NEEDS_REVISION"] },
          startDate: { lte: now },
          endDate: { gte: windowStart },
        },
        select: { status: true, startDate: true, endDate: true, leaveType: { select: { name: true } } },
      }),
      this.prisma.employeeSchedule.findMany({
        where: { employeeId },
        orderBy: { startsOn: "desc" },
        select: {
          startsOn: true,
          endsOn: true,
          workingDays: true,
          shift: { select: { name: true, startTime: true, endTime: true, lateThresholdMinutes: true } },
        },
      }),
    ]);

    const missedDays = resolveMissedDays({
      windowStart,
      now,
      hireDate: employee.hireDate,
      recordedDates: recorded.map((record) => record.attendanceDate),
      leaves: leaves.map((leave) => ({
        startDate: leave.startDate,
        endDate: leave.endDate,
        leaveTypeName: leave.leaveType.name,
        approved: leave.status === "APPROVED",
      })),
      schedules,
    });

    const recordType: "OFFICE" | "FIELD" = employee.attendanceMode === "FIELD" ? "FIELD" : "OFFICE";
    return missedDays.map((missed) => ({
      id: `${missed.status.toLowerCase()}-${employeeId}-${missed.date.getTime()}`,
      employeeId,
      attendanceDate: missed.date,
      recordType,
      visitNumber: 1,
      workLocationId: null,
      workLocation: null,
      timeInAt: null,
      timeOutAt: null,
      lunchOutAt: null,
      lunchInAt: null,
      status: missed.status,
      leaveTypeName: missed.leaveTypeName ?? null,
      scheduledShift: missed.shift
        ? { name: missed.shift.name ?? null, startTime: missed.shift.startTime, endTime: missed.shift.endTime }
        : null,
      totalMinutes: 0,
      lateMinutes: 0,
      undertimeMinutes: 0,
      overtimeMinutes: 0,
      logs: [],
      hasPhoto: false,
      hasApprovedUndertime: false,
      isSynthetic: true,
    }));
  }

  // Full-resolution photos for one attendance record's logs — fetched lazily
  // by the DTR viewer (mobile/web) only when that record's detail modal is
  // opened. See getHistory() above for why these are excluded from the list.
  async getRecordPhotos(recordId: string) {
    return this.prisma.attendanceLog.findMany({
      where: { attendanceRecordId: recordId },
      select: { id: true, faceImageData: true, faceImageMimeType: true },
    });
  }

  private decodeImageBase64(imageData: string) {
    const base64Data = imageData.includes("base64,") ? imageData.split("base64,")[1] : imageData;
    return Buffer.from(base64Data, "base64");
  }
}
