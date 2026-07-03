import { PrismaService } from "../../prisma/prisma.service";

function toLocalMidnight(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

// Same date-only overlap rule the DB query below uses, exposed separately so
// callers that already hold a batch of LeaveRequests in memory (e.g. one
// month's worth, fetched once) can filter per-day without a query per day.
export function isDateWithinLeaveRange(date: Date, leave: { startDate: Date; endDate: Date }): boolean {
  const d = toLocalMidnight(date).getTime();
  return d >= toLocalMidnight(leave.startDate).getTime() && d <= toLocalMidnight(leave.endDate).getTime();
}

// AttendanceRecord has no "on leave" row of its own — a day an employee is on
// approved leave simply has no attendance record at all, same as a genuine
// no-show absence. This is the single shared definition of "on leave for day
// X" so the dashboard's day-level counts and the attendance list's synthetic
// rows never disagree with each other.
export async function getApprovedLeaveByEmployee(
  prisma: PrismaService,
  employeeIds: string[],
  date: Date,
): Promise<Map<string, { leaveTypeName: string }>> {
  const result = new Map<string, { leaveTypeName: string }>();
  if (employeeIds.length === 0) return result;

  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayEnd = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);

  const leaveRequests = await prisma.leaveRequest.findMany({
    where: {
      employeeId: { in: employeeIds },
      status: "APPROVED",
      startDate: { lte: dayEnd },
      endDate: { gte: dayStart },
    },
    include: { leaveType: { select: { name: true } } },
  });

  for (const request of leaveRequests) {
    if (!result.has(request.employeeId)) {
      result.set(request.employeeId, { leaveTypeName: request.leaveType.name });
    }
  }

  return result;
}
