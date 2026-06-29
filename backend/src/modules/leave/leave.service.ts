import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { CreateLeaveRequestDto } from "./dto/create-leave-request.dto";

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

@Injectable()
export class LeaveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async findAll(employeeId?: string) {
    const requests = await this.prisma.leaveRequest.findMany({
      where: employeeId ? { employeeId } : undefined,
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

  async create(dto: CreateLeaveRequestDto) {
    if (dto.attachmentData && Buffer.byteLength(dto.attachmentData, "base64") > MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException("Attachment must be 5MB or smaller.");
    }

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
      },
      include: {
        employee: { include: { supervisor: true, department: true } },
        leaveType: true,
      },
    });

    await this.notifySubmission(request);

    return request;
  }

  private async notifySubmission(request: {
    id: string;
    startDate: Date;
    endDate: Date;
    employee: { userId: string; firstName: string; lastName: string; supervisor: { userId: string } | null };
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

  async updateStatus(id: string, status: "APPROVED" | "REJECTED", remarks?: string, actorUserId?: string) {
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
      data: { status, reviewedAt: new Date(), reviewedBy: actorUserId },
      include: {
        employee: { include: { department: true } },
        leaveType: true,
        reviewer: { include: { employee: true } },
      },
    });

    await this.notifications.notifyUsers([request.employee.userId], {
      title: status === "APPROVED" ? "Leave Request Approved" : "Leave Request Rejected",
      message: `Your ${request.leaveType.name} request for ${request.startDate.toLocaleDateString()} - ${request.endDate.toLocaleDateString()} was ${status === "APPROVED" ? "approved" : "rejected"}.${remarks?.trim() ? ` Remarks: ${remarks.trim()}` : ""}`,
      type: status === "APPROVED" ? "LEAVE_APPROVED" : "LEAVE_REJECTED",
      entityId: request.id,
    });

    // Only touch the balance when the approval state is actually changing:
    // - PENDING/REJECTED -> APPROVED: deduct the days.
    // - APPROVED -> REJECTED (an admin reversing a prior approval): give the days back.
    // - Anything else (e.g. re-approving an already-approved request, or rejecting a
    //   request that was never approved) leaves the balance untouched.
    if (!wasApproved && isNowApproved) {
      await this.adjustLeaveBalance(request.employeeId, request.leaveTypeId, request.startDate, Number(request.totalDays));
    } else if (wasApproved && !isNowApproved) {
      await this.adjustLeaveBalance(request.employeeId, request.leaveTypeId, request.startDate, -Number(request.totalDays));
    }

    if (remarks?.trim()) {
      await this.prisma.auditLog.create({
        data: {
          actorUserId,
          action: status === "APPROVED" ? "APPROVE_LEAVE" : "REJECT_LEAVE",
          entityType: "LeaveRequest",
          entityId: id,
          newValues: { remarks: remarks.trim(), status },
        },
      });
    }

    return {
      ...request,
      adminRemarks: remarks?.trim() ? { remarks: remarks.trim(), status } : undefined,
    };
  }

  // Adds (or subtracts, for reversals) `deltaDays` from an employee's used-days balance
  // for the leave type and calendar year of the request's start date. Creates the
  // balance row on first use, seeded with the leave type's default annual allotment.
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