import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { AttendanceRecord } from "@prisma/client";
import { randomUUID } from "crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { FaceVerificationService } from "../face-verification/face-verification.service";
import { GeolocationService } from "../geolocation/geolocation.service";
import { SubmitAttendanceDto } from "./dto/submit-attendance.dto";

type AttendanceFilters = {
  department?: string;
  departmentId?: string;
  status?: string;
  date?: string;
  from?: string;
  to?: string;
};

// Parses a "YYYY-MM-DD" query param into a local-midnight Date, matching how
// attendanceDate is written in submit() (new Date(year, month, day)). Using
// `new Date(string)` instead would parse as UTC midnight and, on any server
// not running in the UTC timezone, shift the day boundary and silently
// exclude that day's records.
function parseLocalDate(value: string | undefined, endOfDay = false): Date | undefined {
  const match = value ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!match) return undefined;
  const [, year, month, day] = match;
  return endOfDay
    ? new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 59, 999)
    : new Date(Number(year), Number(month) - 1, Number(day));
}

@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly geolocation: GeolocationService,
    private readonly faceVerification: FaceVerificationService,
  ) {}

  async findAll(filters: AttendanceFilters = {}) {
    const attendanceDate = parseLocalDate(filters.date);
    const fromDate = parseLocalDate(filters.from);
    const toDate = parseLocalDate(filters.to, true);

    const records = await this.prisma.attendanceRecord.findMany({
      where: {
        ...(filters.status && filters.status !== "ALL" ? { status: filters.status as any } : {}),
        ...(attendanceDate
          ? { attendanceDate }
          : fromDate || toDate
            ? {
                attendanceDate: {
                  ...(fromDate ? { gte: fromDate } : {}),
                  ...(toDate ? { lte: toDate } : {}),
                },
              }
            : {}),
        ...(filters.departmentId
          ? { employee: { departmentId: filters.departmentId } }
          : filters.department && filters.department !== "ALL"
            ? { employee: { department: { name: filters.department } } }
            : {}),
      },
      include: {
        employee: { include: { department: true, faceProfiles: { orderBy: { enrolledAt: "desc" }, take: 1 } } },
        workLocation: { select: { name: true } },
        logs: { orderBy: { capturedAt: "desc" } },
      },
      orderBy: [{ attendanceDate: "desc" }, { visitNumber: "asc" }],
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

  async updateStatus(id: string, status: "PRESENT" | "OFFICIAL_BUSINESS", remarks?: string, actorUserId?: string) {
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
          actorUserId,
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

  // findFirst ordered by visitNumber desc, rather than findUnique on
  // visitNumber 1, so a FIELD employee's most recent visit today is
  // returned — for FIXED employees (always visitNumber 1) this returns
  // the exact same single row findUnique would have.
  const record = await this.prisma.attendanceRecord.findFirst({
    where: { employeeId, attendanceDate },
    orderBy: { visitNumber: "desc" },
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
    // recordType is implied entirely by the employee's mode — FIXED
    // employees only ever produce OFFICE records, FIELD employees only
    // ever produce FIELD ones. Kept as its own column (rather than derived
    // on read) so the DTR screen's Office/Field tabs are a simple query.
    const isField = employee.attendanceMode === "FIELD";
    const recordType: "OFFICE" | "FIELD" = isField ? "FIELD" : "OFFICE";

    let existingRecord: AttendanceRecord | null;
    let logType: "TIME_IN" | "TIME_OUT" | null;
    let visitNumber: number;

    if (isField) {
      // Field technicians may log several sequential site visits per day —
      // the latest visit (highest visitNumber) decides whether this scan
      // opens a new visit or closes the one already in progress.
      const latestVisit = await this.prisma.attendanceRecord.findFirst({
        where: { employeeId: dto.employeeId, attendanceDate },
        orderBy: { visitNumber: "desc" },
      });

      const hasOpenVisit = Boolean(latestVisit?.timeInAt && !latestVisit?.timeOutAt);

      existingRecord = hasOpenVisit ? latestVisit : null;
      logType = hasOpenVisit ? "TIME_OUT" : "TIME_IN";
      visitNumber = hasOpenVisit ? latestVisit!.visitNumber : (latestVisit?.visitNumber ?? 0) + 1;
    } else {
      existingRecord = await this.prisma.attendanceRecord.findUnique({
        where: {
          employeeId_attendanceDate_recordType_visitNumber: {
            employeeId: dto.employeeId,
            attendanceDate,
            recordType: "OFFICE",
            visitNumber: 1,
          },
        },
      });

      // The server, not the button the employee tapped, is the authority on whether
      // this scan is a Time In or Time Out, derived from the latest attendance entry.
      logType = !existingRecord?.timeInAt
        ? "TIME_IN"
        : !existingRecord?.timeOutAt
          ? "TIME_OUT"
          : null;
      visitNumber = 1;

      if (!logType) {
        throw new BadRequestException("You have already completed your attendance for today.");
      }
    }

    const location = isField
      ? logType === "TIME_OUT"
        // Ending a visit re-resolves the site from the open record itself,
        // rather than trusting the client to resend the same workLocationId.
        ? await this.geolocation.getLocationById(existingRecord?.workLocationId)
        : await this.resolveFieldVisitLocation(dto.employeeId, dto.workLocationId)
      : await this.geolocation.getLocationForEmployee(dto.employeeId);

    if (!location) {
      throw new NotFoundException(
        isField
          ? "Select one of your assigned client/work sites for this visit"
          : "No active work location is assigned to this employee",
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

    // Auto-levels the capture before matching/storing it: front-camera
    // selfies taken indoors with no flash are routinely underexposed, which
    // both looks bad in the saved photo and starves the descriptor of the
    // contrast it needs for an accurate match.
    const capturedImage = await this.faceVerification.brightenImage(
      this.decodeImageBase64(dto.faceImageBase64),
    );

    const capturedDescriptor = await this.faceVerification.extractDescriptor(capturedImage.buffer);

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

    // Neither a flat rejection nor a borderline/inconclusive match creates
    // or touches the day's attendance record — only a fully approved scan
    // does. Otherwise a failed or unsure attempt (bad lighting, a stranger
    // trying the camera, a borderline face match) would falsely flag the
    // whole day as "needs review" even though nothing legitimate happened.
    const record = approved
      ? await this.prisma.attendanceRecord.upsert({
        where: {
          employeeId_attendanceDate_recordType_visitNumber: {
            employeeId:
              dto.employeeId,
            attendanceDate,
            recordType,
            visitNumber,
          },
        },

        create: {
          employeeId:
            dto.employeeId,

          attendanceDate,
          recordType,
          visitNumber,
          workLocationId: location.id,

          status: "PRESENT",

          timeInAt:
            logType === "TIME_IN"
              ? now
              : null,

          timeOutAt:
            logType === "TIME_OUT"
              ? now
              : null,
        },

        update: {
          status: "PRESENT",

          ...(logType === "TIME_IN"
            ? { timeInAt: now }
            : {}),

          ...(logType ===
            "TIME_OUT" &&
          existingRecord?.timeInAt
            ? { timeOutAt: now, totalMinutes: Math.round((now.getTime() - existingRecord.timeInAt.getTime()) / 60000) }
            : {}),
        },
      })
      : existingRecord;

    // Rejected and pending-review attempts leave no trace at all now — only
    // an approved Time In/Out is persisted, with its photo.
    if (approved) {
      await this.prisma.attendanceLog.create({
        data: {
          attendanceRecordId: record?.id ?? null,
          employeeId: dto.employeeId,
          logType,
          latitude: dto.latitude,
          longitude: dto.longitude,
          gpsAccuracyMeters: dto.accuracyMeters,
          distanceFromSiteMeters: geoResult.distanceMeters,
          workLocationId: location.id,
          faceLivenessScore: livenessScore,
          faceSimilarityScore: similarityScore,
          verificationStatus,
          deviceId: dto.deviceId,
          failureReason: faceResult.reason ?? geoResult.reason,
          faceImageData: capturedImage.data,
          faceImageMimeType: capturedImage.mimeType,
        },
      });
    }

    return {
      approved,
      verificationStatus,
      logType,
      faceResult,
      geoResult,
      attendanceRecordId:
        record?.id ?? null,
      similarityScore,
      faceImage: `data:${capturedImage.mimeType};base64,${capturedImage.data}`,
    };
  }

  // Resolves which assigned site a FIELD employee is starting a new visit
  // at: the explicitly selected site if one was sent, otherwise — to stay
  // robust during a mobile-app rollout window where an older build might
  // omit it — the technician's sole assigned site, if they only have one.
  private async resolveFieldVisitLocation(employeeId: string, workLocationId?: string) {
    if (workLocationId) {
      return this.geolocation.findLocationForFieldVisit(employeeId, workLocationId);
    }

    const assignedLocations = await this.geolocation.getLocationsForEmployee(employeeId);
    return assignedLocations.length === 1 ? assignedLocations[0] : null;
  }

  async getHistory(employeeId: string, limit = 30) {
    return this.prisma.attendanceRecord.findMany({
      where: { employeeId },
      orderBy: [{ attendanceDate: "desc" }, { visitNumber: "asc" }],
      take: limit,
      include: {
        workLocation: { select: { name: true } },
        // Include every attempt for the day, not just the approved
        // TIME_IN/TIME_OUT ones — rejected attempts still have a captured
        // photo and the employee should be able to review it too.
        logs: {
          orderBy: { capturedAt: "asc" },
          select: {
            id: true,
            logType: true,
            capturedAt: true,
            verificationStatus: true,
            failureReason: true,
            faceImageData: true,
            faceImageMimeType: true,
          },
        },
      },
    });
  }

  private decodeImageBase64(imageData: string) {
    const base64Data = imageData.includes("base64,") ? imageData.split("base64,")[1] : imageData;
    return Buffer.from(base64Data, "base64");
  }
}
