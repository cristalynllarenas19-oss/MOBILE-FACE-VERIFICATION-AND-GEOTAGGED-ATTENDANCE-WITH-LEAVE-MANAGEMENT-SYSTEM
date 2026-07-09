import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { dedupeToLatestVisitPerEmployeeDay } from "../attendance/attendance-dedup.util";

type ReportFilters = {
  from?: string;
  to?: string;
  department?: string;
  // Forced scope for a department-restricted Supervisor — ANDed with the
  // name-based `department` filter above (a supervisor's own department
  // dropdown selection can never widen past their forced departmentId).
  departmentId?: string;
};

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(filters: ReportFilters = {}) {
    const today = new Date();
    const monthStart = filters.from ? new Date(filters.from) : new Date(today.getFullYear(), today.getMonth(), 1);
    const endDate = filters.to ? new Date(filters.to) : today;
    endDate.setHours(23, 59, 59, 999);
    const employeeWhere: { departmentId?: string; department?: { name: string } } = {};
    if (filters.departmentId) {
      employeeWhere.departmentId = filters.departmentId;
    }
    if (filters.department && filters.department !== "ALL") {
      employeeWhere.department = { name: filters.department };
    }
    const departmentWhere = Object.keys(employeeWhere).length ? { employee: employeeWhere } : {};
    // Leave balances/used-dates are a point-in-time snapshot, not bounded by
    // the from/to range — they're keyed by calendar year, taken from the
    // "to" filter (defaulting to the current year) same as the Leave page.
    const balanceYear = endDate.getFullYear();

    const [attendance, leaves, schedules, employees, leaveTypes, leaveBalanceRows, approvedLeaveRequests] = await Promise.all([
      this.prisma.attendanceRecord.findMany({
        where: { attendanceDate: { gte: monthStart, lte: endDate }, ...departmentWhere },
        include: { employee: { include: { department: true } }, workLocation: true },
        orderBy: { attendanceDate: "desc" },
      }),
      this.prisma.leaveRequest.findMany({
        where: { startDate: { gte: monthStart, lte: endDate }, ...departmentWhere },
        include: { employee: { include: { department: true } }, leaveType: true },
        orderBy: { startDate: "desc" },
      }),
      this.prisma.employeeSchedule.findMany({
        where: departmentWhere,
        include: { employee: { include: { department: true, position: true } }, shift: true },
        orderBy: { startsOn: "desc" },
      }),
      this.prisma.employee.findMany({
        where: employeeWhere,
        include: { department: true },
        orderBy: { lastName: "asc" },
      }),
      this.prisma.leaveType.findMany(),
      this.prisma.leaveBalance.findMany({
        where: { year: balanceYear, ...departmentWhere },
      }),
      // Only a final "APPROVED" status ever touches LeaveBalance.usedDays
      // (see leave.service.ts adjustLeaveBalance) — mirroring that status
      // here keeps the "dates used" list consistent with the usedDays totals.
      this.prisma.leaveRequest.findMany({
        where: {
          status: "APPROVED",
          startDate: { gte: new Date(balanceYear, 0, 1), lte: new Date(balanceYear, 11, 31, 23, 59, 59, 999) },
          ...departmentWhere,
        },
        select: { employeeId: true, leaveTypeId: true, startDate: true, endDate: true },
      }),
    ]);

    const balanceKey = (employeeId: string, leaveTypeId: string) => `${employeeId}:${leaveTypeId}`;
    const balanceMap = new Map(leaveBalanceRows.map((b) => [balanceKey(b.employeeId, b.leaveTypeId), b]));
    const usedDatesMap = new Map<string, { startDate: Date; endDate: Date }[]>();
    for (const request of approvedLeaveRequests) {
      const key = balanceKey(request.employeeId, request.leaveTypeId);
      const list = usedDatesMap.get(key) ?? [];
      list.push({ startDate: request.startDate, endDate: request.endDate });
      usedDatesMap.set(key, list);
    }

    // One row per employee per leave type applicable to their employment
    // status — mirrors leave-balances.service.ts's findForEmployee, batched
    // across every employee in scope instead of just one.
    const leaveBalances = employees.flatMap((employee) =>
      leaveTypes
        .filter((leaveType) => leaveType.applicableStatuses.includes(employee.employmentStatus))
        .map((leaveType) => {
          const balance = balanceMap.get(balanceKey(employee.id, leaveType.id));
          const earnedDays = balance ? Number(balance.earnedDays) : leaveType.requiresAdminGrant ? 0 : Number(leaveType.defaultDays);
          const usedDays = balance ? Number(balance.usedDays) : 0;
          return {
            employeeId: employee.id,
            employee: {
              firstName: employee.firstName,
              lastName: employee.lastName,
              sex: employee.sex,
              department: employee.department,
            },
            leaveTypeId: leaveType.id,
            leaveTypeName: leaveType.name,
            year: balanceYear,
            earnedDays,
            usedDays,
            remainingDays: Math.max(0, earnedDays - usedDays),
            usedDates: usedDatesMap.get(balanceKey(employee.id, leaveType.id)) ?? [],
          };
        })
        .filter((row) => !(row.earnedDays <= 0 && row.usedDays <= 0)),
    );

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
      employees,
      leaveBalances,
    };
  }
}
