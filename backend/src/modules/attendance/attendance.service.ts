import { Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { FaceVerificationService } from "../face-verification/face-verification.service";
import { GeolocationService } from "../geolocation/geolocation.service";
import { SubmitAttendanceDto } from "./dto/submit-attendance.dto";

const Jimp: any = require("jimp-compact");

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
      await this.prisma.workLocation.findFirst({
        where: { isActive: true, employeeId: employeeId || undefined },
      });

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

    const location =
      await this.prisma.workLocation.findFirst({
        where: { isActive: true, employeeId: dto.employeeId },
      });

    if (!location) {
      throw new NotFoundException(
        "No active work location is assigned to this employee",
      );
    }

    const faceProfile = (await this.prisma.faceProfile.findFirst({
      where: { employeeId: dto.employeeId, enrollmentStatus: "ACTIVE" },
      orderBy: { enrolledAt: "desc" },
    })) as any;

    if (!faceProfile?.referenceImageData) {
      throw new NotFoundException("No active face profile is enrolled for this employee");
    }

    const similarityScore = await this.compareFaceImages(
      faceProfile.referenceImageData,
      dto.faceImageBase64,
    );

    const faceResult = this.faceVerification.evaluateScores(100, similarityScore);

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

    const now = new Date();

    const attendanceDate =
      new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
      );

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
            : "PENDING_REVIEW",

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

        faceLivenessScore:
          dto.livenessScore,

        faceSimilarityScore:
          dto.similarityScore,

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

  private async compareFaceImages(referenceImageData: string, capturedImageData: string) {
    const reference = await this.loadImage(referenceImageData);
    const captured = await this.loadImage(capturedImageData);

    const referenceHash = reference.hash();
    const capturedHash = captured.hash();
    const hashSimilarity = Math.max(0, Math.min(100, Math.round((1 - Jimp.compareHashes(referenceHash, capturedHash)) * 100)));
    const pixelSimilarity = this.comparePixelSimilarity(reference, captured);
    const brightnessSimilarity = this.compareBrightnessSimilarity(reference, captured);

    return Math.max(
      0,
      Math.min(100, Math.round(hashSimilarity * 0.45 + pixelSimilarity * 0.45 + brightnessSimilarity * 0.1)),
    );
  }

  private async loadImage(imageData: string) {
    const source = imageData.startsWith("data:") ? imageData : `data:image/jpeg;base64,${imageData}`;
    const image = await Jimp.read(source);
    const size = Math.min(image.bitmap.width, image.bitmap.height);
    const left = Math.floor((image.bitmap.width - size) / 2);
    const top = Math.floor((image.bitmap.height - size) / 2);
    return image.crop(left, top, size, size).resize(256, 256).grayscale().normalize();
  }

  private comparePixelSimilarity(reference: any, captured: any) {
    const width = Math.min(reference.bitmap.width, captured.bitmap.width);
    const height = Math.min(reference.bitmap.height, captured.bitmap.height);
    const step = 4;
    let totalDifference = 0;
    let samples = 0;

    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const refIndex = reference.getPixelIndex(x, y);
        const capIndex = captured.getPixelIndex(x, y);
        totalDifference += Math.abs(reference.bitmap.data[refIndex] - captured.bitmap.data[capIndex]) / 255;
        samples += 1;
      }
    }

    if (!samples) return 0;
    return Math.max(0, Math.min(100, Math.round((1 - totalDifference / samples) * 100)));
  }

  private compareBrightnessSimilarity(reference: any, captured: any) {
    const referenceAvg = this.averageLuma(reference);
    const capturedAvg = this.averageLuma(captured);
    const diff = Math.abs(referenceAvg - capturedAvg) / 255;
    return Math.max(0, Math.min(100, Math.round((1 - diff) * 100)));
  }

  private averageLuma(image: any) {
    const step = 8;
    let total = 0;
    let samples = 0;

    for (let y = 0; y < image.bitmap.height; y += step) {
      for (let x = 0; x < image.bitmap.width; x += step) {
        const index = image.getPixelIndex(x, y);
        total += image.bitmap.data[index];
        samples += 1;
      }
    }

    return samples ? total / samples : 0;
  }
}
