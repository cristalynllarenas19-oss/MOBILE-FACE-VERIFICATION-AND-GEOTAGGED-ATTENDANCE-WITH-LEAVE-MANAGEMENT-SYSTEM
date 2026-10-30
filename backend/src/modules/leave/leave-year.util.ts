import { Prisma } from "@prisma/client";

// A leave year is the stretch between two balance resets. LeaveBalance.year
// holds its name: the calendar year it ENDS in. With the default reset of
// Dec 26, leave year 2026 runs Dec 26, 2025 – Dec 25, 2026, and a leave
// dated Dec 27, 2026 already counts against 2027's fresh balance. Leftover
// days are never carried over — a new leave year simply has new balance rows.
// A reset of Jan 1 makes leave years plain calendar years.
export type LeaveYearReset = { resetMonth: number; resetDay: number };

export const DEFAULT_LEAVE_YEAR_RESET: LeaveYearReset = { resetMonth: 12, resetDay: 26 };

function isJanFirst(reset: LeaveYearReset) {
  return reset.resetMonth === 1 && reset.resetDay === 1;
}

export function leaveYearOf(date: Date, reset: LeaveYearReset): number {
  const year = date.getFullYear();
  if (isJanFirst(reset)) return year;
  const resetThisYear = new Date(year, reset.resetMonth - 1, reset.resetDay);
  const day = new Date(year, date.getMonth(), date.getDate());
  return day >= resetThisYear ? year + 1 : year;
}

// First and last day (local midnight / end of day) of a leave year.
export function leaveYearRange(leaveYear: number, reset: LeaveYearReset) {
  const startYear = isJanFirst(reset) ? leaveYear : leaveYear - 1;
  const start = new Date(startYear, reset.resetMonth - 1, reset.resetDay);
  const nextStart = new Date(startYear + 1, reset.resetMonth - 1, reset.resetDay);
  const end = new Date(nextStart.getFullYear(), nextStart.getMonth(), nextStart.getDate() - 1, 23, 59, 59, 999);
  return { start, end };
}

export async function getLeaveYearReset(prisma: Prisma.TransactionClient): Promise<LeaveYearReset> {
  const settings = await prisma.leaveSettings.findUnique({
    where: { id: "singleton" },
    select: { resetMonth: true, resetDay: true },
  });
  return settings ?? DEFAULT_LEAVE_YEAR_RESET;
}

export async function leaveYearFor(prisma: Prisma.TransactionClient, date: Date) {
  return leaveYearOf(date, await getLeaveYearReset(prisma));
}

export async function currentLeaveYear(prisma: Prisma.TransactionClient) {
  return leaveYearFor(prisma, new Date());
}
