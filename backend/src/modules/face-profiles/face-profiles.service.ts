import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditLogContext, AuditLogsService } from "../audit-logs/audit-logs.service";
import { UpsertFaceProfileDto } from "./dto/upsert-face-profile.dto";

@Injectable()
export class FaceProfilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  findAll() {
    return this.prisma.faceProfile.findMany({
      include: {
        employee: {
          include: { department: true, position: true, user: true },
        },
      },
      orderBy: { enrolledAt: "desc" },
    });
  }

  async create(dto: UpsertFaceProfileDto, context: AuditLogContext = {}) {
    if (!dto.employeeId.trim()) {
      throw new BadRequestException("Employee is required.");
    }
    if (!dto.referenceImageData.trim()) {
      throw new BadRequestException("Reference image is required.");
    }
    if (!Array.isArray(dto.descriptors) || dto.descriptors.length === 0) {
      throw new BadRequestException("Face descriptors are required.");
    }

    const employee = await this.prisma.employee.findUnique({
      where: { id: dto.employeeId },
    });

    if (!employee) {
      throw new NotFoundException("Employee not found.");
    }

    const created = await this.prisma.faceProfile.create({
      data: {
        employeeId: employee.id,
        referenceImageData: dto.referenceImageData as any,
        descriptors: dto.descriptors as any,
        enrollmentStatus: "ACTIVE",
        enrolledAt: new Date(),
      } as any,
      include: {
        employee: {
          include: { department: true, position: true, user: true },
        },
      },
    });

    await this.auditLogs.record({
      ...context,
      action: "REGISTER_FACE",
      module: "Face Verification",
      entityType: "FaceProfile",
      entityId: created.id,
      description: `Registered face profile for ${created.employee.firstName} ${created.employee.lastName}.`,
      newValues: { employeeId: created.employeeId, enrollmentStatus: created.enrollmentStatus },
    });

    return created;
  }

  async remove(id: string, context: AuditLogContext = {}) {
    const profile = await this.prisma.faceProfile.findUnique({
      where: { id },
      include: { employee: true },
    });
    if (!profile) {
      throw new NotFoundException("Face profile not found.");
    }
    const removed = await this.prisma.faceProfile.delete({ where: { id } });
    await this.auditLogs.record({
      ...context,
      action: "DELETE_FACE_PROFILE",
      module: "Face Verification",
      entityType: "FaceProfile",
      entityId: id,
      description: `Deleted face profile for ${profile.employee.firstName} ${profile.employee.lastName}.`,
      oldValues: { employeeId: profile.employeeId, enrollmentStatus: profile.enrollmentStatus },
    });
    return removed;
  }
}
