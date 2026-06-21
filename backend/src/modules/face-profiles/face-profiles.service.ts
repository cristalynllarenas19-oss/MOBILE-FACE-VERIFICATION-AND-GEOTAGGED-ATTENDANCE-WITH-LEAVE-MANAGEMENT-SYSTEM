import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { UpsertFaceProfileDto } from "./dto/upsert-face-profile.dto";

@Injectable()
export class FaceProfilesService {
  constructor(private readonly prisma: PrismaService) {}

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

  async create(dto: UpsertFaceProfileDto) {
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

    return this.prisma.faceProfile.create({
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
  }

  async remove(id: string) {
    const profile = await this.prisma.faceProfile.findUnique({ where: { id } });
    if (!profile) {
      throw new NotFoundException("Face profile not found.");
    }
    return this.prisma.faceProfile.delete({ where: { id } });
  }
}
