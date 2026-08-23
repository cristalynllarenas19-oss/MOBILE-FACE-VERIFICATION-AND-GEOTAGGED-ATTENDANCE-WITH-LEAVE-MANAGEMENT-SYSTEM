import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { AttendanceRecord } from "@prisma/client";
import { randomUUID } from "crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { FaceVerificationService } from "../face-verification/face-verification.service";
import { GeolocationService } from "../geolocation/geolocation.service";
import { AuditLogContext, AuditLogsService } from "../audit-logs/audit-logs.service";
import { NotificationsService } from "../notifications/notifications.service";
import { SubmitAttendanceDto } from "./dto/submit-attendance.dto";
import {
  computeMinutesLate,
  computeMinutesUndertime,
  computeRenderTimeIn,
  findBestMatchingShift,
  roundToInterval,
} from "./attendance-shift.util";
import { getApprovedLeaveByEmployee } from "../../common/utils/on-leave.util";
import { isDayOff } from "../../common/utils/schedule.util";

type AttendanceFilters = {
  department?: string;
  departmentId?: string;
  status?: string;
  recordType?: string;
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
    private readonly notifications: NotificationsService,
  ) {}

  async findAll(filters: AttendanceFilters = {}) {
    const attendanceDate = parseLocalDate(filters.date);
    const fromDate = parseLocalDate(filters.from);
    const toDate = parseLocalDate(filters.to, true);

    const records = await this.prisma.attendanceRecord.findMany({
      where: {
        ...(filters.status && filters.status !== "ALL" ? { status: filters.status as any } : {}),
        ...(filters.recordType && filters.recordType !== "ALL" ? { recordType: filters.recordType as any } : {}),
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
    // Synthetic Absent/On-Leave rows always carry recordType OFFICE (no real
    // visit happened), so a FIELD-only filter should exclude them entirely.
    const wantsSyntheticRecordType = !filters.recordType || filters.recordType === "ALL" || filters.recordType === "OFFICE";

    const syntheticRows = [];
    for (const employee of wantsSyntheticRecordType ? employees : []) {
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
      } else if (!onLeave && !isDayOff(singleDay) && employee.hireDate <= singleDay && wantsStatus("ABSENT")) {
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
      status: isDayOff(attendanceDate) ? "DAY_OFF" : "ABSENT",
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

  // Computes shift-based lateness/undertime and upserts the day's
  // AttendanceRecord. Shared by submit()'s auto-approve path (effectiveTime
  // = the moment of the scan) and validateFlaggedLog() (effectiveTime = the
  // flagged log's original capturedAt) — a later admin validation must
  // record the DTR as of when the employee actually scanned, not when the
  // admin got around to reviewing it.
  private async upsertAttendanceRecord(params: {
    employeeId: string;
    attendanceDate: Date;
    recordType: "OFFICE" | "FIELD";
    visitNumber: number;
    workLocationId: string;
    logType: "TIME_IN" | "TIME_OUT" | "LUNCH_OUT" | "LUNCH_IN";
    isField: boolean;
    existingRecord: AttendanceRecord | null;
    effectiveTime: Date;
  }) {
    const { employeeId, attendanceDate, recordType, visitNumber, workLocationId, logType, isField, existingRecord, effectiveTime } = params;

    // Shift-based lateness/undertime is only meaningful for the OFFICE/FIXED
    // path — FIELD visits keep their existing always-PRESENT behavior, and an
    // employee with no active EmployeeSchedule assignment also falls back to
    // that same existing behavior (nothing to compare arrival against).
    let attendanceStatus: "PRESENT" | "LATE" = "PRESENT";
    let lateMinutes = 0;
    let resolvedShiftId: string | undefined;
    let renderTimeInValue: Date | undefined;
    let undertimeMinutesValue: number | undefined;

    if (!isField) {
      if (logType === "TIME_IN") {
        const shift = await this.resolveActiveShift(employeeId, effectiveTime);
        if (shift) {
          const arrivalForRules = shift.enableRounding
            ? roundToInterval(effectiveTime, shift.roundingIntervalMinutes)
            : effectiveTime;
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
          renderTimeInValue = computeRenderTimeIn(effectiveShift, effectiveTime, attendanceDate);
        }
      } else if (logType === "TIME_OUT" && existingRecord?.shiftId) {
        const shift = await this.prisma.shift.findUnique({ where: { id: existingRecord.shiftId } });
        if (shift) {
          const departureForRules = shift.enableRounding
            ? roundToInterval(effectiveTime, shift.roundingIntervalMinutes)
            : effectiveTime;
          undertimeMinutesValue = computeMinutesUndertime(shift, departureForRules, attendanceDate);
        }
      }
    }

    return this.prisma.attendanceRecord.upsert({
      where: {
        employeeId_attendanceDate_recordType_visitNumber: {
          employeeId,
          attendanceDate,
          recordType,
          visitNumber,
        },
      },

      create: {
        employeeId,
        attendanceDate,
        recordType,
        visitNumber,
        workLocationId,

        status: logType === "TIME_IN" && !isField ? attendanceStatus : "PRESENT",

        timeInAt: logType === "TIME_IN" ? effectiveTime : null,
        timeOutAt: logType === "TIME_OUT" ? effectiveTime : null,

        ...(logType === "TIME_IN" && !isField
          ? { lateMinutes, shiftId: resolvedShiftId, renderTimeInAt: renderTimeInValue }
          : {}),
      },

      update: {
        ...(logType === "TIME_IN"
          ? {
              timeInAt: effectiveTime,
              status: !isField ? attendanceStatus : "PRESENT",
              ...(!isField ? { lateMinutes, shiftId: resolvedShiftId, renderTimeInAt: renderTimeInValue } : {}),
            }
          : {}),

        ...(logType === "TIME_OUT" && existingRecord?.timeInAt
          ? {
              timeOutAt: effectiveTime,
              totalMinutes: Math.round(
                (effectiveTime.getTime() - (existingRecord.renderTimeInAt ?? existingRecord.timeInAt).getTime()) / 60000,
              ),
              ...(!isField && undertimeMinutesValue !== undefined ? { undertimeMinutes: undertimeMinutesValue } : {}),
            }
          : {}),

        // Lunch break is logged for visibility only — no effect on
        // totalMinutes/late/undertime math.
        ...(logType === "LUNCH_OUT" ? { lunchOutAt: effectiveTime } : {}),
        ...(logType === "LUNCH_IN" ? { lunchInAt: effectiveTime } : {}),
      },
    });
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

    // Sunday is a company-wide rest day for every role — employee, supervisor,
    // and admin/HR alike — so no attendance is taken or required from anyone.
    // TEMPORARILY DISABLED FOR TESTING — re-enable before shipping.
    // if (isDayOff(attendanceDate)) {
    //   throw new BadRequestException("Today is a scheduled day off (Sunday). Attendance is not required.");
    // }

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

    // Location is validated before anything face-related runs at all: a
    // request outside the allowed area is rejected immediately, without ever
    // loading the employee's FaceProfile or running descriptor
    // extraction/comparison. This mirrors the mobile client, which must
    // never open the camera in this case either — and it means a request
    // that bypasses the mobile UI and hits this endpoint directly still
    // cannot buy an approval by lying about face verification, since
    // approval never depends on anything the client claims about its own
    // face check, and no face data is even processed until location clears.
    if (!geoResult.approved) {
      return {
        approved: false,
        verificationStatus: "REJECTED" as const,
        logType,
        faceResult: {
          status: "REJECTED" as const,
          reason: "Face verification unavailable — outside the allowed area",
          similarityScore: 0,
        },
        geoResult,
        attendanceRecordId: existingRecord?.id ?? null,
        similarityScore: 0,
        faceImage: null,
      };
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

    // geoResult.approved is already guaranteed true here (see the
    // short-circuit above), so approval now rests solely on the face match.
    const approved = faceResult.status === "APPROVED" && geoResult.approved;

    // Only a genuinely borderline match (evaluateMatch's PENDING_REVIEW —
    // close enough that bad lighting/angle could explain it) is escalated to
    // the supervisor/admin for a human decision. A flat mismatch
    // (evaluateMatch's REJECTED — confidently a different person) is a hard
    // rejection: it must never become a "Time In Pending Review" record,
    // never notify a supervisor as if this might be the account owner, and
    // never leave a path to being approved after review. A geofence failure
    // is never escalated this way either (wrong location isn't evidence of
    // impersonation) — geoResult.approved is already guaranteed true here
    // regardless, per the short-circuit above.
    const shouldFlag = faceResult.status === "PENDING_REVIEW" && geoResult.approved;

    const verificationStatus = approved ? "APPROVED" : shouldFlag ? "PENDING_REVIEW" : "REJECTED";

    const logTypeLabel: Record<typeof logType & string, string> = {
      TIME_IN: "time in",
      TIME_OUT: "time out",
      LUNCH_OUT: "lunch break start",
      LUNCH_IN: "lunch break end",
    };

    // Neither a flat rejection nor a flagged/borderline attempt creates or
    // touches the day's attendance record — only a fully approved scan does.
    // A flagged attempt gets its own AttendanceLog (attendanceRecordId null)
    // below, and only becomes a real AttendanceRecord once an admin/
    // supervisor validates it (see validateFlaggedLog()).
    const record = approved
      ? await this.upsertAttendanceRecord({
          employeeId: dto.employeeId,
          attendanceDate,
          recordType,
          visitNumber,
          workLocationId: location.id,
          logType: logType!,
          isField,
          existingRecord,
          effectiveTime: now,
        })
      : existingRecord;

    if (approved) {
      await this.prisma.attendanceLog.create({
        data: {
          attendanceRecordId: record?.id ?? null,
          employeeId: dto.employeeId,
          logType,
          attendanceDate,
          recordType,
          visitNumber,
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
    } else if (shouldFlag) {
      const flaggedLog = await this.prisma.attendanceLog.create({
        data: {
          attendanceRecordId: null,
          employeeId: dto.employeeId,
          logType,
          attendanceDate,
          recordType,
          visitNumber,
          latitude: dto.latitude,
          longitude: dto.longitude,
          gpsAccuracyMeters: dto.accuracyMeters,
          distanceFromSiteMeters: geoResult.distanceMeters,
          workLocationId: location.id,
          faceLivenessScore: livenessScore,
          faceSimilarityScore: similarityScore,
          verificationStatus: "PENDING_REVIEW",
          deviceId: dto.deviceId,
          failureReason: faceResult.reason ?? geoResult.reason,
          faceImageData: capturedImage.data,
          faceImageMimeType: capturedImage.mimeType,
        },
      });

      await this.notifyFlaggedAttempt(employee, flaggedLog.id, logType!, logTypeLabel);

      await this.auditLogs.record({
        ...context,
        actorUserId: context.actorUserId,
        action: "FLAG_ATTENDANCE_MISMATCH",
        module: "Attendance",
        entityType: "AttendanceLog",
        entityId: flaggedLog.id,
        description: `${employee.firstName} ${employee.lastName}'s account was used for a ${logTypeLabel[logType]} attempt whose face did not match the enrolled profile. Flagged for admin review.`,
        newValues: {
          employeeId: dto.employeeId,
          logType,
          verificationStatus: "PENDING_REVIEW",
          similarityScore,
          workLocationId: location.id,
          deviceId: dto.deviceId,
        },
      });
    } else if (faceResult.status === "REJECTED" && faceResult.reason === "Face does not match enrolled profile") {
      // Only reached by a client that skipped (or lied about) the mobile
      // app's pre-submit /face/match check — that check already stops a
      // confident mismatch before it ever reaches here in the normal flow —
      // but it still needs to count toward the same-day strike threshold so
      // a bypassing client can't dodge the supervisor notification.
      await this.faceVerification.recordFaceMismatch(dto.employeeId);
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

  // Mirrors leave.service.ts's notifySubmission(): a regular employee's
  // flagged attempt routes to their direct supervisor; a supervisor (or an
  // employee with no assigned supervisor) has no one above them to escalate
  // to, so it routes to HR/Admin instead.
  private async notifyFlaggedAttempt(
    employee: { userId: string; supervisorId: string | null; firstName: string; lastName: string },
    logId: string,
    logType: "TIME_IN" | "TIME_OUT" | "LUNCH_OUT" | "LUNCH_IN",
    logTypeLabel: Record<string, string>,
  ) {
    const isSupervisor = await this.notifications.userHasRole(employee.userId, "SUPERVISOR");

    let recipientIds: string[];
    if (!isSupervisor && employee.supervisorId) {
      const supervisor = await this.prisma.employee.findUnique({
        where: { id: employee.supervisorId },
        select: { userId: true },
      });
      recipientIds = supervisor?.userId ? [supervisor.userId] : await this.notifications.adminUserIds();
    } else {
      recipientIds = await this.notifications.adminUserIds();
    }

    await this.notifications.notifyUsers(recipientIds, {
      title: "Attendance Verification Flagged",
      message: `${employee.firstName} ${employee.lastName}'s account was used for a ${logTypeLabel[logType]} attempt, but the captured face did not match the enrolled profile. Review required.`,
      type: "ATTENDANCE_FLAGGED",
      entityId: logId,
    });
  }

  // Flagged attempts awaiting a human decision: geofence passed but the
  // face didn't cleanly match the account being used. No AttendanceRecord
  // exists for these yet (attendanceRecordId is null) — see submit()'s
  // shouldFlag branch.
  async findFlaggedLogs(filters: { departmentId?: string } = {}) {
    return this.prisma.attendanceLog.findMany({
      where: {
        verificationStatus: "PENDING_REVIEW",
        attendanceRecordId: null,
        ...(filters.departmentId ? { employee: { departmentId: filters.departmentId } } : {}),
      },
      include: {
        employee: {
          include: {
            department: true,
            position: { select: { title: true } },
            faceProfiles: { orderBy: { enrolledAt: "desc" }, take: 1 },
          },
        },
        workLocation: { select: { name: true } },
      },
      orderBy: { capturedAt: "desc" },
    });
  }

  // Admin/supervisor confirms a flagged attempt was actually the account
  // owner (e.g. a borderline match under bad lighting): creates the DTR
  // dated to the *original* scan time, not the moment of this review.
  async validateFlaggedLog(logId: string, remarks: string | undefined, context: AuditLogContext = {}, scopeDepartmentId?: string) {
    const log = await this.prisma.attendanceLog.findUniqueOrThrow({
      where: { id: logId },
      include: {
        employee: { select: { departmentId: true, firstName: true, lastName: true, userId: true, attendanceMode: true } },
      },
    });

    if (log.verificationStatus !== "PENDING_REVIEW" || log.attendanceRecordId) {
      throw new BadRequestException("This attendance attempt has already been reviewed.");
    }

    if (scopeDepartmentId && log.employee.departmentId !== scopeDepartmentId) {
      throw new ForbiddenException("You can only manage attendance records from your own department.");
    }

    const { attendanceDate, recordType, visitNumber, workLocationId } = log;
    if (!attendanceDate || !recordType || visitNumber === null || !workLocationId) {
      throw new BadRequestException("This flagged attempt is missing data required to record it.");
    }

    const isField = log.employee.attendanceMode === "FIELD";

    const existingRecord = await this.prisma.attendanceRecord.findUnique({
      where: {
        employeeId_attendanceDate_recordType_visitNumber: {
          employeeId: log.employeeId,
          attendanceDate,
          recordType,
          visitNumber,
        },
      },
    });

    const record = await this.upsertAttendanceRecord({
      employeeId: log.employeeId,
      attendanceDate,
      recordType,
      visitNumber,
      workLocationId,
      logType: log.logType as "TIME_IN" | "TIME_OUT" | "LUNCH_OUT" | "LUNCH_IN",
      isField,
      existingRecord,
      effectiveTime: log.capturedAt,
    });

    const updatedLog = await this.prisma.attendanceLog.update({
      where: { id: logId },
      data: {
        attendanceRecordId: record.id,
        verificationStatus: "APPROVED",
        reviewedAt: new Date(),
        reviewedBy: context.actorUserId,
        reviewRemarks: remarks?.trim() || null,
      },
    });

    await this.auditLogs.record({
      ...context,
      action: "VALIDATE_FLAGGED_ATTENDANCE",
      module: "Attendance",
      entityType: "AttendanceLog",
      entityId: logId,
      description: `Validated ${log.employee.firstName} ${log.employee.lastName}'s flagged attendance attempt as legitimate.`,
      oldValues: { verificationStatus: log.verificationStatus },
      newValues: { remarks: remarks?.trim(), verificationStatus: "APPROVED" },
    });

    if (log.employee.userId) {
      await this.notifications.notifyUsers([log.employee.userId], {
        title: "Attendance Validated",
        message: `Your ${log.capturedAt.toLocaleDateString()} attendance attempt was reviewed and validated. It has been recorded.`,
        type: "ATTENDANCE_VALIDATED",
        entityId: logId,
      });
    }

    return updatedLog;
  }

  // Admin/supervisor confirms a flagged attempt was impersonation: tagged as
  // a fake attendance attempt, no DTR is ever created for it.
  async rejectFlaggedLog(logId: string, remarks: string | undefined, context: AuditLogContext = {}, scopeDepartmentId?: string) {
    const log = await this.prisma.attendanceLog.findUniqueOrThrow({
      where: { id: logId },
      include: { employee: { select: { departmentId: true, firstName: true, lastName: true, userId: true } } },
    });

    if (log.verificationStatus !== "PENDING_REVIEW" || log.attendanceRecordId) {
      throw new BadRequestException("This attendance attempt has already been reviewed.");
    }

    if (scopeDepartmentId && log.employee.departmentId !== scopeDepartmentId) {
      throw new ForbiddenException("You can only manage attendance records from your own department.");
    }

    const updatedLog = await this.prisma.attendanceLog.update({
      where: { id: logId },
      data: {
        verificationStatus: "FAKE_ATTEMPT",
        reviewedAt: new Date(),
        reviewedBy: context.actorUserId,
        reviewRemarks: remarks?.trim() || null,
      },
    });

    await this.auditLogs.record({
      ...context,
      action: "REJECT_FLAGGED_ATTENDANCE",
      module: "Attendance",
      entityType: "AttendanceLog",
      entityId: logId,
      description: `Confirmed a fake attendance attempt on ${log.employee.firstName} ${log.employee.lastName}'s account.`,
      oldValues: { verificationStatus: log.verificationStatus },
      newValues: { remarks: remarks?.trim(), verificationStatus: "FAKE_ATTEMPT" },
    });

    if (log.employee.userId) {
      await this.notifications.notifyUsers([log.employee.userId], {
        title: "Unauthorized Attendance Attempt",
        message: `A ${log.capturedAt.toLocaleDateString()} attendance attempt on your account did not pass verification and was flagged as unauthorized. Contact HR if this wasn't you.`,
        type: "ATTENDANCE_FAKE_ATTEMPT",
        entityId: logId,
      });
    }

    return updatedLog;
  }

  // Admin/supervisor dismisses a flagged attempt without deciding it was
  // legitimate or impersonation — e.g. a stale/unreachable attempt not worth
  // pursuing. Removes it from the flagged review queue with no DTR created
  // and no notification to the employee, since no decision about them is
  // being communicated.
  async archiveFlaggedLog(logId: string, remarks: string | undefined, context: AuditLogContext = {}, scopeDepartmentId?: string) {
    const log = await this.prisma.attendanceLog.findUniqueOrThrow({
      where: { id: logId },
      include: { employee: { select: { departmentId: true, firstName: true, lastName: true } } },
    });

    if (log.verificationStatus !== "PENDING_REVIEW" || log.attendanceRecordId) {
      throw new BadRequestException("This attendance attempt has already been reviewed.");
    }

    if (scopeDepartmentId && log.employee.departmentId !== scopeDepartmentId) {
      throw new ForbiddenException("You can only manage attendance records from your own department.");
    }

    const updatedLog = await this.prisma.attendanceLog.update({
      where: { id: logId },
      data: {
        verificationStatus: "ARCHIVED",
        reviewedAt: new Date(),
        reviewedBy: context.actorUserId,
        reviewRemarks: remarks?.trim() || null,
      },
    });

    await this.auditLogs.record({
      ...context,
      action: "ARCHIVE_FLAGGED_ATTENDANCE",
      module: "Attendance",
      entityType: "AttendanceLog",
      entityId: logId,
      description: `Archived a flagged attendance attempt on ${log.employee.firstName} ${log.employee.lastName}'s account.`,
      oldValues: { verificationStatus: log.verificationStatus },
      newValues: { remarks: remarks?.trim(), verificationStatus: "ARCHIVED" },
    });

    return updatedLog;
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
            latitude: true,
            longitude: true,
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
