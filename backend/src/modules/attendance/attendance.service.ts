import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { AttendanceRecord } from "@prisma/client";
import { randomUUID } from "crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { FaceVerificationService } from "../face-verification/face-verification.service";
import { GeolocationService } from "../geolocation/geolocation.service";
import { AuditLogContext, AuditLogsService } from "../audit-logs/audit-logs.service";
import { SubmitAttendanceDto } from "./dto/submit-attendance.dto";
import { computeMinutesLate, computeMinutesUndertime, findBestMatchingShift, roundToInterval } from "./attendance-shift.util";
import { getApprovedLeaveByEmployee } from "../../common/utils/on-leave.util";

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
    private readonly auditLogs: AuditLogsService,
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
        employee: { include: { department: true, position: { select: { title: true } }, faceProfiles: { orderBy: { enrolledAt: "desc" }, take: 1 } } },
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

    const withRemarks = records.map((record) => ({
      ...record,
      adminRemarks: remarks.find((remark) => remark.entityId === record.id)?.newValues,
    }));

    // A specific single day (either `date`, or `from`/`to` narrowed to the
    // same calendar day — exactly what happens landing here from the
    // Dashboard's "View in Attendance" button) is the only case where
    // Absent/On-Leave employees can be reconstructed: neither ever gets a
    // real AttendanceRecord row, so without this they'd be invisible here
    // even though the Dashboard already counts them.
    const singleDay = attendanceDate ?? (fromDate && toDate && fromDate.toDateString() === toDate.toDateString() ? fromDate : undefined);
    if (!singleDay) return withRemarks;

    const employees = await this.prisma.employee.findMany({
      where: {
        employmentStatus: { not: "SEPARATED" },
        ...(filters.departmentId
          ? { departmentId: filters.departmentId }
          : filters.department && filters.department !== "ALL"
            ? { department: { name: filters.department } }
            : {}),
      },
      select: {
        id: true,
        employeeNo: true,
        firstName: true,
        lastName: true,
        hireDate: true,
        department: { select: { name: true } },
        position: { select: { title: true } },
      },
    });

    const recordedEmployeeIds = new Set(withRemarks.map((record) => record.employeeId));
    const onLeaveByEmployee = await getApprovedLeaveByEmployee(
      this.prisma,
      employees.map((e) => e.id),
      singleDay,
    );

    const wantsStatus = (status: "ABSENT" | "ON_LEAVE") => !filters.status || filters.status === "ALL" || filters.status === status;

    const syntheticRows = [];
    for (const employee of employees) {
      if (recordedEmployeeIds.has(employee.id)) continue;
      const onLeave = onLeaveByEmployee.get(employee.id);
      const base = {
        id: `${onLeave ? "leave" : "absent"}-${employee.id}-${filters.date ?? filters.from}`,
        attendanceDate: singleDay,
        recordType: "OFFICE" as const,
        visitNumber: 1,
        workLocationId: null,
        workLocation: null,
        timeInAt: null,
        timeOutAt: null,
        lunchOutAt: null,
        lunchInAt: null,
        totalMinutes: 0,
        lateMinutes: 0,
        undertimeMinutes: 0,
        shiftId: null,
        employeeId: employee.id,
        employee: {
          employeeNo: employee.employeeNo,
          firstName: employee.firstName,
          lastName: employee.lastName,
          department: employee.department,
          position: employee.position,
          faceProfiles: [],
        },
        logs: [],
        adminRemarks: undefined,
        isSynthetic: true,
      };

      if (onLeave && wantsStatus("ON_LEAVE")) {
        syntheticRows.push({ ...base, status: "ON_LEAVE" as const, leaveTypeName: onLeave.leaveTypeName });
      } else if (!onLeave && employee.hireDate <= singleDay && wantsStatus("ABSENT")) {
        syntheticRows.push({ ...base, status: "ABSENT" as const });
      }
    }

    return [...withRemarks, ...syntheticRows];
  }

  async updateStatus(
    id: string,
    status: "PRESENT" | "OFFICIAL_BUSINESS",
    remarks?: string,
    context: AuditLogContext = {},
    scopeDepartmentId?: string,
  ) {
    const before = await this.prisma.attendanceRecord.findUniqueOrThrow({
      where: { id },
      select: { status: true, employee: { select: { departmentId: true } } },
    });

    if (scopeDepartmentId && before.employee.departmentId !== scopeDepartmentId) {
      throw new ForbiddenException("You can only manage attendance records from your own department.");
    }

    const record = await this.prisma.attendanceRecord.update({
      where: { id },
      data: { status },
      include: {
        employee: { include: { department: true, faceProfiles: { orderBy: { enrolledAt: "desc" }, take: 1 } } },
        logs: { orderBy: { capturedAt: "desc" } },
      },
    });

    await this.auditLogs.record({
      ...context,
      action: status === "PRESENT" ? "CORRECT_ATTENDANCE" : "MARK_OFFICIAL_BUSINESS",
      module: "Attendance",
      entityType: "AttendanceRecord",
      entityId: id,
      description: `Updated attendance status for ${record.employee.firstName} ${record.employee.lastName} to ${status}.`,
      oldValues: { status: before.status },
      newValues: { remarks: remarks?.trim(), status },
    });

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

  // findFirst ordered by timeInAt desc, rather than findUnique on
  // visitNumber 1, so a FIELD employee's most recent visit today is
  // returned regardless of its recordType — visitNumber alone isn't a
  // reliable recency signal since it's now scoped per recordType, and an
  // office visit and a field visit on the same day can both be visitNumber 1.
  // For FIXED employees (always a single OFFICE record) this returns the
  // exact same single row findUnique would have.
  const record = await this.prisma.attendanceRecord.findFirst({
    where: { employeeId, attendanceDate },
    orderBy: { timeInAt: "desc" },
  });

  return (
    record ?? {
      status: "ABSENT",
      timeInAt: null,
      timeOutAt: null,
      lunchOutAt: null,
      lunchInAt: null,
    }
  );
}

  // Resolves the Shift template governing an employee's attendance at a given
  // moment, via whichever EmployeeSchedule assignment is currently active
  // (startsOn <= at, and endsOn is null or still in the future).
  private async resolveActiveShift(employeeId: string, at: Date) {
    const schedule = await this.prisma.employeeSchedule.findFirst({
      where: {
        employeeId,
        startsOn: { lte: at },
        OR: [{ endsOn: null }, { endsOn: { gte: at } }],
      },
      orderBy: { startsOn: "desc" },
      include: { shift: true },
    });
    return schedule?.shift ?? null;
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

  async submit(dto: SubmitAttendanceDto, context: AuditLogContext = {}) {
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
    const isField = employee.attendanceMode === "FIELD";

    // For a FIXED employee, recordType is always OFFICE. For a FIELD
    // employee, recordType is auto-detected per visit from the classification
    // of the WorkLocation they actually checked into (see WorkLocation.type)
    // — a field technician who visits an office-classified area is recorded
    // as an OFFICE visit rather than always being tagged FIELD. Kept as its
    // own column (rather than derived on read) so the DTR screen's
    // Office/Field tabs are a simple query.
    let recordType: "OFFICE" | "FIELD" = isField ? "FIELD" : "OFFICE";

    let existingRecord: AttendanceRecord | null;
    let logType: "TIME_IN" | "TIME_OUT" | "LUNCH_OUT" | "LUNCH_IN" | null;
    let visitNumber: number;
    let location: any;

    if (isField) {
      // Field technicians may log several sequential site visits per day,
      // possibly at a mix of office- and field-classified areas — the latest
      // visit overall (by time in, not visitNumber, since visitNumber is now
      // scoped per recordType) decides whether this scan opens a new visit
      // or closes the one already in progress.
      const latestVisit = await this.prisma.attendanceRecord.findFirst({
        where: { employeeId: dto.employeeId, attendanceDate },
        orderBy: { timeInAt: "desc" },
      });

      const hasOpenVisit = Boolean(latestVisit?.timeInAt && !latestVisit?.timeOutAt);

      if (hasOpenVisit) {
        // Closing an open visit reuses its own recordType/site rather than
        // re-resolving from a (possibly different) newly submitted location.
        existingRecord = latestVisit;
        logType = "TIME_OUT";
        recordType = latestVisit!.recordType as "OFFICE" | "FIELD";
        visitNumber = latestVisit!.visitNumber;
        location = await this.geolocation.getLocationById(latestVisit!.workLocationId);
      } else {
        existingRecord = null;
        logType = "TIME_IN";
        location = await this.resolveFieldVisitLocation(dto.employeeId, dto.workLocationId);
        recordType = location?.type ?? "FIELD";

        const latestVisitOfType = await this.prisma.attendanceRecord.findFirst({
          where: { employeeId: dto.employeeId, attendanceDate, recordType },
          orderBy: { visitNumber: "desc" },
        });
        visitNumber = (latestVisitOfType?.visitNumber ?? 0) + 1;
      }
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
      // The one exception is the window after Time In and before Time Out: lunch
      // break is optional, so Time Out, Lunch Out, and Lunch In can all be legal
      // next actions simultaneously — state alone can't disambiguate them, so the
      // client's requested `action` decides which one this scan is for. The server
      // still validates it's actually legal for the current state below.
      if (!existingRecord?.timeInAt) {
        logType = "TIME_IN";
      } else if (existingRecord.timeOutAt) {
        logType = null;
      } else if (dto.action === "LUNCH_OUT") {
        if (existingRecord.lunchOutAt) {
          throw new BadRequestException("Lunch break has already started.");
        }
        logType = "LUNCH_OUT";
      } else if (dto.action === "LUNCH_IN") {
        if (!existingRecord.lunchOutAt) {
          throw new BadRequestException("Start your lunch break before ending it.");
        }
        if (existingRecord.lunchInAt) {
          throw new BadRequestException("Lunch break has already ended.");
        }
        logType = "LUNCH_IN";
      } else {
        logType = "TIME_OUT";
      }
      visitNumber = 1;

      if (!logType) {
        throw new BadRequestException("You have already completed your attendance for today.");
      }

      location = await this.geolocation.getLocationForEmployee(dto.employeeId);
    }

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

    // Shift-based lateness/undertime is only meaningful for the OFFICE/FIXED
    // path — FIELD visits keep their existing always-PRESENT behavior, and an
    // employee with no active EmployeeSchedule assignment also falls back to
    // that same existing behavior (nothing to compare arrival against).
    let attendanceStatus: "PRESENT" | "LATE" = "PRESENT";
    let lateMinutes = 0;
    let resolvedShiftId: string | undefined;
    let undertimeMinutesValue: number | undefined;

    if (approved && !isField) {
      if (logType === "TIME_IN") {
        const shift = await this.resolveActiveShift(dto.employeeId, now);
        if (shift) {
          const arrivalForRules = shift.enableRounding ? roundToInterval(now, shift.roundingIntervalMinutes) : now;
          let effectiveShift = shift;
          let minutesLate = computeMinutesLate(shift, arrivalForRules, attendanceDate);

          if (minutesLate > 0 && shift.autoShiftAdjustment) {
            const otherShifts = await this.prisma.shift.findMany({
              where: { isActive: true, id: { not: shift.id } },
            });
            const matched = findBestMatchingShift(otherShifts, arrivalForRules, attendanceDate);
            if (matched) {
              effectiveShift = matched;
              minutesLate = computeMinutesLate(matched, arrivalForRules, attendanceDate);
            }
          }

          resolvedShiftId = effectiveShift.id;
          lateMinutes = minutesLate;
          attendanceStatus = minutesLate > 0 ? "LATE" : "PRESENT";
        }
      } else if (logType === "TIME_OUT" && existingRecord?.shiftId) {
        const shift = await this.prisma.shift.findUnique({ where: { id: existingRecord.shiftId } });
        if (shift) {
          const departureForRules = shift.enableRounding ? roundToInterval(now, shift.roundingIntervalMinutes) : now;
          undertimeMinutesValue = computeMinutesUndertime(shift, departureForRules, attendanceDate);
        }
      }
    }

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

          status: logType === "TIME_IN" && !isField ? attendanceStatus : "PRESENT",

          timeInAt:
            logType === "TIME_IN"
              ? now
              : null,

          timeOutAt:
            logType === "TIME_OUT"
              ? now
              : null,

          ...(logType === "TIME_IN" && !isField ? { lateMinutes, shiftId: resolvedShiftId } : {}),
        },

        update: {
          ...(logType === "TIME_IN"
            ? {
                timeInAt: now,
                status: !isField ? attendanceStatus : "PRESENT",
                ...(!isField ? { lateMinutes, shiftId: resolvedShiftId } : {}),
              }
            : {}),

          ...(logType ===
            "TIME_OUT" &&
          existingRecord?.timeInAt
            ? {
                timeOutAt: now,
                totalMinutes: Math.round((now.getTime() - existingRecord.timeInAt.getTime()) / 60000),
                ...(!isField && undertimeMinutesValue !== undefined ? { undertimeMinutes: undertimeMinutesValue } : {}),
              }
            : {}),

          // Lunch break is logged for visibility only — no effect on
          // totalMinutes/late/undertime math.
          ...(logType === "LUNCH_OUT" ? { lunchOutAt: now } : {}),
          ...(logType === "LUNCH_IN" ? { lunchInAt: now } : {}),
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

      const logTypeLabel: Record<typeof logType & string, string> = {
        TIME_IN: "time in",
        TIME_OUT: "time out",
        LUNCH_OUT: "lunch break start",
        LUNCH_IN: "lunch break end",
      };

      await this.auditLogs.record({
        ...context,
        actorUserId: context.actorUserId,
        action: logType,
        module: "Attendance",
        entityType: "AttendanceRecord",
        entityId: record?.id ?? null,
        description: `${employee.firstName} ${employee.lastName} recorded ${logTypeLabel[logType]}.`,
        newValues: {
          employeeId: dto.employeeId,
          logType,
          verificationStatus,
          workLocationId: location.id,
          deviceId: dto.deviceId,
          latitude: dto.latitude,
          longitude: dto.longitude,
        },
      });

      await this.auditLogs.record({
        ...context,
        actorUserId: context.actorUserId,
        action: "FACE_VERIFICATION",
        module: "Face Verification",
        entityType: "FaceVerification",
        entityId: dto.employeeId,
        description: `Face verification ${verificationStatus.toLowerCase()} for ${employee.firstName} ${employee.lastName}.`,
        newValues: { employeeId: dto.employeeId, verificationStatus, similarityScore, deviceId: dto.deviceId },
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
