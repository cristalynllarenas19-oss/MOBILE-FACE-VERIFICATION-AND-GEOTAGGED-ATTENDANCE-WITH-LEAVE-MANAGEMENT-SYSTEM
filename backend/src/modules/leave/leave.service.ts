import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AuditLogContext, AuditLogsService } from "../audit-logs/audit-logs.service";
import { CreateLeaveRequestDto } from "./dto/create-leave-request.dto";

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
type LeaveRequestStatus = "PENDING" | "SUPERVISOR_APPROVED" | "APPROVED" | "REJECTED" | "CANCELLED";

@Injectable()
export class LeaveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async findAll(employeeId?: string, departmentId?: string) {
    const requests = await this.prisma.leaveRequest.findMany({
      where: {
        ...(employeeId ? { employeeId } : {}),
        ...(departmentId ? { employee: { departmentId } } : {}),
      },
      include: {
        employee: { include: { department: true } },
        leaveType: true,
        reviewer: { include: { employee: true } },
      },
      orderBy: { startDate: "desc" },
    });

    const remarks = await this.prisma.auditLog.findMany({
      where: { entityType: "LeaveRequest", entityId: { in: requests.map((request) => request.id) } },
      orderBy: { createdAt: "desc" },
    });

    return requests.map((request) => ({
      ...request,
      adminRemarks: remarks.find((remark) => remark.entityId === request.id)?.newValues,
    }));
  }

  async create(dto: CreateLeaveRequestDto, context: AuditLogContext = {}) {
    if (dto.attachmentData && Buffer.byteLength(dto.attachmentData, "base64") > MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException("Attachment must be 5MB or smaller.");
    }

    const leaveType = await this.prisma.leaveType.findUniqueOrThrow({ where: { id: dto.leaveTypeId } });

    // The 30-day unpaid extension only makes sense for Maternity Leave — a
    // crafted request against any other leave type is silently ignored
    // rather than trusted, even though the frontend already gates this.
    const extensionRequested = Boolean(dto.extensionRequested) && leaveType.name === "Maternity Leave";

    const request = await this.prisma.leaveRequest.create({
      data: {
        employeeId: dto.employeeId,
        leaveTypeId: dto.leaveTypeId,
        startDate: new Date(dto.startDate),
        endDate: new Date(dto.endDate),
        totalDays: dto.totalDays,
        reason: dto.reason,
        attachmentName: dto.attachmentName,
        attachmentMimeType: dto.attachmentMimeType,
        attachmentData: dto.attachmentData,
        extensionRequested,
      },
      include: {
        employee: { include: { supervisor: true, department: true } },
        leaveType: true,
      },
    });

    await this.notifySubmission(request);

    await this.auditLogs.record({
      ...context,
      action: "CREATE_LEAVE_REQUEST",
      module: "Leave",
      entityType: "LeaveRequest",
      entityId: request.id,
      description: `${request.employee.firstName} ${request.employee.lastName} filed a ${request.leaveType.name} leave request.`,
      newValues: {
        employeeId: request.employeeId,
        leaveType: request.leaveType.name,
        startDate: request.startDate,
        endDate: request.endDate,
        totalDays: request.totalDays,
        status: request.status,
      },
    });

    return request;
  }

  private async notifySubmission(request: {
    id: string;
    startDate: Date;
    endDate: Date;
    employee: { userId: string | null; firstName: string; lastName: string; supervisor: { userId: string | null } | null };
    leaveType: { name: string };
  }) {
    const adminUserIds = await this.notifications.adminUserIds();
    const recipientIds = [...adminUserIds, request.employee.supervisor?.userId].filter(
      (id): id is string => Boolean(id) && id !== request.employee.userId,
    );

    const employeeName = `${request.employee.firstName} ${request.employee.lastName}`;
    const dateRange = `${request.startDate.toLocaleDateString()} - ${request.endDate.toLocaleDateString()}`;

    await this.notifications.notifyUsers(recipientIds, {
      title: "New Leave Request",
      message: `${employeeName} filed a ${request.leaveType.name} request for ${dateRange}.`,
      type: "LEAVE_SUBMITTED",
      entityId: request.id,
    });
  }

  async updateStatus(id: string, status: LeaveRequestStatus, remarks?: string, context: AuditLogContext = {}) {
    // Load the request first so we know its *current* status before changing anything.
    // This is what lets us tell "first time being approved" apart from "already approved,
    // admin clicked again" — without this check, usedDays could be deducted more than once
    // for the same request.
    const existing = await this.prisma.leaveRequest.findUniqueOrThrow({
      where: { id },
    });

    const wasApproved = existing.status === "APPROVED";
    const isNowApproved = status === "APPROVED";

    const request = await this.prisma.leaveRequest.update({
      where: { id },
      data: { status, reviewedAt: new Date(), reviewedBy: context.actorUserId },
      include: {
        employee: { include: { department: true } },
        leaveType: true,
        reviewer: { include: { employee: true } },
      },
    });

    const statusLabel: Record<LeaveRequestStatus, string> = {
      PENDING: "pending",
      SUPERVISOR_APPROVED: "approved by your supervisor (awaiting HR approval)",
      APPROVED: "approved",
      REJECTED: "rejected",
      CANCELLED: "cancelled",
    };

    if (request.employee.userId && status !== "PENDING") {
      await this.notifications.notifyUsers([request.employee.userId], {
        title:
          status === "APPROVED"
            ? "Leave Request Approved"
            : status === "REJECTED"
              ? "Leave Request Rejected"
              : status === "CANCELLED"
                ? "Leave Request Cancelled"
                : "Leave Request Supervisor-Approved",
        message: `Your ${request.leaveType.name} request for ${request.startDate.toLocaleDateString()} - ${request.endDate.toLocaleDateString()} was ${statusLabel[status]}.${remarks?.trim() ? ` Remarks: ${remarks.trim()}` : ""}`,
        type:
          status === "APPROVED"
            ? "LEAVE_APPROVED"
            : status === "REJECTED"
              ? "LEAVE_REJECTED"
              : status === "CANCELLED"
                ? "LEAVE_CANCELLED"
                : "LEAVE_SUPERVISOR_APPROVED",
        entityId: request.id,
      });
    }

    // Only touch the balance when the *final* approval state is actually changing:
    // - PENDING/SUPERVISOR_APPROVED/REJECTED -> APPROVED: deduct the days.
    // - APPROVED -> anything else (an admin reversing a prior approval): give the days back.
    // - SUPERVISOR_APPROVED is a pre-approval tier only — it never touches the balance,
    //   only the final HR-level APPROVED transition does.
    if (!wasApproved && isNowApproved) {
      await this.adjustLeaveBalance(request.employeeId, request.leaveTypeId, request.startDate, Number(request.totalDays));
    } else if (wasApproved && !isNowApproved) {
      await this.adjustLeaveBalance(request.employeeId, request.leaveTypeId, request.startDate, -Number(request.totalDays));
    }

    const action =
      status === "APPROVED"
        ? "APPROVE_LEAVE"
        : status === "SUPERVISOR_APPROVED"
          ? "SUPERVISOR_APPROVE_LEAVE"
          : status === "CANCELLED"
            ? "CANCEL_LEAVE"
            : "REJECT_LEAVE";

    await this.auditLogs.record({
      ...context,
      action,
      module: "Leave",
      entityType: "LeaveRequest",
      entityId: id,
      description: `${statusLabel[status][0].toUpperCase()}${statusLabel[status].slice(1)} ${request.employee.firstName} ${request.employee.lastName}'s ${request.leaveType.name} leave request.`,
      oldValues: { status: existing.status },
      newValues: { remarks: remarks?.trim(), status },
    });

    return {
      ...request,
      adminRemarks: remarks?.trim() ? { remarks: remarks.trim(), status } : undefined,
    };
  }

  async cancel(id: string, context: AuditLogContext = {}, requestingEmployeeId?: string) {
    const existing = await this.prisma.leaveRequest.findUniqueOrThrow({ where: { id } });

    if (existing.status !== "PENDING" && existing.status !== "SUPERVISOR_APPROVED") {
      throw new BadRequestException("Only a pending or supervisor-approved request can be cancelled.");
    }

    // requestingEmployeeId is undefined for an elevated (ADMIN/SUPERVISOR) actor
    // cancelling on an employee's behalf; a plain employee must only cancel their own.
    if (requestingEmployeeId && existing.employeeId !== requestingEmployeeId) {
      throw new BadRequestException("You can only cancel your own leave request.");
    }

    return this.updateStatus(id, "CANCELLED", undefined, context);
  }

  async setExtensionDecision(id: string, extensionApproved: boolean, actorUserId?: string) {
    const updated = await this.prisma.leaveRequest.update({
      where: { id },
      data: { extensionApproved },
      include: {
        employee: { include: { department: true } },
        leaveType: true,
        reviewer: { include: { employee: true } },
      },
    });

    if (updated.employee.userId) {
      await this.notifications.notifyUsers([updated.employee.userId], {
        title: extensionApproved ? "Maternity Extension Approved" : "Maternity Extension Rejected",
        message: `Your request to extend your ${updated.leaveType.name} by 30 days without pay was ${extensionApproved ? "approved" : "rejected"}.`,
        type: extensionApproved ? "LEAVE_EXTENSION_APPROVED" : "LEAVE_EXTENSION_REJECTED",
        entityId: updated.id,
      });
    }

    await this.prisma.auditLog.create({
      data: {
        actorUserId,
        action: "SET_MATERNITY_EXTENSION",
        entityType: "LeaveRequest",
        entityId: id,
        newValues: { extensionApproved },
      },
    });

    return updated;
  }

  // Adds (or subtracts, for reversals) `deltaDays` from an employee's used-days balance
  // for the leave type and calendar year of the request's start date. Creates the
  // balance row on first use, seeded with the leave type's default annual allotment.
  // Never blocks on insufficient balance — usedDays is allowed to exceed earnedDays,
  // which is exactly how a `leaveType.allowWithoutPay` type (e.g. LWOP) stays usable
  // as a fallback once an employee's paid credits are exhausted.
  private async adjustLeaveBalance(employeeId: string, leaveTypeId: string, requestStartDate: Date, deltaDays: number) {
    const year = requestStartDate.getFullYear();

    const leaveType = await this.prisma.leaveType.findUniqueOrThrow({
      where: { id: leaveTypeId },
    });

    const existingBalance = await this.prisma.leaveBalance.findUnique({
      where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
    });

    if (existingBalance) {
      const nextUsedDays = Math.max(0, Number(existingBalance.usedDays) + deltaDays);
      await this.prisma.leaveBalance.update({
        where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
        data: { usedDays: nextUsedDays },
      });
    } else {
      // First time this employee has used this leave type in this year: seed a balance
      // row using the leave type's configured default allotment as earnedDays.
      await this.prisma.leaveBalance.create({
        data: {
          employeeId,
          leaveTypeId,
          year,
          earnedDays: leaveType.defaultDays,
          usedDays: Math.max(0, deltaDays),
        },
      });
    }
  }
}
