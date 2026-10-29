import { isDayOff } from "../../common/utils/schedule.util";

function toLocalMidnight(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export type LapseDecision =
  // The employee came to work on every requested day, so the leave was
  // never needed — lapses as soon as its dates have passed.
  | { lapse: true; reason: "REPORTED_FOR_WORK" }
  // Nobody decided within the grace period after the leave ended.
  | { lapse: true; reason: "NOT_DECIDED" }
  | { lapse: false };

// Whether an undecided leave request (pending, or waiting on the employee to
// resubmit) should lapse as of `now`. Never before the leave's last day has
// fully passed — until then a reviewer can still decide it normally.
export function decideLapse(params: {
  startDate: Date;
  endDate: Date;
  now: Date;
  graceDays: number;
  // Days in the leave range the employee has an attendance record for.
  attendedDates: Date[];
  // When the request was filed. A leave filed after its own dates (Sick
  // Leave for a past absent day) gets its full grace period from the filing
  // day, not from a leave end date that may already be past the grace.
  filedAt?: Date;
}): LapseDecision {
  const today = toLocalMidnight(params.now).getTime();
  const start = toLocalMidnight(params.startDate);
  const end = toLocalMidnight(params.endDate);
  if (end.getTime() >= today) return { lapse: false };

  const attended = new Set(params.attendedDates.map(dateKey));
  const requestedDays: Date[] = [];
  for (let day = start; day.getTime() <= end.getTime(); day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
    if (!isDayOff(day)) requestedDays.push(day);
  }
  if (requestedDays.length > 0 && requestedDays.every((day) => attended.has(dateKey(day)))) {
    return { lapse: true, reason: "REPORTED_FOR_WORK" };
  }

  const filed = params.filedAt ? toLocalMidnight(params.filedAt) : end;
  const graceFrom = filed.getTime() > end.getTime() ? filed : end;
  const graceEnds = new Date(graceFrom.getFullYear(), graceFrom.getMonth(), graceFrom.getDate() + Math.max(0, params.graceDays));
  return graceEnds.getTime() < today ? { lapse: true, reason: "NOT_DECIDED" } : { lapse: false };
}

type LapseReason = "REPORTED_FOR_WORK" | "NOT_DECIDED";

// What the request was waiting on when it lapsed: a reviewer's decision, or
// (NEEDS_REVISION) the employee submitting the requirements asked of them.
function lapseCause(statusBefore: string, addressedToEmployee: boolean): string {
  if (statusBefore === "NEEDS_REVISION") {
    return addressedToEmployee
      ? "the requested requirements were not submitted before the leave dates passed"
      : "The requested requirements were not submitted before the leave dates passed";
  }
  return addressedToEmployee
    ? "it was not decided before the leave dates passed"
    : "Not decided before the leave dates passed";
}

// Shown on the request's timeline, to the employee and reviewers alike.
export function lapseTimelineText(reason: LapseReason, statusBefore: string): string {
  const cause = lapseCause(statusBefore, false);
  return reason === "REPORTED_FOR_WORK"
    ? `${cause}, and work was reported on those dates, so no leave was used.`
    : `${cause}, so the dates are recorded as absent.`;
}

// The tail of the employee's own notification ("Your … request … has lapsed because …").
export function lapseNotificationText(reason: LapseReason, statusBefore: string): string {
  const cause = lapseCause(statusBefore, true);
  return reason === "REPORTED_FOR_WORK"
    ? `${cause} and you reported for work on those dates. No leave was used.`
    : `${cause}. Those dates are recorded as absent.`;
}
