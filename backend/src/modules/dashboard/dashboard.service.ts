import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(month: number, year: number) {
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
      presentToday,
      lateToday,
      absentToday,
      pendingLeaves,
      geotaggedLogs,
      pendingReview,
      vacationType,
      sickType,
      specialType,
      monthAttendance,
      enrolledEmployees,
      assignedEmployees,
      weekAttendance,
      realMonthAttendance,
    ] = await Promise.all([
      this.prisma.employee.findMany({
        select: { id: true, hireDate: true, department: { select: { name: true } } },
      }),
      this.prisma.attendanceRecord.count({ where: { attendanceDate, status: "PRESENT" } }),
      this.prisma.attendanceRecord.count({ where: { attendanceDate, status: "LATE" } }),
      this.prisma.attendanceRecord.count({ where: { attendanceDate, status: "ABSENT" } }),
      this.prisma.leaveRequest.count({ where: { status: "PENDING" } }),
      this.prisma.attendanceLog.count({ where: { capturedAt: { gte: attendanceDate } } }),
      this.prisma.attendanceLog.count({ where: { verificationStatus: "PENDING_REVIEW" } }),
      this.prisma.leaveType.findUnique({ where: { name: "Vacation Leave" } }),
      this.prisma.leaveType.findUnique({ where: { name: "Sick Leave" } }),
      this.prisma.leaveType.findUnique({ where: { name: "Special Leave" } }),
      this.prisma.attendanceRecord.findMany({
        where: { attendanceDate: { gte: monthStart, lte: monthEnd } },
        include: { employee: { include: { department: true } } },
        orderBy: { attendanceDate: "asc" },
      }),
      this.prisma.faceProfile.findMany({
        where: { enrollmentStatus: "ACTIVE" },
        distinct: ["employeeId"],
        select: { employeeId: true },
      }),
      this.prisma.workLocationEmployee.count(),
      this.prisma.attendanceRecord.findMany({
        where: { attendanceDate: { gte: weekStart, lte: weekEnd } },
        include: { employee: { include: { department: true } } },
      }),
      this.prisma.attendanceRecord.findMany({
        where: { attendanceDate: { gte: realMonthStart, lte: realMonthEnd } },
        include: { employee: { include: { department: true } } },
      }),
    ]);

    const totalEmployees = employees.length;
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const trendMap = new Map<string, { department: string; dayOfWeek: string; absences: number; dates: string[] }>();

    // ── Shared helper: build dept rows from a set of records ────────────────
    function buildDeptRows(
      records: typeof monthAttendance,
      scope: "day" | "week" | "month",
      scopeDate?: Date,
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

      // Count no-shows as absent for a specific day scope
      if (scope === "day" && scopeDate) {
        const isPast = scopeDate < attendanceDate;
        const isToday = scopeDate.toDateString() === attendanceDate.toDateString();
        if (isPast || isToday) {
          const recordedIds = new Set(records.map((r) => r.employeeId));
          for (const emp of employees) {
            if (emp.hireDate <= scopeDate && !recordedIds.has(emp.id)) {
              const row = deptMap.get(emp.department.name);
              if (row) row.absent += 1;
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

      const explicitAbsentees = records.filter((r) => r.status === "ABSENT");
      const recordedEmployeeIds = new Set(records.map((r) => r.employeeId));
      const noShowAbsentees = isPastDate
        ? employees.filter((e) => e.hireDate <= date && !recordedEmployeeIds.has(e.id))
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
        onLeave: records.filter((r) => r.status === "ON_LEAVE").length,
        officialBusiness: records.filter((r) => r.status === "OFFICIAL_BUSINESS").length,
        // Per-department breakdown for the day modal
        departments: buildDeptRows(records, "day", date),
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
      today: buildDeptRows(todayRecords, "day", attendanceDate),
      week:  buildDeptRows(weekAttendance, "week"),
      month: buildDeptRows(realMonthAttendance, "month"),
    };

    return {
      stats: { totalEmployees, presentToday, lateToday, absentToday, pendingLeaves, geotaggedLogs },
      attendanceSummary: { present: presentToday, late: lateToday, pendingReview },
      leaveAvailability: {
        vacation: Number(vacationType?.defaultDays ?? 0),
        sick: Number(sickType?.defaultDays ?? 0),
        special: Number(specialType?.defaultDays ?? 0),
      },
      enrollment: { enrolled: enrolledEmployees.length, total: totalEmployees },
      geotagging: { assigned: assignedEmployees, total: totalEmployees },
      calendar: { monthLabel, days: calendarDays },
      absenceTrends,
      departmentAttendance,
    };
  }
}