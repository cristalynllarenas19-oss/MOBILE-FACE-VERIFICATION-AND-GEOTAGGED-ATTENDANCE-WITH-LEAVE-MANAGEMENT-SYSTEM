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

const EXPECTED_WORK_MS = 9 * 60 * 60000; // 8 hours of work plus the 1-hour lunch break

// The time an employee should time out to complete a full 8-hour workday,
// given their effective (rounded) start time — 9 hours later so the 1-hour
// lunch break doesn't eat into the 8 hours actually worked.
export function computeExpectedTimeOut(renderTimeIn: Date): Date {
  return new Date(renderTimeIn.getTime() + EXPECTED_WORK_MS);
}

export function computeMinutesUndertime(
  shift: ShiftTimeFields & { undertimeThresholdMinutes: number },
  departureTime: Date,
  attendanceDate: Date,
): number {
  const shiftEnd = parseTimeOnDate(attendanceDate, shift.endTime);
  const cutoff = new Date(shiftEnd.getTime() - shift.undertimeThresholdMinutes * 60000);
  return Math.max(0, Math.round((cutoff.getTime() - departureTime.getTime()) / 60000));
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
