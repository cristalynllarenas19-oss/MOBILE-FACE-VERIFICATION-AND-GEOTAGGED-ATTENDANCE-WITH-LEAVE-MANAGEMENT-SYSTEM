// Leave day counts: whole numbers as-is ("7"), anything else to two
// decimals ("11.25", "22.50"). Seasonal accrual credits 1.25 a month, so
// rounding to whole days made each row and the total disagree (11 + 11 = 23).
export function formatDays(days: number) {
  return Number.isInteger(days) ? String(days) : days.toFixed(2);
}
