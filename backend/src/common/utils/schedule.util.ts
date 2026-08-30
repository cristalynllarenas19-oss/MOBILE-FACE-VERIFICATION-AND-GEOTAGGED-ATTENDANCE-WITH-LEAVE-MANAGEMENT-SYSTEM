// Sunday is a company-wide rest day for every role (employee, supervisor,
// admin/HR alike) — there is no per-employee/per-shift schedule for this yet,
// so it's enforced as a single global rule rather than per-Shift config.
export function isDayOff(date: Date): boolean {
  return date.getDay() === 0;
}

// A date is non-working for an employee if it falls on the global Sunday
// rest day, OR outside their own schedule's workingDays (e.g. a 6-day-a-week
// Shift's Saturday-off employee, or a part-timer's own override). workingDays
// undefined/null means no active EmployeeSchedule was found for that date —
// treated as working (same "nothing to compare against" rule used elsewhere,
// e.g. attendance.service.ts's isWorkingDay/isPastAbsenceCutoff).
export function isNonWorkingDay(date: Date, workingDays?: number[] | null): boolean {
  if (isDayOff(date)) return true;
  if (!workingDays) return false;
  return !workingDays.includes(date.getDay());
}
