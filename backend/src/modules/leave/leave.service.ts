import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { CreateLeaveRequestDto } from "./dto/create-leave-request.dto";

@Injectable()
export class LeaveService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    const requests = await this.prisma.leaveRequest.findMany({
      include: {
        employee: { include: { department: true } },
        leaveType: true,
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

  create(dto: CreateLeaveRequestDto) {
    return this.prisma.leaveRequest.create({
      data: {
        employeeId: dto.employeeId,
        leaveTypeId: dto.leaveTypeId,
        startDate: new Date(dto.startDate),
        endDate: new Date(dto.endDate),
        totalDays: dto.totalDays,
        reason: dto.reason,
      },
    });
  }

  async updateStatus(id: string, status: "APPROVED" | "REJECTED", remarks?: string) {
    const request = await this.prisma.leaveRequest.update({
      where: { id },
      data: { status, reviewedAt: new Date() },
      include: {
        employee: { include: { department: true } },
        leaveType: true,
      },
    });

    if (remarks?.trim()) {
      await this.prisma.auditLog.create({
        data: {
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
}
