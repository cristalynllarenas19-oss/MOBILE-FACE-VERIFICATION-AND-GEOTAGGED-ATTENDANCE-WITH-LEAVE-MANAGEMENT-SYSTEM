import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async summary() {
    const today = new Date();
    const attendanceDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());

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
    ]);

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
    };
  }
}
