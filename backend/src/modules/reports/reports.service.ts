import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { dedupeToLatestVisitPerEmployeeDay } from "../attendance/attendance-dedup.util";
import { computeAbsenceCutoff, resolveBreakKind } from "../attendance/attendance-shift.util";
import { getApprovedLeaveByEmployee } from "../../common/utils/on-leave.util";
import { isDayOff } from "../../common/utils/schedule.util";
import { LeaveMonetizationService } from "../leave/leave-monetization.service";
import { getLeaveYearReset, leaveYearOf, leaveYearRange } from "../leave/leave-year.util";

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly leaveMonetizationService: LeaveMonetizationService,
  ) {}

  async summary(filters: ReportFilters = {}) {
    const today = new Date();
    const monthStart = filters.from ? parseLocalDate(filters.from) : new Date(today.getFullYear(), today.getMonth(), 1);
    const endDate = filters.to
      ? parseLocalDate(filters.to, true)
      : new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999);
    const isSingleDayReport = monthStart.toDateString() === endDate.toDateString();
    const employeeWhere: { departmentId?: string; department?: { name: string } } = {};
    if (filters.departmentId) {
      employeeWhere.departmentId = filters.departmentId;
    }
    if (filters.department && filters.department !== "ALL") {
      employeeWhere.department = { name: filters.department };
    }
    const departmentWhere = Object.keys(employeeWhere).length ? { employee: employeeWhere } : {};
    // Leave balances/used-dates are a point-in-time snapshot, not bounded by
    // the from/to range — they're keyed by leave year (see
    // leave-year.util.ts), taken from the "to" filter (defaulting to today).
    const leaveYearReset = await getLeaveYearReset(this.prisma);
    const balanceYear = leaveYearOf(endDate, leaveYearReset);
    const balanceYearRange = leaveYearRange(balanceYear, leaveYearReset);

    // No base64 blobs anywhere in this report (profile photos repeated on
    // every row, leave attachments) — neither Reports screen (admin-web or
    // mobile) shows them, and they made the response many times larger.
    const employeeWithoutPhoto = { omit: { profilePhotoData: true } } as const;

    const [attendanceRecords, leaves, schedules, employees, leaveTypes, leaveBalanceRows, approvedLeaveRequests] = await Promise.all([
      this.prisma.attendanceRecord.findMany({
        where: { attendanceDate: { gte: monthStart, lte: endDate }, ...departmentWhere },
        include: {
          employee: { ...employeeWithoutPhoto, include: { department: true } },
          workLocation: true,
          shift: { select: { startTime: true, endTime: true, lateThresholdMinutes: true, lunchBreakMinutes: true, breakStartTime: true, breakKind: true } },
        },
        orderBy: { attendanceDate: "desc" },
      }),
      this.prisma.leaveRequest.findMany({
        // Any leave overlapping the range, including one that began before it.
        // A single-day report also carries the leave history up to that day.
        where: {
          startDate: { lte: endDate },
          ...(isSingleDayReport ? {} : { endDate: { gte: monthStart } }),
          ...departmentWhere,
        },
        omit: { attachmentData: true },
        include: { employee: { ...employeeWithoutPhoto, include: { department: true } }, leaveType: true },
        orderBy: { startDate: "desc" },
      }),
      this.prisma.employeeSchedule.findMany({
        where: departmentWhere,
        include: { employee: { ...employeeWithoutPhoto, include: { department: true, position: true } }, shift: true },
        orderBy: { startsOn: "desc" },
      }),
      this.prisma.employee.findMany({
        where: employeeWhere,
        omit: { profilePhotoData: true },
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
      // A Maternity Leave extension (without pay) never counts toward usedDays.
      this.prisma.leaveRequest.findMany({
        where: {
          status: "APPROVED",
          extensionOfId: null,
          startDate: { gte: balanceYearRange.start, lte: balanceYearRange.end },
          ...departmentWhere,
        },
        select: { employeeId: true, leaveTypeId: true, startDate: true, endDate: true },
      }),
    ]);

    // Absent/On-Leave never get a real AttendanceRecord row (see
    // on-leave.util.ts), so the raw query above only ever contains
    // Present/Late rows. When the filtered range collapses
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
    const attendance = [
      ...attendanceRecords.map(({ shift, ...record }) => ({ ...record, breakKind: resolveBreakKind(shift) })),
      ...syntheticRows,
    ];

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

    // Undertime filings, placed by the day the undertime happened (the
    // attendance record they were filed against) rather than the later date
    // they were filed on — same date range and department scope as the rest.
    const undertime = await this.prisma.undertimeFiling.findMany({
      where: { attendanceRecord: { attendanceDate: { gte: monthStart, lte: endDate } }, ...departmentWhere },
      select: {
        id: true,
        filingDate: true,
        reason: true,
        status: true,
        remarks: true,
        reviewedAt: true,
        employee: { select: { firstName: true, lastName: true, department: { select: { name: true } } } },
        attendanceRecord: { select: { attendanceDate: true, lateMinutes: true, undertimeMinutes: true } },
        reviewer: { select: { email: true, employee: { select: { firstName: true, lastName: true } } } },
      },
      orderBy: { filingDate: "desc" },
    });

    // Same rows as Leave → VL Monetization (paid and still due), for the same
    // leave year as the balances above — a snapshot like Remaining Leave, not
    // bounded by the from/to range.
    const vlMonetizations = (await this.leaveMonetizationService.listForReport(balanceYear, filters.departmentId))
      .filter((row) => !filters.department || filters.department === "ALL" || row.department === filters.department)
      .map((row) => ({
        id: `${row.employeeId}:${row.leaveTypeId}`,
        year: row.year,
        remainingDays: row.remainingDays,
        pendingDays: row.pendingDays,
        toMonetizeDays: row.toMonetizeDays,
        monetizedDays: row.monetizedDays,
        monetizedAt: row.monetizedAt,
        leaveType: { name: row.leaveTypeName },
        employee: {
          firstName: row.firstName,
          lastName: row.lastName,
          sex: row.sex,
          department: row.department ? { name: row.department } : null,
        },
      }));

    // Permanent Seasonal accrual, one summary row per employee like Leave →
    // Accrual History. Follows the same dates as the Leave report: a single-day
    // report carries the history up to that day, a range the periods touching it.
    const accrualRecords = await this.prisma.leaveAccrualRecord.findMany({
      where: {
        employee: { ...employeeWhere, employmentStatus: "PERMANENT_SEASONAL" },
        cycleStart: { lte: endDate },
        ...(isSingleDayReport ? {} : { cycleEnd: { gte: monthStart } }),
      },
      select: {
        employeeId: true,
        cycleStart: true,
        cycleEnd: true,
        outcome: true,
        sickLeaveEarned: true,
        vacationLeaveEarned: true,
        employee: { select: { firstName: true, lastName: true, sex: true, department: { select: { name: true } } } },
      },
    });
    const accrualByEmployee = new Map<
      string,
      {
        employeeId: string;
        employee: (typeof accrualRecords)[number]["employee"];
        periodStart: Date;
        periodEnd: Date;
        absences: number;
        sickLeaveEarned: number;
        vacationLeaveEarned: number;
      }
    >();
    for (const record of accrualRecords) {
      const summary = accrualByEmployee.get(record.employeeId) ?? {
        employeeId: record.employeeId,
        employee: record.employee,
        periodStart: record.cycleStart,
        periodEnd: record.cycleEnd,
        absences: 0,
        sickLeaveEarned: 0,
        vacationLeaveEarned: 0,
      };
      if (record.cycleStart < summary.periodStart) summary.periodStart = record.cycleStart;
      if (record.cycleEnd > summary.periodEnd) summary.periodEnd = record.cycleEnd;
      if (record.outcome === "VIOLATED") summary.absences += 1;
      summary.sickLeaveEarned += Number(record.sickLeaveEarned);
      summary.vacationLeaveEarned += Number(record.vacationLeaveEarned);
      accrualByEmployee.set(record.employeeId, summary);
    }
    const leaveAccruals = Array.from(accrualByEmployee.values());

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
      undertime,
      schedules,
      employees,
      leaveBalances,
      vlMonetizations,
      leaveAccruals,
    };
  }
}
