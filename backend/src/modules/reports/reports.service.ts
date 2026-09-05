import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { dedupeToLatestVisitPerEmployeeDay } from "../attendance/attendance-dedup.util";
import { computeAbsenceCutoff } from "../attendance/attendance-shift.util";
import { getApprovedLeaveByEmployee } from "../../common/utils/on-leave.util";
import { isDayOff } from "../../common/utils/schedule.util";

type ReportFilters = {
  from?: string;
  to?: string;
  department?: string;
  // Forced scope for a department-restricted Supervisor — ANDed with the
  // name-based `department` filter above (a supervisor's own department
  // dropdown selection can never widen past their forced departmentId).
  departmentId?: string;
};

// Parses a "YYYY-MM-DD" filter into a local-midnight Date — same rationale as
// AttendanceService's own parseLocalDate: `new Date(string)` parses as UTC
// midnight and would shift the day boundary (and therefore which single day
// qualifies for Absent/On-Leave reconstruction below) on any server not
// running in the UTC timezone.
function parseLocalDate(value: string, endOfDay = false): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return new Date(value);
  const [, year, month, day] = match;
  return endOfDay
    ? new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 59, 999)
    : new Date(Number(year), Number(month) - 1, Number(day));
}

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(filters: ReportFilters = {}) {
    const today = new Date();
    const monthStart = filters.from ? parseLocalDate(filters.from) : new Date(today.getFullYear(), today.getMonth(), 1);
    const endDate = filters.to
      ? parseLocalDate(filters.to, true)
      : new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999);
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

    const [attendanceRecords, leaves, schedules, employees, leaveTypes, leaveBalanceRows, approvedLeaveRequests] = await Promise.all([
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

    // Absent/On-Leave never get a real AttendanceRecord row (see
    // on-leave.util.ts), so the raw query above only ever contains
    // Present/Late/Official Business rows. When the filtered range collapses
    // to exactly one day, reconstruct the missing Absent/On-Leave rows for
    // that day the same way AttendanceService.findAll() already does for
    // Attendance Management's own single-day view — a genuine multi-day
    // range keeps that file's same pre-existing limitation and shows only
    // real recorded rows, since Absent/On-Leave can't be reconstructed
    // per-day across a range without a much larger rewrite.
    const singleDay =
      monthStart.toDateString() === new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate()).toDateString()
        ? monthStart
        : undefined;

    const syntheticRows: any[] = [];
    if (singleDay) {
      const activeEmployees = employees.filter((e) => e.employmentStatus !== "SEPARATED");
      const recordedEmployeeIds = new Set(
        attendanceRecords
          .filter((r) => r.attendanceDate.toDateString() === singleDay.toDateString())
          .map((r) => r.employeeId),
      );
      const onLeaveByEmployee = await getApprovedLeaveByEmployee(
        this.prisma,
        activeEmployees.map((e) => e.id),
        singleDay,
      );
      // Whichever schedule was actually active for each employee on
      // singleDay — the already-fetched `schedules` (ordered startsOn desc)
      // covers this without a separate query, same "first match wins" rule
      // used everywhere else this pattern appears.
      const scheduleByEmployee = new Map<string, (typeof schedules)[number]>();
      for (const schedule of schedules) {
        if (scheduleByEmployee.has(schedule.employeeId)) continue;
        if (schedule.startsOn > singleDay) continue;
        if (schedule.endsOn && schedule.endsOn < singleDay) continue;
        scheduleByEmployee.set(schedule.employeeId, schedule);
      }
      const now = new Date();

      for (const employee of activeEmployees) {
        if (recordedEmployeeIds.has(employee.id)) continue;
        const onLeave = onLeaveByEmployee.get(employee.id);
        const base = {
          id: `${onLeave ? "leave" : "absent"}-${employee.id}-${singleDay.toDateString()}`,
          attendanceDate: singleDay,
          employeeId: employee.id,
          totalMinutes: 0,
          lateMinutes: 0,
          timeInAt: null,
          timeOutAt: null,
          lunchOutAt: null,
          lunchInAt: null,
          workLocation: null,
          employee: { firstName: employee.firstName, lastName: employee.lastName, department: employee.department },
        };

        if (onLeave) {
          syntheticRows.push({ ...base, status: "ON_LEAVE" });
          continue;
        }

        const schedule = scheduleByEmployee.get(employee.id);
        const isWorkingDay = schedule ? schedule.workingDays.includes(singleDay.getDay()) : true;
        const isPastCutoff = schedule ? now >= computeAbsenceCutoff(schedule.shift, singleDay) : false;
        if (!isDayOff(singleDay) && employee.hireDate <= singleDay && isWorkingDay && isPastCutoff) {
          syntheticRows.push({ ...base, status: "ABSENT" });
        }
      }
    }
    const attendance = [...attendanceRecords, ...syntheticRows];

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
