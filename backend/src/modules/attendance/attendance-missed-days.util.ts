import { isNonWorkingDay } from "../../common/utils/schedule.util";
import { isDateWithinLeaveRange } from "../../common/utils/on-leave.util";
import { computeAbsenceCutoff } from "./attendance-shift.util";

// A day with no AttendanceRecord never gets a row of its own — neither a
// no-show nor a day on approved leave. This works out which of those days,
// for one employee, should still appear in their DTR, using the same rules
// AttendanceService.findAll() applies when it reconstructs a single day for
// Attendance Management:
// - on approved leave -> ON_LEAVE, carrying the leave type's name;
// - on a leave still awaiting a decision -> LEAVE_PENDING (not yet a leave
//   day, but not an unexplained absence either);
// - otherwise ABSENT, but only on a day they were actually scheduled to
//   work (an employee with no schedule that day has nothing to be absent
//   from), on or after their hire date, and — for today — only once their
//   shift's absence cutoff has passed.
// Days that aren't working days (Sunday, or outside the schedule's
// workingDays) produce nothing, even inside a leave range.

export type MissedDaySchedule = {
  startsOn: Date;
  endsOn: Date | null;
  workingDays: number[];
  shift: { name?: string; startTime: string; endTime: string; lateThresholdMinutes: number };
};

export type MissedDay = {
  date: Date;
  status: "ABSENT" | "ON_LEAVE" | "LEAVE_PENDING";
  leaveTypeName?: string;
  // The shift the employee was scheduled for that day, when they had one.
  shift?: { name?: string; startTime: string; endTime: string };
};

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function toLocalMidnight(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function resolveMissedDays(params: {
  windowStart: Date;
  now: Date;
  hireDate: Date;
  recordedDates: Date[];
  // approved: false for a request still awaiting a decision.
  leaves: { startDate: Date; endDate: Date; leaveTypeName: string; approved: boolean }[];
  // Newest first — the first one covering a day wins, same as everywhere
  // else an employee's active schedule is resolved.
  schedules: MissedDaySchedule[];
}): MissedDay[] {
  const { now, leaves, schedules } = params;
  const today = toLocalMidnight(now);
  const hireDay = toLocalMidnight(params.hireDate);
  const recorded = new Set(params.recordedDates.map(dateKey));
  const missed: MissedDay[] = [];

  for (
    let day = toLocalMidnight(params.windowStart);
    day.getTime() <= today.getTime();
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
  ) {
    if (recorded.has(dateKey(day)) || day.getTime() < hireDay.getTime()) continue;

    const schedule = schedules.find(
      (s) =>
        toLocalMidnight(s.startsOn).getTime() <= day.getTime() &&
        (!s.endsOn || toLocalMidnight(s.endsOn).getTime() >= day.getTime()),
    );
    if (isNonWorkingDay(day, schedule?.workingDays)) continue;

    const covering = leaves.filter((l) => isDateWithinLeaveRange(day, l));
    const leave = covering.find((l) => l.approved) ?? covering[0];
    if (leave) {
      missed.push({
        date: day,
        status: leave.approved ? "ON_LEAVE" : "LEAVE_PENDING",
        leaveTypeName: leave.leaveTypeName,
        ...(schedule ? { shift: schedule.shift } : {}),
      });
      continue;
    }

    if (!schedule) continue;
    const isToday = day.getTime() === today.getTime();
    if (isToday && now.getTime() < computeAbsenceCutoff(schedule.shift, day).getTime()) continue;
    missed.push({ date: day, status: "ABSENT", shift: schedule.shift });
  }

  return missed;
}
