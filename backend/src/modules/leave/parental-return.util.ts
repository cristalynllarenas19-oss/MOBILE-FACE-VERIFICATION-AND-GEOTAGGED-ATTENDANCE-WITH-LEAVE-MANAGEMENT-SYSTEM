import { isNonWorkingDay } from "../../common/utils/schedule.util";

// How many days before a parental leave's last day its reviewers get the
// "ending soon" heads-up. Paternity leave is only about a week long, so a
// week's notice would arrive on its first day.
export const MATERNITY_ENDING_NOTICE_DAYS = 7;
export const PATERNITY_ENDING_NOTICE_DAYS = 3;
// How long after the return day the "back at work" notice may still go out —
// covers a server that was down on the day itself, without sending notices
// for leaves that ended long ago (e.g. the first run after deploying this).
export const PARENTAL_RETURN_CATCH_UP_DAYS = 7;
// The "back at work" notice goes out this many days before the return day,
// so the supervisor and HR/Admin can prepare for it — and again on the
// return day itself.
export const PARENTAL_RETURN_NOTICE_DAYS_BEFORE = 1;
// A Leave Without Pay of at least this many straight calendar days gets the
// "ends tomorrow — a letter follows if you're absent after it" notices.
export const LONG_UNPAID_LEAVE_DAYS = 30;
// The employee's own "your leave ends tomorrow" notice goes out this many
// days before the leave's last day (or on the last day, if that was missed).
export const EMPLOYEE_ENDING_NOTICE_DAYS_BEFORE = 1;
// The most days HR can configure as a Maternity type's unpaid extension
// (LeaveType.extensionDays — 30 by default, per RA 11210). Also bounds how
// far back ParentalReturnService looks for a leave still worth a notice.
export const MATERNITY_EXTENSION_MAX_DAYS = 120;
// The extension has to be asked for at least this many days before the
// Maternity Leave ends (RA 11210) — see LeaveService.getExtensionEligibility.
export const MATERNITY_EXTENSION_NOTICE_DAYS = 45;
// The employee is reminded twice that she can still ask for the extension:
// this many days before the deadline (an early heads-up), and on the
// deadline itself — 45 days before the leave ends, the last day she can ask.
export const MATERNITY_EXTENSION_EARLY_REMINDER_DAYS = 7;

// Far more than any run of rest days and back-to-back leaves — only stops a
// malformed schedule (no working days at all) from looping forever.
const MAX_RETURN_SEARCH_DAYS = 400;

