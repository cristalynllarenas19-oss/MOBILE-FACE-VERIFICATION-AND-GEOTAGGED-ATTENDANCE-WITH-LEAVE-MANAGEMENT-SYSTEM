import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { dedupeToLatestVisitPerEmployeeDay } from "../attendance/attendance-dedup.util";

type ReportFilters = {
  from?: string;
  to?: string;
  department?: string;
};

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(filters: ReportFilters = {}) {
    const today = new Date();
    const monthStart = filters.from ? new Date(filters.from) : new Date(today.getFullYear(), today.getMonth(), 1);
    const endDate = filters.to ? new Date(filters.to) : today;
    endDate.setHours(23, 59, 59, 999);
    const departmentWhere =
      filters.department && filters.department !== "ALL"
        ? { employee: { department: { name: filters.department } } }
        : {};

    const [attendance, leaves, schedules] = await Promise.all([
      this.prisma.attendanceRecord.findMany({
        where: { attendanceDate: { gte: monthStart, lte: endDate }, ...departmentWhere },
        include: { employee: { include: { department: true } } },
        orderBy: { attendanceDate: "desc" },
      }),
      this.prisma.leaveRequest.findMany({
        where: { startDate: { gte: monthStart, lte: endDate }, ...departmentWhere },
        include: { employee: { include: { department: true } }, leaveType: true },
        orderBy: { startDate: "desc" },
      }),
      this.prisma.employeeSchedule.findMany({
        where: departmentWhere,
        include: { employee: { include: { department: true } }, shift: true },
        orderBy: { startsOn: "desc" },
      }),
    ]);

    // Status tallies count employees, not visits — a FIELD employee's
    // several same-day visit rows are collapsed to their latest one first.
    // Row-level data below (attendance.length, the attendance array itself,
    // hours/CSV export) intentionally stays one row per visit.
    const attendanceByStatus = dedupeToLatestVisitPerEmployeeDay(attendance).reduce<Record<string, number>>(
      (totals, record) => {
        totals[record.status] = (totals[record.status] ?? 0) + 1;
        return totals;
      },
      {},
    );

    const leaveByStatus = leaves.reduce<Record<string, number>>((totals, request) => {
      totals[request.status] = (totals[request.status] ?? 0) + 1;
      return totals;
    }, {});

    return {
      generatedAt: today,
      monthStart,
      attendanceByStatus,
      leaveByStatus,
      totals: {
        attendanceRecords: attendance.length,
        approvedLeaves: leaves.filter((request) => request.status === "APPROVED").length,
        pendingLeaves: leaves.filter((request) => request.status === "PENDING").length,
        activeSchedules: schedules.filter((schedule) => !schedule.endsOn || schedule.endsOn >= today).length,
      },
      attendance,
      leaves,
      schedules,
    };
  }
}
