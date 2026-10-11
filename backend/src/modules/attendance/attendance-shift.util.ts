// Helpers for resolving late/undertime status against a Shift template's
// "HH:mm" start/end times. All computations are anchored to the day's
// attendanceDate (local midnight), mirroring the day-boundary care already
// taken by parseLocalDate in attendance.service.ts.

type ShiftTimeFields = {
  startTime: string;
  endTime: string;
  lateThresholdMinutes: number;
};

function parseTimeOnDate(attendanceDate: Date, hhmm: string): Date {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return new Date(
    attendanceDate.getFullYear(),
    attendanceDate.getMonth(),
    attendanceDate.getDate(),
    hours,
    minutes,
    0,
    0,
  );
}

export function roundToInterval(date: Date, intervalMinutes: number): Date {
  if (!intervalMinutes || intervalMinutes <= 1) return date;
  const intervalMs = intervalMinutes * 60000;
  return new Date(Math.round(date.getTime() / intervalMs) * intervalMs);
}

// The moment an employee is considered genuinely absent for a shift: start
// time plus the shift's own late grace period. Shared by lateness math below
// and by the dashboard/attendance no-show checks, which shouldn't mark
// someone Absent before this moment has actually passed.
export function computeAbsenceCutoff(shift: ShiftTimeFields, attendanceDate: Date): Date {
  return new Date(parseTimeOnDate(attendanceDate, shift.startTime).getTime() + shift.lateThresholdMinutes * 60000);
}

function timeToMinutes(hhmm: string): number {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return hours * 60 + minutes;
}

// Resolves a shift's end time on the given attendanceDate, rolling over to
// the next calendar day when the shift crosses midnight (e.g. a 22:00-07:00
// shift's end is only literally "07:00" on the day AFTER the employee
// clocked in). Without this, both undertime and overtime math would compare
// against an end-of-day moment nearly 24h away from the real one for any
// overnight shift.
function resolveShiftEndOnDate(shift: ShiftTimeFields, attendanceDate: Date): Date {
  const end = parseTimeOnDate(attendanceDate, shift.endTime);
  const crossesMidnight = timeToMinutes(shift.endTime) <= timeToMinutes(shift.startTime);
  return crossesMidnight ? new Date(end.getTime() + 24 * 60 * 60000) : end;
}

// A shift's full scheduled span in minutes, start to end — e.g. 540 for an
// 08:00-17:00 shift (9 hours: 8 worked + 1 break). Rolls over midnight the
// same way resolveShiftEndOnDate does, so an overnight shift like 22:00-07:00
// still comes out to 540 rather than a negative number.
export function computeShiftSpanMinutes(shift: ShiftTimeFields): number {
  const startMinutes = timeToMinutes(shift.startTime);
  const endMinutes = timeToMinutes(shift.endTime);
  return endMinutes <= startMinutes ? endMinutes + 24 * 60 - startMinutes : endMinutes - startMinutes;
}

// breakStartTime ("HH:mm") and breakKind are stored per shift (see the
// Shift model). Both are optional here only so a shift saved before those
// columns existed still resolves, through the same defaults a new shift is
// saved with — see defaultBreakStartTime / defaultBreakKind.
type ShiftBreakFields = ShiftTimeFields & {
  lunchBreakMinutes: number;
  breakStartTime?: string | null;
  breakKind?: string | null;
};

// LUNCH when the break falls around midday; BREAK on any shift where it
// doesn't (night/evening shifts), where calling it "lunch" would be wrong.
// Clients label their Start/End buttons from this.
export type ShiftBreakKind = "LUNCH" | "BREAK";

export type ShiftBreakWindow = { start: Date; end: Date; kind: ShiftBreakKind };

export function shiftCrossesMidnight(shift: Pick<ShiftTimeFields, "startTime" | "endTime">): boolean {
  return timeToMinutes(shift.endTime) <= timeToMinutes(shift.startTime);
}

