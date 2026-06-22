import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { FaceVerificationService } from "../face-verification/face-verification.service";
import { GeolocationService } from "../geolocation/geolocation.service";
import { SubmitAttendanceDto } from "./dto/submit-attendance.dto";

type AttendanceFilters = {
  department?: string;
  status?: string;
  date?: string;
};

@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly geolocation: GeolocationService,
    private readonly faceVerification: FaceVerificationService,
  ) {}

  async findAll(filters: AttendanceFilters = {}) {
    const attendanceDate = filters.date ? new Date(filters.date) : undefined;
    const records = await this.prisma.attendanceRecord.findMany({
      where: {
        ...(filters.status && filters.status !== "ALL" ? { status: filters.status as any } : {}),
        ...(attendanceDate && !Number.isNaN(attendanceDate.getTime()) ? { attendanceDate } : {}),
        ...(filters.department && filters.department !== "ALL"
          ? { employee: { department: { name: filters.department } } }
          : {}),
      },
      include: {
        employee: { include: { department: true, faceProfiles: { orderBy: { enrolledAt: "desc" }, take: 1 } } },
        logs: { orderBy: { capturedAt: "desc" } },
      },
      orderBy: { attendanceDate: "desc" },
      take: 100,
    });

    const remarks = await this.prisma.auditLog.findMany({
      where: { entityType: "AttendanceRecord", entityId: { in: records.map((record) => record.id) } },
      orderBy: { createdAt: "desc" },
    });

    return records.map((record) => ({
      ...record,
      adminRemarks: remarks.find((remark) => remark.entityId === record.id)?.newValues,
    }));
  }

  async updateStatus(id: string, status: "PRESENT" | "OFFICIAL_BUSINESS", remarks?: string) {
    const record = await this.prisma.attendanceRecord.update({
      where: { id },
      data: { status },
      include: {
        employee: { include: { department: true, faceProfiles: { orderBy: { enrolledAt: "desc" }, take: 1 } } },
        logs: { orderBy: { capturedAt: "desc" } },
      },
    });

    if (remarks?.trim()) {
      await this.prisma.auditLog.create({
        data: {
          action: status === "PRESENT" ? "APPROVE_ATTENDANCE" : "MARK_OFFICIAL_BUSINESS",
          entityType: "AttendanceRecord",
          entityId: id,
          newValues: { remarks: remarks.trim(), status },
        },
      });
    }

    return {
      ...record,
      adminRemarks: remarks?.trim() ? { remarks: remarks.trim(), status } : undefined,
    };
  }

  async getTodayAttendance(
  employeeId: string,
) {
  const now = new Date();

  const attendanceDate = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );

  const record =
    await this.prisma.attendanceRecord.findUnique({
      where: {
        employeeId_attendanceDate: {
          employeeId,
          attendanceDate,
        },
      },
    });

  return (
    record ?? {
      status: "ABSENT",
      timeInAt: null,
      timeOutAt: null,
    }
  );
}

  async createSession(employeeId?: string) {
    const location =
      employeeId ? await this.geolocation.getLocationForEmployee(employeeId) : null;

    return {
      sessionId: randomUUID(),
      workLocation: location,
      expiresInSeconds: 300,
    };
  }

  async submit(dto: SubmitAttendanceDto) {
    const employee =
      await this.prisma.employee.findUnique({
        where: { id: dto.employeeId },
      });

    if (!employee) {
      throw new NotFoundException(
        "Employee not found",
      );
    }

    const now = new Date();
    const attendanceDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const existingRecord = await this.prisma.attendanceRecord.findUnique({
      where: {
        employeeId_attendanceDate: {
          employeeId: dto.employeeId,
          attendanceDate,
        },
      },
    });

    if (dto.logType === "TIME_IN" && existingRecord?.timeInAt) {
      throw new BadRequestException("You have already timed in today.");
    }

    if (dto.logType === "TIME_OUT" && !existingRecord?.timeInAt) {
      throw new BadRequestException("You must time in before you can time out.");
    }

    if (dto.logType === "TIME_OUT" && existingRecord?.timeOutAt) {
      throw new BadRequestException("You have already timed out today.");
    }

    const location =
      await this.geolocation.getLocationForEmployee(dto.employeeId);

    if (!location) {
      throw new NotFoundException(
        "No active work location is assigned to this employee",
      );
    }

    const faceProfile = (await this.prisma.faceProfile.findFirst({
      where: { employeeId: dto.employeeId, enrollmentStatus: "ACTIVE" },
      orderBy: { enrolledAt: "desc" },
    })) as any;

    const enrolledDescriptor = Array.isArray(faceProfile?.descriptors) ? faceProfile.descriptors[0] : null;

    if (!faceProfile?.referenceImageData || !Array.isArray(enrolledDescriptor)) {
      throw new NotFoundException("No active face profile is enrolled for this employee");
    }

    const capturedDescriptor = await this.faceVerification.extractDescriptor(
      this.decodeImageBase64(dto.faceImageBase64),
    );

    const distance = capturedDescriptor
      ? this.faceVerification.compareDescriptors(enrolledDescriptor, capturedDescriptor)
      : null;

    const livenessScore = 100;

    const faceResult = this.faceVerification.evaluateMatch(livenessScore, distance);
    const similarityScore = faceResult.similarityScore;

    const geoResult =
      this.geolocation.validateGeofence({
        latitude: dto.latitude,
        longitude: dto.longitude,
        accuracyMeters:
          dto.accuracyMeters,

        siteLatitude: Number(
          location.latitude,
        ),

        siteLongitude: Number(
          location.longitude,
        ),

        radiusMeters: Number(
          location.radiusMeters,
        ),

        allowedAccuracyMeters: Number(
          location.allowedAccuracyMeters,
        ),
      });

    const approved =
      faceResult.status ===
        "APPROVED" &&
      geoResult.approved;

    const verificationStatus =
      approved
        ? "APPROVED"
        : faceResult.status ===
          "PENDING_REVIEW"
        ? "PENDING_REVIEW"
        : "REJECTED";

    const record =
      await this.prisma.attendanceRecord.upsert({
        where: {
          employeeId_attendanceDate: {
            employeeId:
              dto.employeeId,
            attendanceDate,
          },
        },

        create: {
          employeeId:
            dto.employeeId,

          attendanceDate,

          status: approved
            ? "PRESENT"
            : "PENDING_REVIEW",

          timeInAt:
            dto.logType ===
              "TIME_IN" &&
            approved
              ? now
              : null,

          timeOutAt:
            dto.logType ===
              "TIME_OUT" &&
            approved
              ? now
              : null,
        },

        update: {
          status: approved
            ? "PRESENT"
            : existingRecord?.status ?? "PENDING_REVIEW",

          ...(dto.logType ===
            "TIME_IN" &&
          approved
            ? { timeInAt: now }
            : {}),

          ...(dto.logType ===
            "TIME_OUT" &&
          approved
            ? { timeOutAt: now }
            : {}),
        },
      });

    await this.prisma.attendanceLog.create({
      data: {
        attendanceRecordId:
          record.id,

        employeeId:
          dto.employeeId,

        logType: approved
          ? dto.logType
          : "FAILED_ATTEMPT",

        latitude:
          dto.latitude,

        longitude:
          dto.longitude,

        gpsAccuracyMeters:
          dto.accuracyMeters,

        distanceFromSiteMeters:
          geoResult.distanceMeters,

        workLocationId:
          location.id,

        faceLivenessScore:
          livenessScore,

        faceSimilarityScore:
          similarityScore,

        verificationStatus,

        deviceId:
          dto.deviceId,

        failureReason:
          faceResult.reason ??
          geoResult.reason,
      },
    });

    return {
      approved,
      verificationStatus,
      faceResult,
      geoResult,
      attendanceRecordId:
        record.id,
      similarityScore,
    };
  }

  private decodeImageBase64(imageData: string) {
    const base64Data = imageData.includes("base64,") ? imageData.split("base64,")[1] : imageData;
    return Buffer.from(base64Data, "base64");
  }
}
