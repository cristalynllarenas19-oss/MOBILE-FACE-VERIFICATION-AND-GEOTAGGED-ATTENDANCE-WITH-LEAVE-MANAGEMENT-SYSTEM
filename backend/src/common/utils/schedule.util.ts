// Sunday is a company-wide rest day for every role (employee, supervisor,
// admin/HR alike) — there is no per-employee/per-shift schedule for this yet,
// so it's enforced as a single global rule rather than per-Shift config.
export function isDayOff(date: Date): boolean {
  return date.getDay() === 0;
}