function minutesToTime(totalMinutes: number): string {
  const minutes = ((totalMinutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

const DEFAULT_HOURS_WORKED_BEFORE_BREAK = 4;
const LUNCH_EARLIEST_HOUR = 10;
const LUNCH_LATEST_HOUR = 15;

// What a shift's break is saved as when the admin doesn't choose one: the
// shift's 5th hour — 12:00 on an 08:00 start, 02:00 on a 22:00 start.
export function defaultBreakStartTime(startTime: string): string {
  return minutesToTime(timeToMinutes(startTime) + DEFAULT_HOURS_WORKED_BEFORE_BREAK * 60);
}

// What a break is called when the admin doesn't choose: lunch if it starts
// around midday, a plain break otherwise.
export function defaultBreakKind(breakStartTime: string): ShiftBreakKind {
  const hour = Math.floor(timeToMinutes(breakStartTime) / 60);
  return hour >= LUNCH_EARLIEST_HOUR && hour < LUNCH_LATEST_HOUR ? "LUNCH" : "BREAK";
}

// The shift's single scheduled break on a given attendanceDate, from its
// stored breakStartTime and lunchBreakMinutes. A break time earlier in the
// day than the shift's start belongs to the after-midnight half of an
// overnight shift. Null when the shift has no break configured or the break
// doesn't fit inside the shift.
export function resolveBreakWindow(shift: ShiftBreakFields, attendanceDate: Date): ShiftBreakWindow | null {
  const durationMs = shift.lunchBreakMinutes * 60000;
  if (durationMs <= 0) return null;

  const shiftStart = parseTimeOnDate(attendanceDate, shift.startTime).getTime();
  const shiftEnd = resolveShiftEndOnDate(shift, attendanceDate).getTime();
  const breakStartTime = shift.breakStartTime || defaultBreakStartTime(shift.startTime);

  let start = parseTimeOnDate(attendanceDate, breakStartTime).getTime();
  if (start < shiftStart) start += 24 * 60 * 60000;
  const end = start + durationMs;
  if (end > shiftEnd) return null;

  const kind: ShiftBreakKind =
    shift.breakStartTime && (shift.breakKind === "LUNCH" || shift.breakKind === "BREAK")
      ? shift.breakKind
      : defaultBreakKind(breakStartTime);
  return { start: new Date(start), end: new Date(end), kind };
}

export function resolveBreakKind(shift: ShiftBreakFields | null | undefined): ShiftBreakKind {
  if (!shift) return "LUNCH";
  return resolveBreakWindow(shift, new Date(2000, 0, 1))?.kind ?? "LUNCH";
}

// ── Overnight shifts ─────────────────────────────────────────────────────
// A shift that crosses midnight is one working day filed under the calendar
// date it STARTED on, so a scan made after midnight has to be matched back
// to the previous day's record rather than opening a new one for "today".

function previousDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1);
}

// True while `now` still falls inside the overnight shift that started on
// the previous calendar day (e.g. 1:00 AM during a 22:00-07:00 shift).
export function isInsidePreviousDayShift(shift: ShiftTimeFields, now: Date): boolean {
  if (!shiftCrossesMidnight(shift)) return false;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return now.getTime() < resolveShiftEndOnDate(shift, previousDay(today)).getTime();
}

// Whether `now` falls inside one of this person's scheduled shifts: today's,
// or — for an overnight shift — the one that began yesterday and is still
// running. The shift's start day has to be one of their working days.
export function isOnShiftAt(
  shift: Pick<ShiftTimeFields, "startTime" | "endTime">,
  workingDays: number[],
  now: Date,
): boolean {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const fullShift = { ...shift, lateThresholdMinutes: 0 };
  return [today, previousDay(today)].some((day) => {
    if (!workingDays.includes(day.getDay())) return false;
    const start = parseTimeOnDate(day, shift.startTime).getTime();
    const end = resolveShiftEndOnDate(fullShift, day).getTime();
    return now.getTime() >= start && now.getTime() < end;
  });
}

// Whether a still-open record of an overnight shift that started on
// `recordDate` can still take a break punch or Time Out at `now`. It stays
// open past the shift's end (overtime, or a late time out) until the moment
// that is closer to the next shift's start than to this shift's end — from
// then on a scan is the next day's Time In instead.
export function canContinueOvernightRecord(shift: ShiftTimeFields, recordDate: Date, now: Date): boolean {
  if (!shiftCrossesMidnight(shift)) return false;
  const shiftEnd = resolveShiftEndOnDate(shift, recordDate).getTime();
  const nextShiftStart = parseTimeOnDate(recordDate, shift.startTime).getTime() + 24 * 60 * 60000;
  return now.getTime() < (shiftEnd + nextShiftStart) / 2;
}

// Break minutes deducted from raw elapsed time to get totalMinutes (see
// upsertAttendanceRecord). Only time the employee was actually on the clock
// for is deducted:
// - both punches: the measured Start -> End duration, uncapped either way;
// - Start only (never ended): the scheduled length, but never more than the
//   time between that Start punch and Time Out;
// - no punches: however much of the scheduled window (see
//   resolveBreakWindow) falls between the effective Time In and Time Out —
//   zero for someone who timed out before it began or timed in after it
//   ended.
export function computeBreakMinutes(
  shift: ShiftBreakFields,
  attendanceDate: Date,
  workStart: Date,
  timeOut: Date,
  breakPunch?: { lunchOutAt: Date | null; lunchInAt: Date | null },
): number {
  const minutesBetween = (from: number, to: number) => Math.max(0, Math.round((to - from) / 60000));

  if (breakPunch?.lunchOutAt && breakPunch.lunchInAt) {
    return minutesBetween(breakPunch.lunchOutAt.getTime(), breakPunch.lunchInAt.getTime());
  }
  if (breakPunch?.lunchOutAt) {
    return Math.min(shift.lunchBreakMinutes, minutesBetween(breakPunch.lunchOutAt.getTime(), timeOut.getTime()));
  }

  const window = resolveBreakWindow(shift, attendanceDate);
  if (!window) return 0;
  return minutesBetween(
    Math.max(window.start.getTime(), workStart.getTime()),
    Math.min(window.end.getTime(), timeOut.getTime()),
  );
}

export function computeMinutesLate(shift: ShiftTimeFields, arrivalTime: Date, attendanceDate: Date): number {
  const cutoff = computeAbsenceCutoff(shift, attendanceDate);
  return Math.max(0, Math.round((arrivalTime.getTime() - cutoff.getTime()) / 60000));
}

const RENDER_INTERVAL_MS = 30 * 60000;

// The effective time-in used for totalMinutes math: any arrival after shift
// start is bumped up to the next 30-minute mark past shift start, so e.g. a
// 7:01 arrival renders as 7:30, a 7:31 arrival renders as 8:00, and (no
// matter how late) a 13:38 arrival renders as 14:00. Arriving exactly on a
// half-hour mark (or at/before shift start) needs no bump. This applies
// unconditionally — being past the shift's late-threshold grace period
// still marks the employee LATE (see computeMinutesLate), it just doesn't
// change how the render/official start time itself is rounded.
export function computeRenderTimeIn(shift: ShiftTimeFields, arrivalTime: Date, attendanceDate: Date): Date {
  const shiftStart = parseTimeOnDate(attendanceDate, shift.startTime);
  // Compared at minute granularity, not raw milliseconds: shiftStart always
  // lands exactly on the minute (see parseTimeOnDate), but arrivalTime is a
  // real capture instant with seconds attached, and every time-in display
  // truncates those seconds away. Without this truncation here, an arrival
  // like 10:00:05 — shown everywhere as "10:00 AM", same as a 10:00 shift
  // start — would still count as 5s after shiftStart and get bumped a full
  // interval to 10:30, reading as a mismatch against the Time In shown right
  // next to it.
  const arrivalMinute = new Date(arrivalTime);
  arrivalMinute.setSeconds(0, 0);
  if (arrivalMinute.getTime() <= shiftStart.getTime()) return shiftStart;

  const elapsedMs = arrivalMinute.getTime() - shiftStart.getTime();
  const roundedMs = Math.ceil(elapsedMs / RENDER_INTERVAL_MS) * RENDER_INTERVAL_MS;
  return new Date(shiftStart.getTime() + roundedMs);
}

// Fallback used only when no shift could be resolved for a record (e.g. no
// active EmployeeSchedule) — same flat assumption the whole app used to make
// unconditionally.
const FALLBACK_EXPECTED_WORK_MS = 9 * 60 * 60000;

// The time an employee is expected to time out to complete a full workday,
// given their effective (rounded) start time and their actual shift's own
// scheduled span (start to end, break included) — a 9-hour 08:00-17:00 shift
// expects a 9-hour render span same as any other, but this now varies
// correctly per shift instead of assuming every shift is 9 hours flat.
export function computeExpectedTimeOut(renderTimeIn: Date, shift?: ShiftTimeFields): Date {
  const spanMs = shift ? computeShiftSpanMinutes(shift) * 60000 : FALLBACK_EXPECTED_WORK_MS;
  return new Date(renderTimeIn.getTime() + spanMs);
}

export function computeMinutesUndertime(
  shift: ShiftTimeFields & { undertimeThresholdMinutes: number },
  departureTime: Date,
  attendanceDate: Date,
): number {
  const shiftEnd = resolveShiftEndOnDate(shift, attendanceDate);
  const cutoff = new Date(shiftEnd.getTime() - shift.undertimeThresholdMinutes * 60000);
  return Math.max(0, Math.round((cutoff.getTime() - departureTime.getTime()) / 60000));
}

// Overtime's counterpart to computeMinutesUndertime: minutes clocked out past
// the shift's scheduled end time, floored at 0. No grace threshold, unlike
// undertime — every minute worked past the scheduled end counts.
export function computeMinutesOvertime(
  shift: ShiftTimeFields,
  departureTime: Date,
  attendanceDate: Date,
): number {
  const shiftEnd = resolveShiftEndOnDate(shift, attendanceDate);
  return Math.max(0, Math.round((departureTime.getTime() - shiftEnd.getTime()) / 60000));
}

// Used by auto-shift-adjustment: among other active shifts whose own
// start+late-threshold window covers the actual arrival time, picks the one with the
// latest start time (closest match to the actual arrival) rather than the
// earliest, since an earlier-starting shift would tolerate the lateness by
// coincidence rather than actually describing when the employee arrived.
export function findBestMatchingShift<T extends ShiftTimeFields & { id: string }>(
  candidates: T[],
  arrivalTime: Date,
  attendanceDate: Date,
): T | null {
  let best: T | null = null;
  let bestStart: number | null = null;

  for (const candidate of candidates) {
    const start = parseTimeOnDate(attendanceDate, candidate.startTime).getTime();
    const cutoff = start + candidate.lateThresholdMinutes * 60000;
    const arrival = arrivalTime.getTime();
    if (arrival >= start && arrival <= cutoff && (bestStart === null || start > bestStart)) {
      best = candidate;
      bestStart = start;
    }
  }

  return best;
}
