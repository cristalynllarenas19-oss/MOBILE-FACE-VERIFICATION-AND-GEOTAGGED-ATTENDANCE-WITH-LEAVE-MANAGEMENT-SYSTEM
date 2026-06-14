import { Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { FaceVerificationService } from "../face-verification/face-verification.service";
import { GeolocationService } from "../geolocation/geolocation.service";
import { SubmitAttendanceDto } from "./dto/submit-attendance.dto";

@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly geolocation: GeolocationService,
    private readonly faceVerification: FaceVerificationService,
  ) {}

  findAll() {
    return this.prisma.attendanceRecord.findMany({
      include: {
        employee: { include: { department: true } },
        logs: { orderBy: { capturedAt: "desc" } },
      },
      orderBy: { attendanceDate: "desc" },
      take: 100,
    });
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

  async createSession() {
    const location =
      await this.prisma.workLocation.findFirst({
        where: { isActive: true },
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
        where: { isActive: true },
      });

    if (!location) {
      throw new NotFoundException(
        "Active work location is not configured",
      );
    }

    const faceResult =
      this.faceVerification.evaluateScores(
        dto.livenessScore,
        dto.similarityScore,
      );

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
    };
  }
}