import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async summary() {
    const today = new Date();
    const attendanceDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);

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
    ]);

    const totalEmployees = employees.length;
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const trendMap = new Map<string, { department: string; dayOfWeek: string; absences: number; dates: string[] }>();

    const calendarDays = Array.from({ length: monthEnd.getDate() }, (_, index) => {
      const date = new Date(today.getFullYear(), today.getMonth(), index + 1);
      const records = monthAttendance.filter((record) => record.attendanceDate.getDate() === index + 1);
      const isPastDate = date < attendanceDate;

      const explicitAbsentees = records.filter((record) => record.status === "ABSENT");
      // Employees with no attendance record at all for a past date never clocked in/out,
      // so they count as absent even though no row was ever created for them.
      const recordedEmployeeIds = new Set(records.map((record) => record.employeeId));
      const noShowAbsentees = isPastDate
        ? employees.filter((employee) => employee.hireDate <= date && !recordedEmployeeIds.has(employee.id))
        : [];

      const absent = explicitAbsentees.length + noShowAbsentees.length;

      if (absent > 0) {
        const dayOfWeek = dayNames[date.getDay()];
        const departmentsInvolved = [
          ...explicitAbsentees.map((record) => record.employee.department.name),
          ...noShowAbsentees.map((employee) => employee.department.name),
        ];
        for (const department of departmentsInvolved) {
          const key = `${department}-${dayOfWeek}`;
          const current = trendMap.get(key) ?? { department, dayOfWeek, absences: 0, dates: [] };
          current.absences += 1;
          current.dates.push(date.toISOString());
          trendMap.set(key, current);
        }
      }

      return {
        date,
        day: index + 1,
        present: records.filter((record) => record.status === "PRESENT").length,
        late: records.filter((record) => record.status === "LATE").length,
        absent,
        onLeave: records.filter((record) => record.status === "ON_LEAVE").length,
        officialBusiness: records.filter((record) => record.status === "OFFICIAL_BUSINESS").length,
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

    return {
      stats: {
        totalEmployees,
        presentToday,
        lateToday,
        absentToday,
        pendingLeaves,
        geotaggedLogs,
      },
      attendanceSummary: {
        present: presentToday,
        late: lateToday,
        pendingReview,
      },
      leaveAvailability: {
        vacation: Number(vacationType?.defaultDays ?? 0),
        sick: Number(sickType?.defaultDays ?? 0),
        special: Number(specialType?.defaultDays ?? 0),
      },
      enrollment: {
        enrolled: enrolledEmployees.length,
        total: totalEmployees,
      },
      geotagging: {
        assigned: assignedEmployees,
        total: totalEmployees,
      },
      calendar: {
        monthLabel: today.toLocaleString("en-US", { month: "long", year: "numeric" }),
        days: calendarDays,
      },
      absenceTrends,
    };
  }
}
