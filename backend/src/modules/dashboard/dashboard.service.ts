import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { dedupeToLatestVisitPerEmployeeDay } from "../attendance/attendance-dedup.util";
import { computeAbsenceCutoff } from "../attendance/attendance-shift.util";
import { isDateWithinLeaveRange } from "../../common/utils/on-leave.util";
import { isDayOff } from "../../common/utils/schedule.util";

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(month: number, year: number, departmentId?: string) {
    const today = new Date();
    const attendanceDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    const monthStart = new Date(year, month, 1);
    const monthEnd = new Date(year, month + 1, 0);

    const dayOfWeek = today.getDay();
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - ((dayOfWeek + 6) % 7));
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const realMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const realMonthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59, 999);

    const [
      employees,
      todayAttendanceRows,
      pendingLeaves,
      geotaggedLogs,
      pendingReview,
      monthAttendanceRaw,
      enrolledEmployees,
      assignedEmployeeRows,
      weekAttendanceRaw,
      realMonthAttendanceRaw,
      monthApprovedLeaves,
    ] = await Promise.all([
      // Archived (SEPARATED) employees don't count toward current headcount —
      // matches the "All Employees" tab on the Employees page, which already
      // excludes them from its count. Every query below is additionally
      // scoped to a Supervisor's own department when departmentId is set
      // (see getSupervisorDepartmentScope) — everything downstream (stats,
      // enrollment, calendar days, department-attendance rows, absence
      // trends) is computed generically from these results, so scoping the
      // inputs here scopes the whole dashboard for free.
      this.prisma.employee.findMany({
        where: { employmentStatus: { not: "SEPARATED" }, ...(departmentId ? { departmentId } : {}) },
        select: { id: true, hireDate: true, departmentId: true, department: { select: { name: true } } },
      }),
      this.prisma.attendanceRecord.findMany({
        where: { attendanceDate, ...(departmentId ? { employee: { departmentId } } : {}) },
        select: { employeeId: true, attendanceDate: true, timeInAt: true, status: true },
      }),
      this.prisma.leaveRequest.count({
        where: { status: "PENDING", ...(departmentId ? { employee: { departmentId } } : {}) },
      }),
      this.prisma.attendanceLog.count({
        where: { capturedAt: { gte: attendanceDate }, ...(departmentId ? { employee: { departmentId } } : {}) },
      }),
      this.prisma.attendanceLog.count({
        where: { verificationStatus: "PENDING_REVIEW", ...(departmentId ? { employee: { departmentId } } : {}) },
      }),
      this.prisma.attendanceRecord.findMany({
        where: {
          attendanceDate: { gte: monthStart, lte: monthEnd },
          ...(departmentId ? { employee: { departmentId } } : {}),
        },
        include: { employee: { include: { department: true } } },
        orderBy: { attendanceDate: "asc" },
      }),
      this.prisma.faceProfile.findMany({
        where: {
          enrollmentStatus: "ACTIVE",
          employee: { employmentStatus: { not: "SEPARATED" }, ...(departmentId ? { departmentId } : {}) },
        },
        distinct: ["employeeId"],
        select: { employeeId: true },
      }),
      // distinct, not count() — a FIELD employee can now have several
      // WorkLocationEmployee rows (one per assigned site), so a raw count
      // would inflate "assigned employees" past the real headcount.
      this.prisma.workLocationEmployee.findMany({
        where: {
          employee: { employmentStatus: { not: "SEPARATED" }, ...(departmentId ? { departmentId } : {}) },
        },
        distinct: ["employeeId"],
        select: { employeeId: true },
      }),
      this.prisma.attendanceRecord.findMany({
        where: {
          attendanceDate: { gte: weekStart, lte: weekEnd },
          ...(departmentId ? { employee: { departmentId } } : {}),
        },
        include: { employee: { include: { department: true } } },
      }),
      this.prisma.attendanceRecord.findMany({
        where: {
          attendanceDate: { gte: realMonthStart, lte: realMonthEnd },
          ...(departmentId ? { employee: { departmentId } } : {}),
        },
        include: { employee: { include: { department: true } } },
      }),
      // Approved leave overlapping the visible month, fetched once so each
      // calendar day can be checked against it in-memory rather than one
      // query per day — AttendanceRecord never gets an ON_LEAVE row of its
      // own (see on-leave.util.ts), so this is the only way to know who's on
      // leave for a given day.
      this.prisma.leaveRequest.findMany({
        where: {
          status: "APPROVED",
          startDate: { lte: monthEnd },
          endDate: { gte: monthStart },
          ...(departmentId ? { employee: { departmentId } } : {}),
        },
        select: { employeeId: true, startDate: true, endDate: true, leaveType: { select: { name: true } } },
      }),
    ]);

    // A FIELD employee can have several visit rows for the same day — collapse
    // each employee+day down to their latest visit before tallying statuses,
    // so multi-visit days aren't counted more than once per employee.
    const dedupedTodayStatus = dedupeToLatestVisitPerEmployeeDay(todayAttendanceRows);
    const presentToday = dedupedTodayStatus.filter((r) => r.status === "PRESENT").length;
    const lateToday = dedupedTodayStatus.filter((r) => r.status === "LATE").length;

    // assignedEmployeeRows and employees are already department-scoped above,
    // so these — like every other stat below — are correct as-is.
    const assignedEmployees = assignedEmployeeRows.length;
    const monthAttendance = dedupeToLatestVisitPerEmployeeDay(monthAttendanceRaw);
    const weekAttendance = dedupeToLatestVisitPerEmployeeDay(weekAttendanceRaw);
    const realMonthAttendance = dedupeToLatestVisitPerEmployeeDay(realMonthAttendanceRaw);

    // Each employee's currently-active schedule, so a no-show can be checked
    // against their own start time + grace period (isPastAbsenceCutoff)
    // instead of being marked Absent the instant the day begins, and against
    // their own working days (isWorkingDayToday) instead of assuming
    // everyone works every non-Sunday day. An employee with no active
    // schedule assignment has nothing to compare against, so they're never
    // no-show-absent — same rule used for today's calendar day and every
    // department breakdown further down.
    const activeSchedules = await this.prisma.employeeSchedule.findMany({
      where: {
        employeeId: { in: employees.map((e) => e.id) },
        startsOn: { lte: today },
        OR: [{ endsOn: null }, { endsOn: { gte: today } }],
      },
      orderBy: { startsOn: "desc" },
      select: {
        employeeId: true,
        workingDays: true,
        shift: { select: { startTime: true, endTime: true, lateThresholdMinutes: true } },
      },
    });
    const activeScheduleByEmployee = new Map<
      string,
      { workingDays: number[]; shift: { startTime: string; endTime: string; lateThresholdMinutes: number } }
    >();
    for (const schedule of activeSchedules) {
      if (!activeScheduleByEmployee.has(schedule.employeeId)) {
        activeScheduleByEmployee.set(schedule.employeeId, schedule);
      }
    }
    function isPastAbsenceCutoff(employeeId: string): boolean {
      const schedule = activeScheduleByEmployee.get(employeeId);
      if (!schedule) return false;
      return today >= computeAbsenceCutoff(schedule.shift, attendanceDate);
    }
    // Sunday is still always off for everyone via isDayOff — this only
    // narrows further, for employees whose own schedule works fewer days
    // than the Mon-Sat default (e.g. a 4-day-a-week arrangement).
    function isWorkingDayToday(employeeId: string): boolean {
      const schedule = activeScheduleByEmployee.get(employeeId);
      if (!schedule) return true;
      return schedule.workingDays.includes(attendanceDate.getDay());
    }

    const totalEmployees = employees.length;
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const trendMap = new Map<string, { department: string; dayOfWeek: string; absences: number; dates: string[] }>();

    // Filters the whole month's approved leaves down to whoever is on leave
    // on one specific day, in memory — avoids one LeaveRequest query per day.
    function leaveMapForDate(date: Date): Map<string, { leaveTypeName: string }> {
      const map = new Map<string, { leaveTypeName: string }>();
      for (const leave of monthApprovedLeaves) {
        if (isDateWithinLeaveRange(date, leave) && !map.has(leave.employeeId)) {
          map.set(leave.employeeId, { leaveTypeName: leave.leaveType.name });
        }
      }
      return map;
    }

    // ── Shared helper: build dept rows from a set of records ────────────────
    function buildDeptRows(
      records: typeof monthAttendance,
      scope: "day" | "week" | "month",
      scopeDate?: Date,
      onLeaveByEmployee: Map<string, { leaveTypeName: string }> = new Map(),
    ) {
      const deptMap = new Map<
        string,
        { department: string; present: number; late: number; absent: number; onLeave: number; officialBusiness: number }
      >();

      for (const emp of employees) {
        const name = emp.department.name;
        if (!deptMap.has(name)) {
          deptMap.set(name, { department: name, present: 0, late: 0, absent: 0, onLeave: 0, officialBusiness: 0 });
        }
      }

      for (const record of records) {
        const name = record.employee.department.name;
        const row = deptMap.get(name);
        if (!row) continue;
        switch (record.status) {
          case "PRESENT":           row.present          += 1; break;
          case "LATE":              row.late             += 1; break;
          case "ABSENT":            row.absent           += 1; break;
          case "ON_LEAVE":          row.onLeave          += 1; break;
          case "OFFICIAL_BUSINESS": row.officialBusiness += 1; break;
        }
      }

      // Count no-shows as absent (or on leave, if covered by an approved
      // LeaveRequest) for a specific day scope.
      if (scope === "day" && scopeDate && !isDayOff(scopeDate)) {
        const isPast = scopeDate < attendanceDate;
        const isToday = scopeDate.toDateString() === attendanceDate.toDateString();
        if (isPast || isToday) {
          const recordedIds = new Set(records.map((r) => r.employeeId));
          for (const emp of employees) {
            if (recordedIds.has(emp.id)) continue;
            const row = deptMap.get(emp.department.name);
            if (!row) continue;
            if (onLeaveByEmployee.has(emp.id)) {
              row.onLeave += 1;
            } else if (
              emp.hireDate <= scopeDate &&
              (isPast || isPastAbsenceCutoff(emp.id)) &&
              (isPast || isWorkingDayToday(emp.id))
            ) {
              row.absent += 1;
            }
          }
        }
      }

      return Array.from(deptMap.values()).sort((a, b) => a.department.localeCompare(b.department));
    }

    // ── Calendar days (now includes per-day dept breakdown) ─────────────────
    const calendarDays = Array.from({ length: monthEnd.getDate() }, (_, index) => {
      const date = new Date(year, month, index + 1);
      const records = monthAttendance.filter((r) => r.attendanceDate.getDate() === index + 1);
      const isPastDate = date < attendanceDate;
      const isTodayDate = date.toDateString() === attendanceDate.toDateString();
      const onLeaveMap = leaveMapForDate(date);

      const explicitAbsentees = records.filter((r) => r.status === "ABSENT");
      const recordedEmployeeIds = new Set(records.map((r) => r.employeeId));
      const noShowAbsentees = (isPastDate || isTodayDate) && !isDayOff(date)
        ? employees.filter(
            (e) =>
              e.hireDate <= date &&
              !recordedEmployeeIds.has(e.id) &&
              !onLeaveMap.has(e.id) &&
              (isPastDate || isPastAbsenceCutoff(e.id)) &&
              (isPastDate || isWorkingDayToday(e.id)),
          )
        : [];
      const onLeaveNoRecord = isPastDate
        ? employees.filter((e) => !recordedEmployeeIds.has(e.id) && onLeaveMap.has(e.id))
        : [];

      const absent = explicitAbsentees.length + noShowAbsentees.length;

      if (absent > 0) {
        const dayOfWeekName = dayNames[date.getDay()];
        const departmentsInvolved = [
          ...explicitAbsentees.map((r) => r.employee.department.name),
          ...noShowAbsentees.map((e) => e.department.name),
        ];
        for (const department of departmentsInvolved) {
          const key = `${department}-${dayOfWeekName}`;
          const current = trendMap.get(key) ?? { department, dayOfWeek: dayOfWeekName, absences: 0, dates: [] };
          current.absences += 1;
          current.dates.push(date.toISOString());
          trendMap.set(key, current);
        }
      }

      return {
        date,
        day: index + 1,
        present: records.filter((r) => r.status === "PRESENT").length,
        late: records.filter((r) => r.status === "LATE").length,
        absent,
        onLeave: records.filter((r) => r.status === "ON_LEAVE").length + onLeaveNoRecord.length,
        officialBusiness: records.filter((r) => r.status === "OFFICIAL_BUSINESS").length,
        // Lets the frontend distinguish a Sunday (company-wide day off) from
        // a day with genuinely no data yet — both otherwise sum to all-zero.
        isDayOff: isDayOff(date),
        // Per-department breakdown for the day modal
        departments: buildDeptRows(records, "day", date, onLeaveMap),
      };
    });

    const absenceTrends = Array.from(trendMap.values())
      .sort((a, b) => b.absences - a.absences)
      .slice(0, 5)
      .map((trend) => ({
        ...trend,
        insight:
          trend.absences >= 3
            ? `${trend.department} has repeated absences on ${trend.dayOfWeek}s this month.`
            : `${trend.department} has ${trend.absences} absence${trend.absences === 1 ? "" : "s"} on ${trend.dayOfWeek}s this month.`,
      }));

    const monthLabel = new Date(year, month, 1).toLocaleString("en-US", {
      month: "long",
      year: "numeric",
    });

    // ── Department attendance for the dashboard chart ────────────────────────
    const todayRecords = monthAttendance.filter(
      (r) => r.attendanceDate.toDateString() === attendanceDate.toDateString(),
    );

    const departmentAttendance = {
      today: buildDeptRows(todayRecords, "day", attendanceDate, leaveMapForDate(attendanceDate)),
      week:  buildDeptRows(weekAttendance, "week"),
      month: buildDeptRows(realMonthAttendance, "month"),
    };

    // Same cutoff-aware count that feeds departmentAttendance.today and
    // today's calendar day, summed — keeps the top stat card, the
    // Attendance Breakdown donut, and the department panel all in agreement
    // instead of the stat card only counting formally-recorded ABSENT rows.
    const absentToday = departmentAttendance.today.reduce((sum, row) => sum + row.absent, 0);

    return {
      stats: { totalEmployees, presentToday, lateToday, absentToday, pendingLeaves, geotaggedLogs },
      attendanceSummary: { present: presentToday, late: lateToday, pendingReview },
      enrollment: { enrolled: enrolledEmployees.length, total: totalEmployees },
      geotagging: { assigned: assignedEmployees, total: totalEmployees },
      calendar: { monthLabel, days: calendarDays },
      absenceTrends,
      departmentAttendance,
    };
  }
}