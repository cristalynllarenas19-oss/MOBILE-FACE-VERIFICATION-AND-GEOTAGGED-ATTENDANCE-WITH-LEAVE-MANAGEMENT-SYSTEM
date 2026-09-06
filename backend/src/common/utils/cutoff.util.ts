// Semi-monthly cutoff periods used by UndertimeService. The two periods'
// start/end days are admin-configurable (see UndertimeSettings); the
// defaults below keep the historical shape — Cutoff 1 runs the 11th-25th of
// a month, Cutoff 2 runs the 26th of a month through the 10th of the next
// month (crossing the month/year boundary). All dates are truncated to
// local midnight — callers must not rely on time-of-day here.

export type CutoffPeriod = { start: Date; end: Date };

export type CutoffBounds = {
  cutoff1Start: number;
  cutoff1End: number;
  cutoff2Start: number;
  cutoff2End: number;
};

export const DEFAULT_CUTOFF_BOUNDS: CutoffBounds = {
  cutoff1Start: 11,
  cutoff1End: 25,
  cutoff2Start: 26,
  cutoff2End: 10,
};

// A configured day (e.g. 31) doesn't exist in every month (e.g. February) —
// clamp to that month's actual last day rather than letting the JS Date
// constructor silently roll the date over into the following month.
function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function boundedDate(year: number, month: number, day: number): Date {
  return new Date(year, month, Math.min(day, daysInMonth(year, month)));
}

export function getCutoffPeriod(reference: Date, bounds: CutoffBounds = DEFAULT_CUTOFF_BOUNDS): CutoffPeriod {
  const { cutoff1Start, cutoff1End, cutoff2Start, cutoff2End } = bounds;
  const year = reference.getFullYear();
  const month = reference.getMonth();
  const day = reference.getDate();

  if (day >= cutoff1Start && day <= cutoff1End) {
    return { start: boundedDate(year, month, cutoff1Start), end: boundedDate(year, month, cutoff1End) };
  }
  if (day >= cutoff2Start) {
    // JS Date normalizes month=12 to January of year+1, handling Dec->Jan.
    return { start: boundedDate(year, month, cutoff2Start), end: boundedDate(year, month + 1, cutoff2End) };
  }
  // day <= cutoff2End: this cutoff started on cutoff2Start of the previous
  // month — month=-1 normalizes to December of year-1, handling Jan->Dec.
  return { start: boundedDate(year, month - 1, cutoff2Start), end: boundedDate(year, month, cutoff2End) };
}

// The cutoff immediately preceding `reference`'s own cutoff — what an
// employee files undertime *for* on a filing day. On the 8th (inside Cutoff
// B), this resolves to the Cutoff A that closed the day before this Cutoff
// B's start; on the 23rd (inside Cutoff A), it resolves to the Cutoff B that
// closed the day before this Cutoff A's start. No special-casing between
// "8" and "23" is needed — walking back one day from the current cutoff's
// start always lands in the correct prior cutoff.
export function getFilingTargetCutoff(reference: Date, bounds: CutoffBounds = DEFAULT_CUTOFF_BOUNDS): CutoffPeriod {
  const current = getCutoffPeriod(reference, bounds);
  const dayBeforeStart = new Date(current.start.getFullYear(), current.start.getMonth(), current.start.getDate() - 1);
  return getCutoffPeriod(dayBeforeStart, bounds);
}

// Fallback only for a brand-new UndertimeSettings row (see
// UndertimeService) — the admin-editable value lives in the database now,
// not here.
export const DEFAULT_FILING_DAYS_OF_MONTH = [8, 23];

export function isFilingDay(reference: Date, filingDaysOfMonth: number[]): boolean {
  return filingDaysOfMonth.includes(reference.getDate());
}

// Validates that the two cutoffs partition every day of the month exactly
// once: Cutoff 1 must not wrap, and Cutoff 2 must start the day after
// Cutoff 1 ends and end the day before Cutoff 1 begins (wrapping into the
// next month). Without this, some days would match zero or both cutoffs
// when classifying attendance records — returns null when valid, else a
// user-facing message describing the problem.
export function validateCutoffBounds(bounds: CutoffBounds): string | null {
  const { cutoff1Start, cutoff1End, cutoff2Start, cutoff2End } = bounds;
  const days = [cutoff1Start, cutoff1End, cutoff2Start, cutoff2End];
  if (days.some((day) => !Number.isInteger(day) || day < 1 || day > 31)) {
    return "Cutoff days must be whole numbers between 1 and 31.";
  }
  if (cutoff1Start > cutoff1End) {
    return "Cutoff 1's start day must not be after its end day.";
  }
  if (cutoff1End + 1 !== cutoff2Start) {
    return "Cutoff 2 must start the day after Cutoff 1 ends.";
  }
  if (cutoff2End + 1 !== cutoff1Start) {
    return "Cutoff 2 must end the day before Cutoff 1 begins.";
  }
  return null;
}
