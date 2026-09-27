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

// Total break minutes deducted from raw elapsed time to get paid
// totalMinutes (see upsertAttendanceRecord). Morning/afternoon breaks are
// always the shift's flat configured amount — there's no punch mechanism for
// either. Lunch instead uses the employee's own measured Lunch Out -> Lunch
// In duration whenever both punches exist, uncapped in either direction: a
// shorter-than-scheduled lunch credits the extra time as worked, and a
// longer one costs the extra time, rather than everyone getting the same
// flat deduction regardless of how long they actually took. Falls back to
// the shift's flat lunchBreakMinutes when the lunch punches are missing or
// incomplete (no Lunch Out, or Lunch Out with no matching Lunch In yet).
export function computeTotalBreakMinutes(
  shift: {
    morningBreakMinutes: number;
    afternoonBreakMinutes: number;
    lunchBreakMinutes: number;
  },
  lunchPunch?: { lunchOutAt: Date | null; lunchInAt: Date | null },
): number {
  const measuredLunch =
    lunchPunch?.lunchOutAt && lunchPunch.lunchInAt
      ? Math.max(0, Math.round((lunchPunch.lunchInAt.getTime() - lunchPunch.lunchOutAt.getTime()) / 60000))
      : null;
  const lunchMinutes = measuredLunch ?? shift.lunchBreakMinutes;
  return shift.morningBreakMinutes + shift.afternoonBreakMinutes + lunchMinutes;
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
