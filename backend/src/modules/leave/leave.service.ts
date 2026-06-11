import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { CreateLeaveRequestDto } from "./dto/create-leave-request.dto";

@Injectable()
export class LeaveService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.leaveRequest.findMany({
      include: { employee: true, leaveType: true },
      orderBy: { startDate: "desc" },
    });
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

  updateStatus(id: string, status: "APPROVED" | "REJECTED") {
    return this.prisma.leaveRequest.update({
      where: { id },
      data: { status, reviewedAt: new Date() },
    });
  }
}
