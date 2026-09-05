import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AuditLogContext, AuditLogsService } from "../audit-logs/audit-logs.service";
import { getFilingTargetCutoff, isFilingDay } from "../../common/utils/cutoff.util";

type UndertimeStatus = "PENDING" | "APPROVED" | "REJECTED";

function toDateOnly(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

@Injectable()
export class UndertimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  // Admin-editable filing days (default 8th/23rd) — lazily creates the
  // singleton row on first access rather than requiring a seed.
  async getSettings() {
    return this.prisma.undertimeSettings.upsert({
      where: { id: "singleton" },
      update: {},
      create: { id: "singleton" },
    });
  }

  async updateSettings(filingDaysOfMonth: number[], context: AuditLogContext = {}) {
    const days = Array.from(new Set(filingDaysOfMonth)).sort((a, b) => a - b);
    if (days.length === 0) {
      throw new BadRequestException("At least one filing day is required.");
    }
    if (days.some((day) => !Number.isInteger(day) || day < 1 || day > 31)) {
      throw new BadRequestException("Filing days must be whole numbers between 1 and 31.");
    }

    const existing = await this.getSettings();

    const settings = await this.prisma.undertimeSettings.update({
      where: { id: "singleton" },
      data: { filingDaysOfMonth: days, updatedBy: context.actorUserId },
    });

    await this.auditLogs.record({
      ...context,
      action: "UPDATE_UNDERTIME_SETTINGS",
      module: "Leave",
      entityType: "UndertimeSettings",
      entityId: settings.id,
      description: `Updated undertime filing days to the ${days.join(" and ")} of the month.`,
      oldValues: { filingDaysOfMonth: existing.filingDaysOfMonth },
      newValues: { filingDaysOfMonth: days },
    });

    return settings;
  }

  // Tells the frontend whether filing is currently allowed, which cutoff it
  // would file for, which late AttendanceRecords are pickable, and whether a
  // filing already exists for that cutoff — the UI never has to hardcode the
  // filing days or the 1-per-cutoff cap, it just reflects whatever this returns.
  async getEligibility(employeeId: string) {
    const today = new Date();
    const { filingDaysOfMonth } = await this.getSettings();
    const todayIsFilingDay = isFilingDay(today, filingDaysOfMonth);
    const targetCutoff = getFilingTargetCutoff(today);

    const existingFiling = await this.prisma.undertimeFiling.findUnique({
      where: { employeeId_cutoffStart: { employeeId, cutoffStart: targetCutoff.start } },
      include: { attendanceRecord: true },
    });

    // Only surfaced when there's no existing filing for this cutoff yet — once
    // filed, the client shows the filing's status instead of a picker.
    const lateRecords = existingFiling
      ? []
      : await this.prisma.attendanceRecord.findMany({
          where: {
            employeeId,
            attendanceDate: { gte: targetCutoff.start, lte: targetCutoff.end },
            lateMinutes: { gt: 0 },
          },
          orderBy: { attendanceDate: "asc" },
        });

    return {
      isFilingDay: todayIsFilingDay,
      filingDaysOfMonth,
      targetCutoff,
      lateRecords,
      existingFiling,
      eligible: todayIsFilingDay && !existingFiling && lateRecords.length > 0,
    };
  }

  async file(employeeId: string, attendanceRecordId: string, reason: string, context: AuditLogContext = {}) {
    const trimmedReason = reason?.trim();
    if (!trimmedReason) {
      throw new BadRequestException("A reason is required to file undertime.");
    }

    const today = new Date();
    const { filingDaysOfMonth } = await this.getSettings();

    if (!isFilingDay(today, filingDaysOfMonth)) {
      throw new BadRequestException(
        `Undertime can only be filed on the ${filingDaysOfMonth.join(" or ")} of the month.`,
      );
    }

    const targetCutoff = getFilingTargetCutoff(today);

    const attendanceRecord = await this.prisma.attendanceRecord.findUnique({
      where: { id: attendanceRecordId },
    });
    if (!attendanceRecord || attendanceRecord.employeeId !== employeeId) {
      throw new BadRequestException("Attendance record not found.");
    }
    if (attendanceRecord.lateMinutes <= 0) {
      throw new BadRequestException("Only a late attendance record can be filed for undertime.");
    }
    if (attendanceRecord.attendanceDate < targetCutoff.start || attendanceRecord.attendanceDate > targetCutoff.end) {
      throw new BadRequestException("This attendance record is outside the current filing cutoff.");
    }

    const existingFiling = await this.prisma.undertimeFiling.findUnique({
      where: { employeeId_cutoffStart: { employeeId, cutoffStart: targetCutoff.start } },
    });
    if (existingFiling) {
      throw new BadRequestException("You have already filed undertime for this cutoff.");
    }

    const filing = await this.prisma.undertimeFiling.create({
      data: {
        employeeId,
        filingDate: toDateOnly(today),
        attendanceRecordId,
        cutoffStart: targetCutoff.start,
        cutoffEnd: targetCutoff.end,
        reason: trimmedReason,
      },
      include: {
        // omit profilePhotoData — a base64 blob this response never uses;
        // inlining it here has caused payload-size problems elsewhere in
        // this codebase (see the DTR list endpoint).
        employee: { include: { supervisor: true, department: true }, omit: { profilePhotoData: true } },
        attendanceRecord: true,
      },
    });

    await this.notifySubmission(filing);

    await this.auditLogs.record({
      ...context,
      action: "CREATE_UNDERTIME_FILING",
      module: "Leave",
      entityType: "UndertimeFiling",
      entityId: filing.id,
      description: `${filing.employee.firstName} ${filing.employee.lastName} filed undertime for ${filing.attendanceRecord.attendanceDate.toLocaleDateString()}.`,
      newValues: { employeeId, attendanceRecordId, cutoffStart: targetCutoff.start, cutoffEnd: targetCutoff.end, status: filing.status },
    });

    return filing;
  }

  // Routing mirrors LeaveService.notifySubmission: a regular employee's
  // filing goes to their direct supervisor; a supervisor's own filing has no
  // supervisor above them, so it routes to HR/Admin instead.
  private async notifySubmission(filing: {
    id: string;
    employee: { userId: string | null; firstName: string; lastName: string; supervisor: { userId: string | null } | null };
    attendanceRecord: { attendanceDate: Date };
  }) {
    const filerIsSupervisor = await this.notifications.userHasRole(filing.employee.userId, "SUPERVISOR");
    const candidateIds = filerIsSupervisor
      ? await this.notifications.adminUserIds()
      : [filing.employee.supervisor?.userId];
    const recipientIds = candidateIds.filter((id): id is string => Boolean(id) && id !== filing.employee.userId);

    const employeeName = `${filing.employee.firstName} ${filing.employee.lastName}`;

    await this.notifications.notifyUsers(recipientIds, {
      title: "New Undertime Filing",
      message: `${employeeName} filed undertime for ${filing.attendanceRecord.attendanceDate.toLocaleDateString()}.`,
      type: "UNDERTIME_SUBMITTED",
      entityId: filing.id,
    });
  }

  // Mirrors LeaveService.updateStatus's two guards exactly: a Supervisor may
  // only manage filings from their own department, and never their own.
  async updateStatus(
    id: string,
    status: Extract<UndertimeStatus, "APPROVED" | "REJECTED">,
    remarks: string | undefined,
    context: AuditLogContext = {},
    scopeDepartmentId?: string,
    selfReviewEmployeeId?: string,
  ) {
    const existing = await this.prisma.undertimeFiling.findUniqueOrThrow({
      where: { id },
      include: { employee: { select: { departmentId: true } } },
    });

    if (scopeDepartmentId && existing.employee.departmentId !== scopeDepartmentId) {
      throw new ForbiddenException("You can only manage undertime filings from your own department.");
    }
    if (selfReviewEmployeeId && existing.employeeId === selfReviewEmployeeId) {
      throw new ForbiddenException("You cannot approve or reject your own undertime filing — HR must review it.");
    }

    const trimmedRemarks = remarks?.trim();

    const filing = await this.prisma.undertimeFiling.update({
      where: { id },
      data: { status, reviewedAt: new Date(), reviewedBy: context.actorUserId, remarks: trimmedRemarks || undefined },
      include: { employee: { omit: { profilePhotoData: true } }, attendanceRecord: true },
    });

    if (filing.employee.userId) {
      await this.notifications.notifyUsers([filing.employee.userId], {
        title: status === "APPROVED" ? "Undertime Filing Approved" : "Undertime Filing Rejected",
        message: `Your undertime filing for ${filing.attendanceRecord.attendanceDate.toLocaleDateString()} was ${status === "APPROVED" ? "approved" : "rejected"}.${trimmedRemarks ? ` Remarks: ${trimmedRemarks}` : ""}`,
        type: status === "APPROVED" ? "UNDERTIME_APPROVED" : "UNDERTIME_REJECTED",
        entityId: filing.id,
      });
    }

    await this.auditLogs.record({
      ...context,
      action: status === "APPROVED" ? "APPROVE_UNDERTIME" : "REJECT_UNDERTIME",
      module: "Leave",
      entityType: "UndertimeFiling",
      entityId: id,
      description: `${status === "APPROVED" ? "Approved" : "Rejected"} ${filing.employee.firstName} ${filing.employee.lastName}'s undertime filing for ${filing.attendanceRecord.attendanceDate.toLocaleDateString()}.`,
      oldValues: { status: existing.status },
      newValues: { remarks: trimmedRemarks, status },
    });

    return filing;
  }

  async findAll(employeeId?: string, departmentId?: string) {
    return this.prisma.undertimeFiling.findMany({
      where: {
        ...(employeeId ? { employeeId } : {}),
        ...(departmentId ? { employee: { departmentId } } : {}),
      },
      include: {
        employee: { select: { id: true, firstName: true, lastName: true, department: { select: { name: true } } } },
        attendanceRecord: true,
        reviewer: { include: { employee: { select: { firstName: true, lastName: true } } } },
      },
      orderBy: { filingDate: "desc" },
    });
  }
}
