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
      totalEmployees,
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
    ] = await Promise.all([
      this.prisma.employee.count(),
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
    ]);

    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const calendarDays = Array.from({ length: monthEnd.getDate() }, (_, index) => {
      const date = new Date(today.getFullYear(), today.getMonth(), index + 1);
      const records = monthAttendance.filter((record) => record.attendanceDate.getDate() === index + 1);
      return {
        date,
        day: index + 1,
        present: records.filter((record) => record.status === "PRESENT").length,
        late: records.filter((record) => record.status === "LATE").length,
        absent: records.filter((record) => record.status === "ABSENT").length,
        onLeave: records.filter((record) => record.status === "ON_LEAVE").length,
        officialBusiness: records.filter((record) => record.status === "OFFICIAL_BUSINESS").length,
      };
    });

    const trendMap = new Map<string, { department: string; dayOfWeek: string; absences: number; dates: string[] }>();
    for (const record of monthAttendance) {
      if (record.status !== "ABSENT") continue;
      const department = record.employee.department.name;
      const dayOfWeek = dayNames[record.attendanceDate.getDay()];
      const key = `${department}-${dayOfWeek}`;
      const current = trendMap.get(key) ?? { department, dayOfWeek, absences: 0, dates: [] };
      current.absences += 1;
      current.dates.push(record.attendanceDate.toISOString());
      trendMap.set(key, current);
    }

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
      calendar: {
        monthLabel: today.toLocaleString("en-US", { month: "long", year: "numeric" }),
        days: calendarDays,
      },
      absenceTrends,
    };
  }
}
