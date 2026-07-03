// Helpers for resolving late/undertime status against a Shift template's
// "HH:mm" start/end times. All computations are anchored to the day's
// attendanceDate (local midnight), mirroring the day-boundary care already
// taken by parseLocalDate in attendance.service.ts.

type ShiftTimeFields = {
  startTime: string;
  endTime: string;
  gracePeriodMinutes: number;
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

export function computeMinutesLate(shift: ShiftTimeFields, arrivalTime: Date, attendanceDate: Date): number {
  const cutoff = new Date(parseTimeOnDate(attendanceDate, shift.startTime).getTime() + shift.gracePeriodMinutes * 60000);
  return Math.max(0, Math.round((arrivalTime.getTime() - cutoff.getTime()) / 60000));
}

export function computeMinutesUndertime(
  shift: ShiftTimeFields & { undertimeThresholdMinutes: number | null },
  departureTime: Date,
  attendanceDate: Date,
): number {
  const shiftEnd = parseTimeOnDate(attendanceDate, shift.endTime);
  const cutoff = new Date(shiftEnd.getTime() - (shift.undertimeThresholdMinutes ?? 0) * 60000);
  return Math.max(0, Math.round((cutoff.getTime() - departureTime.getTime()) / 60000));
}

// Used by auto-shift-adjustment: among other active shifts whose own
// start+grace window covers the actual arrival time, picks the one with the
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
    const cutoff = start + candidate.gracePeriodMinutes * 60000;
    const arrival = arrivalTime.getTime();
    if (arrival >= start && arrival <= cutoff && (bestStart === null || start > bestStart)) {
      best = candidate;
      bestStart = start;
    }
  }

  return best;
}