export function toLocalMidnight(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

// The last day the employee is actually away: the request's own end date,
// plus the maternity extension (its leave type's extensionDays) once
// HR/Admin has approved it via LeaveRequest.extensionRequested — approving
// that doesn't move the request's endDate, so the days are added here.
export function lastParentalLeaveDay(endDate: Date, extensionApproved: boolean | null, extensionDays: number): Date {
  const end = toLocalMidnight(endDate);
  return extensionApproved ? addDays(end, extensionDays) : end;
}

export type FollowingLeave = { startDate: Date; endDate: Date; isParental: boolean };

// The first day after `lastLeaveDay` the employee is expected at work: a
// working day on their schedule that no other approved leave covers.
// `continuesAsParental` is set when that search ran through another parental
// leave request — the rest of a leave split by a partial cancellation, or
// Added Paternity Leave taken straight after Paternity Leave. That later
// request is the one actually ending, so it owns the notices.
export function findReturnDay(
  lastLeaveDay: Date,
  workingDaysOn: (date: Date) => number[] | null | undefined,
  followingLeaves: FollowingLeave[],
): { returnDate: Date; continuesAsParental: boolean } {
  let continuesAsParental = false;
  let candidate = addDays(toLocalMidnight(lastLeaveDay), 1);
  for (let step = 0; step < MAX_RETURN_SEARCH_DAYS; step += 1) {
    const time = candidate.getTime();
    const covering = followingLeaves.find(
      (leave) => time >= toLocalMidnight(leave.startDate).getTime() && time <= toLocalMidnight(leave.endDate).getTime(),
    );
    if (covering) {
      if (covering.isParental) continuesAsParental = true;
    } else if (!isNonWorkingDay(candidate, workingDaysOn(candidate))) {
      break;
    }
    candidate = addDays(candidate, 1);
  }
  return { returnDate: candidate, continuesAsParental };
}

export type ParentalNotice =
  // Sent once, within `noticeDays` of the last leave day.
  | { kind: "ENDING"; windowStart: Date }
  // Sent twice: once from PARENTAL_RETURN_NOTICE_DAYS_BEFORE the return day
  // (windowStart = that day), and once from the return day itself
  // (windowStart = the return day, catching up for a few days if missed).
  // daysUntilReturn: 1 = tomorrow, 0 = today, negative = already past.
  | { kind: "RETURN"; windowStart: Date; daysUntilReturn: number };

// Which notice (if any) is due right now. `windowStart` is when the notice's
// window opened: one already sent since then is this same notice, while one
// sent before it was about dates that have since moved (e.g. an extension
// approved after the heads-up went out), so a fresh one is due.
export function parentalNoticeDue(input: {
  startDate: Date;
  lastLeaveDay: Date;
  returnDate: Date;
  noticeDays: number;
  now: Date;
}): ParentalNotice | null {
  const today = toLocalMidnight(input.now).getTime();
  const returnDate = toLocalMidnight(input.returnDate);

  const returnNoticeFrom = addDays(returnDate, -PARENTAL_RETURN_NOTICE_DAYS_BEFORE);
  if (today >= returnNoticeFrom.getTime()) {
    if (today > addDays(returnDate, PARENTAL_RETURN_CATCH_UP_DAYS).getTime()) return null;
    const daysUntilReturn = Math.round((returnDate.getTime() - today) / 86_400_000);
    // Separate windows, so the day-before notice doesn't count as the
    // return-day one.
    return { kind: "RETURN", windowStart: today >= returnDate.getTime() ? returnDate : returnNoticeFrom, daysUntilReturn };
  }

  // Only once the leave is under way — a heads-up about a leave that hasn't
  // started yet would just repeat the approval.
  if (today < toLocalMidnight(input.startDate).getTime()) return null;
  const windowStart = addDays(toLocalMidnight(input.lastLeaveDay), -input.noticeDays);
  if (today < windowStart.getTime()) return null;
  return { kind: "ENDING", windowStart };
}

// Whether the employee's own "your leave ends tomorrow" notice is due: from
// EMPLOYEE_ENDING_NOTICE_DAYS_BEFORE the last leave day through that day,
// once the leave is under way. daysUntilEnd: 1 = tomorrow, 0 = today.
export function employeeEndingNoticeDue(input: {
  startDate: Date;
  lastLeaveDay: Date;
  now: Date;
}): { windowStart: Date; daysUntilEnd: number } | null {
  const today = toLocalMidnight(input.now).getTime();
  const lastLeaveDay = toLocalMidnight(input.lastLeaveDay);
  const windowStart = addDays(lastLeaveDay, -EMPLOYEE_ENDING_NOTICE_DAYS_BEFORE);
  if (today < windowStart.getTime() || today > lastLeaveDay.getTime()) return null;
  if (today < toLocalMidnight(input.startDate).getTime()) return null;
  return { windowStart, daysUntilEnd: Math.round((lastLeaveDay.getTime() - today) / 86_400_000) };
}

// The last day the employee may still ask to extend a Maternity Leave ending
// on `endDate` — same rule as LeaveService.getExtensionEligibility.
export function extensionDeadline(endDate: Date): Date {
  return addDays(toLocalMidnight(endDate), -MATERNITY_EXTENSION_NOTICE_DAYS);
}

// Whether a "request your extension before the deadline" reminder is due,
// and which one: the early one from MATERNITY_EXTENSION_EARLY_REMINDER_DAYS
// before the deadline up to the day before it, or the final one on the
// deadline itself. Each has its own windowStart, so the early one doesn't
// count as the final one. daysLeft: days until the deadline (0 = today).
export function extensionReminderDue(input: {
  endDate: Date;
  now: Date;
}): { deadline: Date; windowStart: Date; daysLeft: number } | null {
  const today = toLocalMidnight(input.now).getTime();
  const deadline = extensionDeadline(input.endDate);
  if (today > deadline.getTime()) return null;
  const earlyFrom = addDays(deadline, -MATERNITY_EXTENSION_EARLY_REMINDER_DAYS);
  if (today < earlyFrom.getTime()) return null;
  const daysLeft = Math.round((deadline.getTime() - today) / 86_400_000);
  return { deadline, windowStart: daysLeft === 0 ? deadline : earlyFrom, daysLeft };
}
