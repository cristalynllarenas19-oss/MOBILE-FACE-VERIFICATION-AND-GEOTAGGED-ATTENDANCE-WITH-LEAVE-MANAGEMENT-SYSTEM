// Semi-monthly cutoff periods used by UndertimeService. Cutoff A runs the
// 11th-25th of a month; Cutoff B runs the 26th of a month through the 10th of
// the next month (crossing the month/year boundary). All dates are truncated
// to local midnight — callers must not rely on time-of-day here.

export type CutoffPeriod = { start: Date; end: Date };

export function getCutoffPeriod(reference: Date): CutoffPeriod {
  const year = reference.getFullYear();
  const month = reference.getMonth();
  const day = reference.getDate();

  if (day >= 11 && day <= 25) {
    return { start: new Date(year, month, 11), end: new Date(year, month, 25) };
  }
  if (day >= 26) {
    // JS Date normalizes month=12 to January of year+1, handling Dec->Jan.
    return { start: new Date(year, month, 26), end: new Date(year, month + 1, 10) };
  }
  // day <= 10: this cutoff started the 26th of the previous month — month=-1
  // normalizes to December of year-1, handling Jan->Dec.
  return { start: new Date(year, month - 1, 26), end: new Date(year, month, 10) };
}

// The cutoff immediately preceding `reference`'s own cutoff — what an
// employee files undertime *for* on a filing day. On the 8th (inside Cutoff
// B), this resolves to the Cutoff A that closed the day before this Cutoff
// B's 26th start; on the 23rd (inside Cutoff A), it resolves to the Cutoff B
// that closed the day before this Cutoff A's 11th start. No special-casing
// between "8" and "23" is needed — walking back one day from the current
// cutoff's start always lands in the correct prior cutoff.
export function getFilingTargetCutoff(reference: Date): CutoffPeriod {
  const current = getCutoffPeriod(reference);
  const dayBeforeStart = new Date(current.start.getFullYear(), current.start.getMonth(), current.start.getDate() - 1);
  return getCutoffPeriod(dayBeforeStart);
}

// Fallback only for a brand-new UndertimeSettings row (see
// UndertimeService) — the admin-editable value lives in the database now,
// not here.
export const DEFAULT_FILING_DAYS_OF_MONTH = [8, 23];

export function isFilingDay(reference: Date, filingDaysOfMonth: number[]): boolean {
  return filingDaysOfMonth.includes(reference.getDate());
}
