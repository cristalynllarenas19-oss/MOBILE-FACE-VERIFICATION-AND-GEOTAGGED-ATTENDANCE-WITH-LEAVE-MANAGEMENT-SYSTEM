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
// The unpaid extension a Maternity leave may carry (LeaveRequest
// .extensionRequested). Approving it doesn't move the request's endDate, so
// the extra days are counted on top of it here.
export const MATERNITY_EXTENSION_DAYS = 30;

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
// plus the maternity extension once HR/Admin has approved it (only ever set
// on a Maternity request).
export function lastParentalLeaveDay(endDate: Date, extensionApproved: boolean | null): Date {
  const end = toLocalMidnight(endDate);
  return extensionApproved ? addDays(end, MATERNITY_EXTENSION_DAYS) : end;
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
  // Sent once, from the return day itself.
  | { kind: "RETURN"; windowStart: Date; late: boolean };

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

  if (today >= returnDate.getTime()) {
    if (today > addDays(returnDate, PARENTAL_RETURN_CATCH_UP_DAYS).getTime()) return null;
    return { kind: "RETURN", windowStart: returnDate, late: today > returnDate.getTime() };
  }

  // Only once the leave is under way — a heads-up about a leave that hasn't
  // started yet would just repeat the approval.
  if (today < toLocalMidnight(input.startDate).getTime()) return null;
  const windowStart = addDays(toLocalMidnight(input.lastLeaveDay), -input.noticeDays);
  if (today < windowStart.getTime()) return null;
  return { kind: "ENDING", windowStart };
}
