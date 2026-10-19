import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { canContinueOvernightRecord, computeShiftEnd, isInsidePreviousDayShift } from "../attendance/attendance-shift.util";
import { isNonWorkingDay } from "../../common/utils/schedule.util";
import { LeaveTypeKind, Prisma } from "@prisma/client";
import * as argon2 from "argon2";
import { generateTemporaryPassword } from "../../common/utils/password.util";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditLogContext, AuditLogsService } from "../audit-logs/audit-logs.service";
import { EmployeeTypesService } from "../employee-types/employee-types.service";
import { EvaluationsService } from "../evaluations/evaluations.service";
import { GeolocationService } from "../geolocation/geolocation.service";
import { LeaveAccrualService } from "../leave/leave-accrual.service";
import { getTransferredPaternityDays, shiftMaternityDaysFromSpouse } from "../leave/leave-balances.service";
import { maskEmail, summarizeSmtpError } from "../mail/mail-transport";
import { MailNotConfiguredError, MailService } from "../mail/mail.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PositionsService } from "../positions/positions.service";
import { CreateEmployeeDto, UpdateEmployeeDto } from "./dto/create-employee.dto";

const PROBATION_MILESTONE_NOTIFICATION_TYPE = "PROBATION_REGULARIZATION_DUE";
// The employee's own copy — sent only once Admin has actually converted them
// off probation. The "review recommended" milestone above stays Admin-only.
const EMPLOYEE_REGULARIZED_NOTIFICATION_TYPE = "EMPLOYEE_REGULARIZED";
const PROBATION_MILESTONE_MONTHS = 6;

// The date a probationary hire must have started on or before to have
// completed their 6-month probation period as of today. Single source of
// truth for the calendar-month cutoff used by the milestone notification
// checks below and by update()'s regularization guard — proper calendar
// months via Date.setMonth, not a naive 180-day add.
function probationCutoffDate(): Date {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - PROBATION_MILESTONE_MONTHS);
  return cutoff;
}

// What a PROBATIONARY-track employee graduates into once eligible. Only
// these two source statuses are gated by the probation period — REGULAR,
// PERMANENT_SEASONAL, and SEPARATED are never restricted by it.
const REGULARIZATION_TARGET_STATUS: Record<string, string> = {
  PROBATIONARY: "REGULAR",
  PROBATIONARY_SEASONAL: "PERMANENT_SEASONAL",
};

const GENDER_LEAVE_TYPE_KIND: Record<string, LeaveTypeKind> = {
  MALE: "PATERNITY",
  FEMALE: "MATERNITY",
};

// Probationary employees (either track) aren't entitled to any leave balance
// yet — only Regular and Permanent Seasonal are. assignGenderLeaveType()
// checks this before actually writing a balance, and update() re-runs it the
// moment someone is promoted into one of these, so the correct sex-linked
// leave type still lands the moment they become entitled to it.
const ENTITLED_TO_LEAVE_STATUSES = new Set(["REGULAR", "PERMANENT_SEASONAL"]);

// Just enough of the linked spouse (see Employee.spouseEmployeeId) for the
// admin-web View/Edit Employee modals to show their name.
const SPOUSE_EMPLOYEE_SELECT = { select: { id: true, firstName: true, lastName: true, employeeNo: true } } as const;

// Bell notification for the admin when a login credentials email could not be
// sent even after retries (see sendCredentialsEmailInBackground).
const CREDENTIALS_EMAIL_FAILED_NOTIFICATION_TYPE = "CREDENTIALS_EMAIL_FAILED";

@Injectable()
export class EmployeesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(EmployeesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly mail: MailService,
    private readonly geolocation: GeolocationService,
    private readonly notifications: NotificationsService,
    private readonly evaluations: EvaluationsService,
    private readonly leaveAccrual: LeaveAccrualService,
    private readonly employeeTypes: EmployeeTypesService,
    private readonly positions: PositionsService,
  ) {}

  // Which EmployeeType row a create/update request is asking for. Prefers
  // employeeTypeId (what both frontends send now); falls back to a bare
  // employmentStatus from legacy callers. Returns undefined when neither is
  // present (update: "leave unchanged").
  private resolveRequestedEmployeeType(
    dto: { employeeTypeId?: string; employmentStatus?: string },
    currentTypeId?: string,
  ) {
    if (dto.employeeTypeId) return this.employeeTypes.resolveAssignable(dto.employeeTypeId, currentTypeId);
    if (dto.employmentStatus) return this.employeeTypes.resolveDefaultForEmploymentStatus(dto.employmentStatus);
    return undefined;
  }

  
  private async resolveAttendanceMode(departmentAttendanceMode: string, requested?: string) {
    if (departmentAttendanceMode !== "BOTH") return departmentAttendanceMode;

    if (!requested) {
      throw new BadRequestException("Attendance Mode is required for a department with no fixed mode.");
    }
    const mode = await this.prisma.attendanceMode.findUnique({ where: { code: requested } });
    if (!mode || !mode.isActive || !mode.availableForEmployees) {
      throw new BadRequestException(`"${requested}" is not a valid attendance mode for an employee.`);
    }
    return mode.code;
  }

  async findAll(departmentId?: string) {
    // The milestone checks only write notifications — nothing they do changes
    // the list below — so they run alongside it instead of in front of it.
    const [, , employees] = await Promise.all([
      this.checkProbationaryMilestones(),
      this.evaluations.checkEvaluationsDue(),
      this.prisma.employee.findMany({
        where: departmentId ? { departmentId } : undefined,
        // Every admin page that lists employees hits this endpoint, and none
        // of them show the photo (that comes from /employees/me) — inlining
        // each employee's base64 photo made every one of those pages slow.
        omit: { profilePhotoData: true },
        include: {
          // Never ship password hashes to the browser.
          user: { omit: { passwordHash: true } },
          department: true,
          position: true,
          supervisor: { omit: { profilePhotoData: true } },
          employeeType: true,
          spouseEmployee: SPOUSE_EMPLOYEE_SELECT,
          // The current (not yet restored) archive, if any — see EmployeeArchive.
          archives: { where: { restoredAt: null }, orderBy: { archivedAt: "desc" }, take: 1 },
        },
        // Newest-added employee first (LIFO), matching leave requests.
        orderBy: { createdAt: "desc" },
      }),
    ]);

    return employees.map(({ archives, ...employee }) => ({
      ...employee,
      ...this.archiveDetails(employee.employmentStatus === "SEPARATED" ? archives[0] : undefined),
    }));
  }

  // Flattens an employee_archives row into the archiveType/archiveDate/
  // archiveReason fields the admin-web Archive Details panel reads.
  private archiveDetails(archive?: { archiveType: string; reason: string | null; effectiveDate: Date | null; archivedAt: Date }) {
    if (!archive) return {};
    return {
      archiveType: archive.archiveType,
      archiveDate: archive.effectiveDate ?? archive.archivedAt,
      archiveReason: archive.reason ?? undefined,
    };
  }

  
  private async checkProbationaryMilestones() {
    const probationaryEmployees = await this.prisma.employee.findMany({
      where: {
        employmentStatus: { in: ["PROBATIONARY", "PROBATIONARY_SEASONAL"] },
        hireDate: { lte: probationCutoffDate() },
      },
      select: { id: true, firstName: true, lastName: true, employmentStatus: true },
    });
    if (probationaryEmployees.length === 0) return;

    const alreadyNotified = await this.prisma.notification.findMany({
      where: {
        type: PROBATION_MILESTONE_NOTIFICATION_TYPE,
        entityId: { in: probationaryEmployees.map((e) => e.id) },
      },
      select: { entityId: true },
    });
    const notifiedIds = new Set(alreadyNotified.map((n) => n.entityId));

    const dueEmployees = probationaryEmployees.filter((e) => !notifiedIds.has(e.id));
    if (dueEmployees.length === 0) return;

    const adminUserIds = await this.notifications.adminUserIds();
    for (const employee of dueEmployees) {
      const targetStatus = employee.employmentStatus === "PROBATIONARY_SEASONAL" ? "Permanent Seasonal" : "Regular";
      await this.notifications.notifyUsers(adminUserIds, {
        title: "Regularization Review Recommended",
        message: `${employee.firstName} ${employee.lastName} has completed six (6) months of probationary employment and may be ready for evaluation and conversion to ${targetStatus} status.`,
        type: PROBATION_MILESTONE_NOTIFICATION_TYPE,
        entityId: employee.id,
      });
    }
  }

  private async notifyProbationaryMilestoneIfDue(employee: {
    id: string;
    firstName: string;
    lastName: string;
    employmentStatus: string;
    hireDate: Date;
  }) {
    if (employee.employmentStatus !== "PROBATIONARY" && employee.employmentStatus !== "PROBATIONARY_SEASONAL") return;
    if (employee.hireDate > probationCutoffDate()) return;

    const alreadyNotified = await this.prisma.notification.findFirst({
      where: { type: PROBATION_MILESTONE_NOTIFICATION_TYPE, entityId: employee.id },
      select: { id: true },
    });
    if (alreadyNotified) return;

    const adminUserIds = await this.notifications.adminUserIds();
    const targetStatus = employee.employmentStatus === "PROBATIONARY_SEASONAL" ? "Permanent Seasonal" : "Regular";
    await this.notifications.notifyUsers(adminUserIds, {
      title: "Regularization Review Recommended",
      message: `${employee.firstName} ${employee.lastName} has completed six (6) months of probationary employment and may be ready for evaluation and conversion to ${targetStatus} status.`,
      type: PROBATION_MILESTONE_NOTIFICATION_TYPE,
      entityId: employee.id,
    });
  }


  findSupervisors(departmentId?: string) {
    return this.prisma.employee.findMany({
      where: {
        employmentStatus: { not: "SEPARATED" },
        ...(departmentId ? { departmentId } : {}),
        // Deactivated supervisors (User Management) aren't offered as supervisors.
        user: { status: "ACTIVE", userRoles: { some: { role: { code: "SUPERVISOR" } } } },
      },
      select: { id: true, firstName: true, lastName: true, employeeNo: true, department: { select: { name: true } } },
      orderBy: { lastName: "asc" },
    });
  }

  findSpouseCandidates(sex?: string) {
    if (sex !== "MALE" && sex !== "FEMALE") {
      throw new BadRequestException('sex must be "MALE" or "FEMALE".');
    }
    return this.prisma.employee.findMany({
      where: { sex, employmentStatus: { not: "SEPARATED" } },
      select: { id: true, firstName: true, lastName: true, employeeNo: true, department: { select: { name: true } } },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    });
  }

  // Same undefined/""/id convention as resolveSupervisorId: undefined = leave
  // unchanged, "" = clear, otherwise must be an active employee of the
  // opposite sex who isn't this employee.
  private async resolveSpouseEmployeeId(
    spouseEmployeeId: string | undefined,
    ownSex: string | null | undefined,
    selfEmployeeId?: string,
  ) {
    if (spouseEmployeeId === undefined) return undefined;
    if (!spouseEmployeeId) return null;

    if (spouseEmployeeId === selfEmployeeId) {
      throw new BadRequestException("An employee cannot be their own spouse.");
    }

    const spouse = await this.prisma.employee.findUnique({
      where: { id: spouseEmployeeId },
      select: { sex: true, employmentStatus: true },
    });
    if (!spouse || spouse.employmentStatus === "SEPARATED") {
      throw new BadRequestException("Selected spouse was not found among active employees.");
    }
    if (!ownSex || !spouse.sex || spouse.sex === ownSex) {
      throw new BadRequestException("The selected spouse must be an employee of the opposite sex.");
    }

    return spouseEmployeeId;
  }


  // Spouse links used to be one-way, so a couple linked from only one side
  // gets its missing back-link filled in on boot. Idempotent (a no-op once
  // every link is mutual) and in the background, so startup never waits.
  onApplicationBootstrap() {
    void this.backfillSpouseBackLinks().catch((error) =>
      this.logger.error(`[EMPLOYEE] Spouse back-link backfill failed: ${String(error)}`),
    );
  }

  private async backfillSpouseBackLinks() {
    const oneSided = await this.prisma.employee.findMany({
      where: { spouseEmployeeId: { not: null }, spouseEmployee: { spouseEmployeeId: null } },
      select: { id: true, spouseEmployeeId: true },
    });
    let linked = 0;
    for (const { id, spouseEmployeeId } of oneSided) {
      if (!spouseEmployeeId) continue;
      // Only the missing side is written — the existing side's link (and any
      // Added Paternity days already moved for it) stays as it is. Re-checked
      // here so two records naming the same spouse can't both claim them.
      await this.prisma.$transaction(async (tx) => {
        const spouse = await tx.employee.findUnique({ where: { id: spouseEmployeeId }, select: { spouseEmployeeId: true } });
        if (!spouse || spouse.spouseEmployeeId) return;
        await this.relinkSpouse(tx, spouseEmployeeId, id, { civilStatus: "MARRIED", spouseEmployerName: null, spouseUnemployed: false });
        linked++;
      });
    }
    if (linked > 0) this.logger.log(`[EMPLOYEE] Linked back ${linked} one-sided spouse record(s).`);
  }

  // Spouse links run both ways. Once employeeId's own link has been saved as
  // previousSpouseId -> newSpouseId, this:
  //  - marks the new spouse Married with their spouse working at ULPI, linked
  //    back to employeeId (and unlinks whoever they were linked to before);
  //  - unlinks the previous spouse if they still pointed back at employeeId
  //    (their Civil Status is left for the admin to set).
  // One transaction, with Added Paternity days following every link change.
  private async syncSpouseLinks(
    employeeId: string,
    sex: string | null,
    previousSpouseId: string | null,
    newSpouseId: string | null,
  ) {
    if (previousSpouseId === newSpouseId) return;
    await this.prisma.$transaction(async (tx) => {
      await this.movePaternityTransfer(tx, employeeId, sex, previousSpouseId, newSpouseId);

      if (previousSpouseId) {
        const previous = await tx.employee.findUnique({ where: { id: previousSpouseId }, select: { spouseEmployeeId: true } });
        if (previous?.spouseEmployeeId === employeeId) await this.relinkSpouse(tx, previousSpouseId, null);
      }

      if (newSpouseId) {
        const spouse = await tx.employee.findUniqueOrThrow({ where: { id: newSpouseId }, select: { spouseEmployeeId: true } });
        const theirFormerId = spouse.spouseEmployeeId;
        if (theirFormerId && theirFormerId !== employeeId) {
          const theirFormer = await tx.employee.findUnique({ where: { id: theirFormerId }, select: { spouseEmployeeId: true } });
          if (theirFormer?.spouseEmployeeId === newSpouseId) await this.relinkSpouse(tx, theirFormerId, null);
        }
        await this.relinkSpouse(tx, newSpouseId, employeeId, {
          civilStatus: "MARRIED",
          spouseEmployerName: null,
          spouseUnemployed: false,
        });
      }
    });
  }

  private async relinkSpouse(
    tx: Prisma.TransactionClient,
    employeeId: string,
    spouseId: string | null,
    data: Prisma.EmployeeUncheckedUpdateInput = {},
  ) {
    const current = await tx.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { sex: true, spouseEmployeeId: true } });
    await tx.employee.update({ where: { id: employeeId }, data: { ...data, spouseEmployeeId: spouseId } });
    await this.movePaternityTransfer(tx, employeeId, current.sex, current.spouseEmployeeId, spouseId);
  }

  // A husband's Added Paternity days come out of his linked wife's Maternity
  // Leave — re-linking (or unlinking) moves them back to the old wife and out
  // of the new one.
  private async movePaternityTransfer(
    tx: Prisma.TransactionClient,
    employeeId: string,
    sex: string | null,
    fromSpouseId: string | null,
    toSpouseId: string | null,
  ) {
    if (sex !== "MALE" || fromSpouseId === toSpouseId) return;
    const year = new Date().getFullYear();
    const transferredDays = await getTransferredPaternityDays(tx, employeeId, year);
    if (transferredDays === 0) return;
    if (fromSpouseId) await shiftMaternityDaysFromSpouse(tx, fromSpouseId, year, -transferredDays);
    if (toSpouseId) await shiftMaternityDaysFromSpouse(tx, toSpouseId, year, transferredDays);
  }

  private async resolveSupervisorId(
    supervisorId: string | undefined,
    targetDepartmentId: string,
    selfEmployeeId?: string,
  ) {
    if (supervisorId === undefined) return undefined;
    if (!supervisorId) return null;

    if (supervisorId === selfEmployeeId) {
      throw new BadRequestException("An employee cannot be their own supervisor.");
    }

    const supervisor = await this.prisma.employee.findUnique({
      where: { id: supervisorId },
      include: { user: { include: { userRoles: { include: { role: true } } } } },
    });

    if (!supervisor) {
      throw new BadRequestException("Selected supervisor was not found.");
    }

    const isSupervisor = supervisor.user?.userRoles.some((userRole) => userRole.role.code === "SUPERVISOR");
    if (!isSupervisor) {
      throw new BadRequestException("Selected employee does not have the Supervisor role.");
    }

    if (supervisor.departmentId !== targetDepartmentId) {
      throw new BadRequestException("A supervisor must belong to the same department as the employee.");
    }

    return supervisorId;
  }


  async findMe(employeeId: string) {
    const { faceProfiles, ...employee } = await this.prisma.employee.findUniqueOrThrow({
      where: { id: employeeId },
      include: {
        user: true,
        department: true,
        position: true,
        employeeType: true,
        // Shown on My Profile — just the name, nothing else of theirs.
        supervisor: { select: { firstName: true, lastName: true } },
        faceProfiles: { where: { enrollmentStatus: "ACTIVE", isArchived: false }, select: { id: true }, take: 1 },
      },
    });

    
    const now = new Date();
    const activeSchedule = await this.prisma.employeeSchedule.findFirst({
      where: {
        employeeId,
        isActive: true,
        startsOn: { lte: now },
        OR: [{ endsOn: null }, { endsOn: { gte: now } }],
      },
      orderBy: { startsOn: "desc" },
      select: { workingDays: true, shift: { select: { startTime: true, endTime: true, lateThresholdMinutes: true } } },
    });
    // After midnight on an overnight shift the working day is still
    // yesterday (see AttendanceService.resolveOfficeAttendanceDate) — the
    // employee must stay able to punch their break and Time Out even when
    // today itself isn't one of their working days.
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const insideOvernightShift = Boolean(
      activeSchedule &&
        isInsidePreviousDayShift(activeSchedule.shift, now) &&
        !isNonWorkingDay(yesterday, activeSchedule.workingDays),
    );
    const openOvernightRecord = await this.prisma.attendanceRecord.findFirst({
      where: { employeeId, attendanceDate: yesterday },
      orderBy: { timeInAt: "desc" },
      select: { timeInAt: true, timeOutAt: true, shift: { select: { startTime: true, endTime: true, lateThresholdMinutes: true } } },
    });
    const canCloseOvernightRecord = Boolean(
      openOvernightRecord?.timeInAt &&
        !openOvernightRecord.timeOutAt &&
        openOvernightRecord.shift &&
        canContinueOvernightRecord(openOvernightRecord.shift, yesterday, now),
    );
    const hasScheduleToday =
      Boolean(activeSchedule?.workingDays.includes(now.getDay())) || insideOvernightShift || canCloseOvernightRecord;

    // When the shift a Time In made now would be filed under ends — yesterday's
    // overnight shift while it's still running, otherwise today's. The apps
    // disable Time In from this moment (AttendanceService.submit refuses it
    // too); null when there's no shift today.
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const shiftEndsAt = !activeSchedule
      ? null
      : insideOvernightShift
        ? computeShiftEnd(activeSchedule.shift, yesterday)
        : activeSchedule.workingDays.includes(now.getDay())
          ? computeShiftEnd(activeSchedule.shift, today)
          : null;

    return { ...employee, hasActiveFaceEnrollment: faceProfiles.length > 0, hasScheduleToday, shiftEndsAt };
  }

  updateMyPhoto(employeeId: string, profilePhotoData: string, profilePhotoMimeType: string) {
    return this.prisma.employee.update({
      where: { id: employeeId },
      data: { profilePhotoData, profilePhotoMimeType },
      include: { user: true, department: true, position: true, employeeType: true },
    });
  }


  async acceptFaceConsent(employeeId: string) {
    const existing = await this.prisma.employee.findUniqueOrThrow({
      where: { id: employeeId },
      select: { faceConsentAcceptedAt: true },
    });
    if (existing.faceConsentAcceptedAt) {
      return { faceConsentAcceptedAt: existing.faceConsentAcceptedAt };
    }

    const updated = await this.prisma.employee.update({
      where: { id: employeeId },
      data: { faceConsentAcceptedAt: new Date() },
      select: { faceConsentAcceptedAt: true },
    });
    return { faceConsentAcceptedAt: updated.faceConsentAcceptedAt };
  }


  private async generateEmployeeNo(hireDate: Date): Promise<string> {
    const year = hireDate.getFullYear();

    const [{ last_number }] = await this.prisma.$transaction(async (tx) => {
      await tx.id_sequences.upsert({
        where: { year },
        update: {},
        create: { year, last_number: 0 },
      });
      return tx.$queryRaw<{ last_number: number }[]>`
        UPDATE id_sequences SET last_number = last_number + 1 WHERE year = ${year} RETURNING last_number
      `;
    });

    return `ULPI-${String(year).slice(-2)}${String(last_number).padStart(3, "0")}`;
  }

  async create(dto: CreateEmployeeDto, context: AuditLogContext = {}, scopeDepartmentId?: string) {
    const startedAt = Date.now();
    const recipient = maskEmail(dto.email);
    this.logger.log(`[EMPLOYEE] Employee creation started (${recipient})`);
    try {
      const result = await this.createEmployee(dto, context, scopeDepartmentId, recipient);
      this.logger.log(
        `[EMPLOYEE] Employee creation completed — ${result.employeeNo} in ${Date.now() - startedAt}ms total, credentials email sending in background`,
      );
      return result;
    } catch (error) {
      this.logger.warn(
        `[EMPLOYEE] Employee creation FAILED (${recipient}) after ${Date.now() - startedAt}ms — ` +
          (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).replace(/[^\s"<>]+@[^\s"<>]+/g, recipient),
      );
      throw error;
    }
  }

  private async createEmployee(dto: CreateEmployeeDto, context: AuditLogContext, scopeDepartmentId: string | undefined, recipient: string) {
    const existingUser = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existingUser) throw new ConflictException(`An account with the email "${dto.email}" already exists.`);

    const role = await this.prisma.role.findUniqueOrThrow({ where: { code: "EMPLOYEE" } });

    const employeeType = await this.resolveRequestedEmployeeType(dto);
    if (!employeeType) throw new BadRequestException("Employee Type is required.");
    const employmentStatus = employeeType.employmentStatus;
   
    const department = scopeDepartmentId
      ? await this.prisma.department.findUniqueOrThrow({ where: { id: scopeDepartmentId } })
      : await this.prisma.department.upsert({
          where: { name: dto.department },
          update: {},
          create: { name: dto.department },
        });
    
    // Must be offered in this department (e.g. Human Resources + Manager I
    // is rejected) — see PositionsService.isPositionAvailableIn.
    const position = dto.positionId
      ? await this.positions.assertAvailableIn(dto.positionId, department)
      : (await this.prisma.position.findFirst({ where: { title: "Employee" } })) ??
        (await this.prisma.position.create({ data: { title: "Employee" } }));

    
    const resolvedSupervisorId = await this.resolveSupervisorId(dto.supervisorId, department.id);
    const resolvedSpouseEmployeeId = await this.resolveSpouseEmployeeId(dto.spouseEmployeeId, dto.sex);
    const temporaryPassword = generateTemporaryPassword();
    const hireDate = dto.hireDate ? new Date(dto.hireDate) : new Date();
    const attendanceMode = await this.resolveAttendanceMode(department.attendanceMode, dto.attendanceMode);

    // Hashed and numbered before the transaction so it only holds the two
    // inserts. One transaction so a failed employee insert can't leave an
    // orphan User behind that blocks the retry with "email already exists".
    const passwordHash = await argon2.hash(temporaryPassword);
    const employeeNo = await this.generateEmployeeNo(hireDate);
    let stepAt = Date.now();
    const created = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: dto.email,
          passwordHash,
          mustChangePassword: true,
          userRoles: { create: { roleId: role.id } },
        },
      });

      return tx.employee.create({
      data: {
        userId: user.id,
        employeeNo,
        firstName: dto.firstName,
        lastName: dto.lastName,
        departmentId: department.id,
        positionId: position.id,
        hireDate,
        employeeTypeId: employeeType.id,
        employmentStatus,
        // Hired directly as Permanent Seasonal (no probationary stretch to
        // skip) starts the accrual clock at hireDate itself — the usual case
        // (converted later from PROBATIONARY_SEASONAL) sets this in update()
        // instead, anchored to the conversion date.
        ...(employmentStatus === "PERMANENT_SEASONAL" ? { permanentSeasonalSince: hireDate } : {}),
        attendanceMode,
        sex: dto.sex,
        soloParentStatus: dto.soloParentStatus ?? "NOT_APPLICABLE",
        civilStatus: dto.civilStatus ?? "SINGLE",
        spouseEmployerName: dto.spouseEmployerName || null,
        spouseUnemployed: dto.spouseUnemployed ?? false,
        ...(resolvedSpouseEmployeeId ? { spouseEmployeeId: resolvedSpouseEmployeeId } : {}),

        requiresFaceConsent: true,
        ...(resolvedSupervisorId !== undefined ? { supervisorId: resolvedSupervisorId } : {}),
      },
      include: {
        user: true,
        department: true,
        position: true,
        supervisor: true,
        employeeType: true,
        spouseEmployee: SPOUSE_EMPLOYEE_SELECT,
      },
      });
    });
    this.logger.log(`[DATABASE] Employee saved — ${created.employeeNo} (${created.id}) in ${Date.now() - stepAt}ms`);
    stepAt = Date.now();

    if (resolvedSpouseEmployeeId) {
      await this.syncSpouseLinks(created.id, created.sex, null, resolvedSpouseEmployeeId);
    }

    // Every new hire gets a starting Standard Shift and the default geotagged
    // area, field hires included — the default area never changes anyone's
    // attendance mode (see GeolocationService.syncAttendanceModes). A field
    // hire's own sites are added in Geotagging.
    await this.assignDefaultScheduleIfMissing(created.id);
    await this.geolocation.assignDefaultOfficeLocation(created.id, context);
    // The assigned area, not the submitted/department mode, has the final
    // say — see GeolocationService.syncAttendanceModes.
    created.attendanceMode =
      (await this.geolocation.syncAttendanceModes([created.id], context)).get(created.id) ?? created.attendanceMode;

    await this.assignGenderLeaveType(created.id, dto.sex, created.employmentStatus);
    // Overrides the default allotment assignGenderLeaveType just wrote — never
    // for a probationary hire, who isn't entitled to that balance yet.
    if (dto.leaveAllocationDays !== undefined && ENTITLED_TO_LEAVE_STATUSES.has(created.employmentStatus)) {
      await this.updateGenderLeaveAllocation(created.id, dto.sex, dto.leaveAllocationDays);
    }

    if (created.employmentStatus === "PERMANENT_SEASONAL") {
      await this.leaveAccrual.startAccrualForNewlyPermanentSeasonal(created.id);
    }
    this.logger.log(`[EMPLOYEE] Post-create setup (schedule, geotag, leave) done in ${Date.now() - stepAt}ms`);

    await this.auditLogs.record({
      ...context,
      action: "CREATE_EMPLOYEE",
      module: "Employees",
      entityType: "Employee",
      entityId: created.id,
      description: `Created employee record for ${created.firstName} ${created.lastName}.`,
      newValues: {
        email: dto.email,
        firstName: created.firstName,
        lastName: created.lastName,
        department: created.department.name,
        employeeType: created.employeeType.name,
        employmentStatus: created.employmentStatus,
        attendanceMode: created.attendanceMode,
        sex: created.sex,
        soloParentStatus: created.soloParentStatus,
      },
    });

    // Never rolls back the hire, and never makes the admin wait on Gmail: the
    // email goes out in the background (retrying a slow/flaky network) and
    // only a final failure is reported — see sendCredentialsEmailInBackground.
    this.sendCredentialsEmailInBackground(created, dto.email, temporaryPassword, context, recipient);

    return created;
  }

  // Fire-and-forget; never throws. If every attempt fails, the admin who made
  // the change gets a bell notification and it's flagged in Audit Logs.
  private sendCredentialsEmailInBackground(
    employee: { id: string; employeeNo: string; firstName: string; lastName: string },
    email: string,
    temporaryPassword: string,
    context: AuditLogContext,
    recipient = maskEmail(email),
  ) {
    const name = `${employee.firstName} ${employee.lastName}`;
    this.mail.sendNewEmployeeCredentialsEmail(email, temporaryPassword, name).catch(async (error) => {
      const summary = summarizeSmtpError(error);
      const reason =
        error instanceof MailNotConfiguredError
          ? "The email service is not configured on the server (GMAIL_USER / GMAIL_APP_PASSWORD)."
          : summary.hint ?? `The email server returned an error${summary.code ? ` (${summary.code})` : ""}.`;
      try {
        await this.auditLogs.record({
          ...context,
          action: "CREDENTIALS_EMAIL_FAILED",
          module: "Employees",
          entityType: "Employee",
          entityId: employee.id,
          description: `Login credentials email to ${name} (${recipient}) was not sent.`,
          newValues: { employeeNo: employee.employeeNo, code: summary.code, responseCode: summary.responseCode, timedOut: summary.timedOut },
        });
        if (context.actorUserId) {
          await this.notifications.notifyUsers([context.actorUserId], {
            title: "Login Email Not Sent",
            message: `The login email with the temporary password could not be sent to ${name} (${employee.employeeNo}). ${reason}`,
            type: CREDENTIALS_EMAIL_FAILED_NOTIFICATION_TYPE,
            entityId: employee.id,
          });
        }
      } catch (reportError) {
        this.logger.error(`[EMPLOYEE] Could not report the failed credentials email for ${employee.employeeNo}: ${String(reportError)}`);
      }
    });
  }

  
  private async assignDefaultScheduleIfMissing(employeeId: string) {
    const today = new Date();
    const hasActiveSchedule = await this.prisma.employeeSchedule.findFirst({
      where: {
        employeeId,
        startsOn: { lte: today },
        OR: [{ endsOn: null }, { endsOn: { gte: today } }],
      },
      select: { id: true },
    });
    if (hasActiveSchedule) return;

    const standardShift = await this.prisma.shift.findFirst({
      where: { name: "Standard Shift", isActive: true },
      orderBy: { createdAt: "asc" },
    });
    if (!standardShift) return;

    await this.prisma.employeeSchedule.create({
      data: {
        employeeId,
        shiftId: standardShift.id,
        startsOn: today,
      },
    });
  }

  
  private async assignGenderLeaveType(employeeId: string, sex: string, employmentStatus: string) {
    const kind = GENDER_LEAVE_TYPE_KIND[sex];
    const oppositeKinds = Object.values(GENDER_LEAVE_TYPE_KIND).filter((candidate) => candidate !== kind);
    const leaveType = await this.prisma.leaveType.findFirst({ where: { kind, isActive: true } });
    const year = new Date().getFullYear();

    await this.prisma.leaveBalance.deleteMany({
      where: {
        employeeId,
        year,
        leaveType: { kind: { in: oppositeKinds } },
      },
    });

    if (!leaveType) return;

    // Still probationary: don't grant the balance yet. update() calls this
    // same function again the moment they're promoted to Regular/Permanent
    // Seasonal, so the correct sex-linked type lands then instead.
    if (!ENTITLED_TO_LEAVE_STATUSES.has(employmentStatus)) return;

    await this.prisma.leaveBalance.upsert({
      where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId: leaveType.id, year } },
      update: {},
      create: { employeeId, leaveTypeId: leaveType.id, year, earnedDays: leaveType.defaultDays, usedDays: 0 },
    });
  }
  async update(id: string, dto: UpdateEmployeeDto, context: AuditLogContext = {}, scopeDepartmentId?: string) {
    const employee = await this.prisma.employee.findUniqueOrThrow({
      where: { id },
      include: { user: true, department: true, position: true, employeeType: true },
    });

    if (scopeDepartmentId && employee.departmentId !== scopeDepartmentId) {
      throw new ForbiddenException("You can only manage employees in your own department.");
    }

    // The type carries the Employment Status; every rule below keys off
    // nextStatus exactly as it used to key off a submitted employmentStatus.
    // An archived (SEPARATED) employee keeps that status on edit — only
    // restore() reactivates them (and their login) — so for them a type
    // change just re-points employeeTypeId.
    const nextType = await this.resolveRequestedEmployeeType(dto, employee.employeeTypeId);
    const nextStatus = employee.employmentStatus === "SEPARATED" ? undefined : nextType?.employmentStatus;

    // Mirrors the frontend's disabled dropdown option — enforced here too so
    // the restriction can't be bypassed by calling the API directly. Uses
    // dto.hireDate when the same request also changes it, so a corrected
    // hire date is recalculated against rather than the stale stored one.
    if (nextType && nextStatus && nextStatus === REGULARIZATION_TARGET_STATUS[employee.employmentStatus]) {
      const effectiveHireDate = dto.hireDate ? new Date(dto.hireDate) : employee.hireDate;
      if (effectiveHireDate > probationCutoffDate()) {
        throw new BadRequestException(
          `This employee cannot be changed to ${nextType.name} until they complete ${PROBATION_MILESTONE_MONTHS} months of probation.`,
        );
      }
    }

    const department = dto.department
      ? await this.prisma.department.upsert({
          where: { name: dto.department },
          update: {},
          create: { name: dto.department },
        })
      : null;

    if (scopeDepartmentId && department && department.id !== scopeDepartmentId) {
      throw new ForbiddenException("You cannot move an employee to another department.");
    }
    // positionId (Edit Employee's dropdown) must be offered in the employee's
    // (possibly new) department — unless it's simply their current position
    // and they're staying put. A bare position title is the legacy path.
    const movesDepartment = !!department && department.id !== employee.departmentId;
    const position = dto.positionId
      ? dto.positionId === employee.positionId && !movesDepartment
        ? null
        : await this.positions.assertAvailableIn(dto.positionId, department ?? employee.department)
      : dto.position
        ? (await this.prisma.position.findFirst({ where: { title: dto.position } })) ??
          (await this.prisma.position.create({ data: { title: dto.position } }))
        : null;

    // If the email is being changed, generate a new temporary password and update the user's password hash.
    const emailChanged = !!dto.email && dto.email !== employee.user?.email;
    const newTemporaryPassword = emailChanged ? generateTemporaryPassword() : null;

    if (dto.email) {
      if (!employee.userId) {
        throw new BadRequestException("Cannot update login email because this employee has no user account.");
      }

      await this.prisma.user.update({
        where: { id: employee.userId },
        data: {
          email: dto.email,
          ...(newTemporaryPassword
            ? { passwordHash: await argon2.hash(newTemporaryPassword), mustChangePassword: true }
            : {}),
        },
      });
    }

    const targetDepartmentId = department?.id ?? employee.departmentId;
    // The edit form always resubmits supervisorId even when the admin didn't
    // touch it — skip the extra lookup query on that common no-op case.
    const currentSupervisorId = employee.supervisorId ?? "";
    let resolvedSupervisorId =
      dto.supervisorId !== undefined && dto.supervisorId !== currentSupervisorId
        ? await this.resolveSupervisorId(dto.supervisorId, targetDepartmentId, id)
        : undefined;

   
    if (resolvedSupervisorId === undefined && department && department.id !== employee.departmentId && employee.supervisorId) {
      resolvedSupervisorId = null;
    }

    // Same no-op skip as supervisorId — the edit form always resubmits it.
    const resolvedSpouseEmployeeId =
      dto.spouseEmployeeId !== undefined && dto.spouseEmployeeId !== (employee.spouseEmployeeId ?? "")
        ? await this.resolveSpouseEmployeeId(dto.spouseEmployeeId, employee.sex, id)
        : undefined;

    // A FIXED department is office-only — field areas are reserved for
    // Field/Both departments (see GeolocationService.assertFieldAreaRoster).
    if (department && department.id !== employee.departmentId && department.attendanceMode === "FIXED") {
      const onFieldArea = await this.prisma.workLocationEmployee.count({
        where: { employeeId: id, workLocation: { type: "FIELD" } },
      });
      if (onFieldArea > 0) {
        throw new BadRequestException(
          `${department.name} is a Fixed (non-field) department. Remove this employee from their field area(s) in Geotagging before moving them there.`,
        );
      }
    }


    // dto.attendanceMode is deliberately ignored: an employee's mode is
    // decided by their assigned geotagged area alone (synced below), and
    // honouring the form's/department's mode here used to wipe a Field
    // employee's sites the moment their profile was saved as FIXED.
    const updated = await this.prisma.employee.update({
      where: { id },
      data: {
        ...(dto.firstName ? { firstName: dto.firstName } : {}),
        ...(dto.lastName ? { lastName: dto.lastName } : {}),
        ...(department ? { departmentId: department.id } : {}),
        ...(position ? { positionId: position.id } : {}),
        ...(dto.hireDate ? { hireDate: new Date(dto.hireDate) } : {}),
        ...(nextType ? { employeeTypeId: nextType.id } : {}),
        ...(nextStatus ? { employmentStatus: nextStatus } : {}),
        // Anchors LeaveAccrualService's monthly qualifying-period grid to the
        // conversion moment itself, never the original hireDate — the 6-month
        // PROBATIONARY_SEASONAL stretch never earns anything (see
        // checkProbationaryMilestones above), so the clock can't start until now.
        ...(nextStatus === "PERMANENT_SEASONAL" && employee.employmentStatus !== "PERMANENT_SEASONAL"
          ? { permanentSeasonalSince: new Date() }
          : {}),
        ...(dto.soloParentStatus ? { soloParentStatus: dto.soloParentStatus } : {}),
        ...(dto.civilStatus ? { civilStatus: dto.civilStatus } : {}),
        ...(dto.spouseEmployerName !== undefined ? { spouseEmployerName: dto.spouseEmployerName || null } : {}),
        ...(dto.spouseUnemployed !== undefined ? { spouseUnemployed: dto.spouseUnemployed } : {}),
        ...(resolvedSpouseEmployeeId !== undefined ? { spouseEmployeeId: resolvedSpouseEmployeeId } : {}),
        ...(resolvedSupervisorId !== undefined ? { supervisorId: resolvedSupervisorId } : {}),
      },
      include: {
        user: true,
        department: true,
        position: true,
        supervisor: true,
        employeeType: true,
        spouseEmployee: SPOUSE_EMPLOYEE_SELECT,
      },
    });

    // The assigned area, not the submitted/department mode, has the final
    // say — see GeolocationService.syncAttendanceModes.
    updated.attendanceMode =
      (await this.geolocation.syncAttendanceModes([id], context)).get(id) ?? updated.attendanceMode;

    if (resolvedSpouseEmployeeId !== undefined) {
      await this.syncSpouseLinks(id, employee.sex, employee.spouseEmployeeId, resolvedSpouseEmployeeId);
    }


    if (nextStatus && nextStatus !== employee.employmentStatus) {
      await this.evaluations.notifyOutcome(updated);

      if (nextStatus === REGULARIZATION_TARGET_STATUS[employee.employmentStatus]) {
        const statusLabel = nextStatus === "PERMANENT_SEASONAL" ? "Permanent Seasonal" : "Regular";
        await this.notifications.notifyUsers([updated.userId], {
          title: "Employment Status Updated",
          message: `Congratulations, ${updated.firstName}! You have completed your probationary period and are now a ${statusLabel} employee.`,
          type: EMPLOYEE_REGULARIZED_NOTIFICATION_TYPE,
          entityId: updated.id,
        });
      }

      if (nextStatus === "PERMANENT_SEASONAL") {
        await this.leaveAccrual.startAccrualForNewlyPermanentSeasonal(id);
      }

      // Just promoted off probation (Probationary -> Regular, or
      // Probationary Seasonal -> Permanent Seasonal) — grant the sex-linked
      // leave type now, since assignGenderLeaveType() withheld it while they
      // were still probationary.
      if (
        updated.sex &&
        ENTITLED_TO_LEAVE_STATUSES.has(nextStatus) &&
        !ENTITLED_TO_LEAVE_STATUSES.has(employee.employmentStatus)
      ) {
        await this.assignGenderLeaveType(id, updated.sex, updated.employmentStatus);
      }
    }

  
    if (dto.hireDate) {
      await this.notifyProbationaryMilestoneIfDue(updated);
    }

    if (dto.leaveAllocationDays !== undefined && employee.sex) {
      await this.updateGenderLeaveAllocation(id, employee.sex, dto.leaveAllocationDays);
    }

    if (newTemporaryPassword) {
      this.sendCredentialsEmailInBackground(updated, updated.user.email, newTemporaryPassword, context);
    }

    await this.auditLogs.record({
      ...context,
      action: "UPDATE_EMPLOYEE",
      module: "Employees",
      entityType: "Employee",
      entityId: id,
      description: `Updated employee record for ${updated.firstName} ${updated.lastName}.`,
      oldValues: {
        email: employee.user?.email,
        firstName: employee.firstName,
        lastName: employee.lastName,
        department: employee.department.name,
        position: employee.position.title,
        employeeType: employee.employeeType.name,
        employmentStatus: employee.employmentStatus,
        attendanceMode: employee.attendanceMode,
      },
      newValues: {
        email: updated.user.email,
        firstName: updated.firstName,
        lastName: updated.lastName,
        department: updated.department.name,
        position: updated.position.title,
        employeeType: updated.employeeType.name,
        employmentStatus: updated.employmentStatus,
        attendanceMode: updated.attendanceMode,
      },
    });

    return updated;
  }

  // Updates the earned days for this year's Paternity/Maternity LeaveBalance
  // row so admin edits in Edit Employee stay in sync with Leave Management.
  private async updateGenderLeaveAllocation(employeeId: string, sex: string, earnedDays: number) {
    const kind = GENDER_LEAVE_TYPE_KIND[sex];
    if (!kind) return;

    const leaveType = await this.prisma.leaveType.findFirst({ where: { kind, isActive: true } });
    if (!leaveType) return;

    const year = new Date().getFullYear();
    await this.prisma.leaveBalance.upsert({
      where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId: leaveType.id, year } },
      update: { earnedDays },
      create: { employeeId, leaveTypeId: leaveType.id, year, earnedDays, usedDays: 0 },
    });
  }

  async archive(
    id: string,
    dto: { reason?: string; archiveType?: string; effectiveDate?: string },
    context: AuditLogContext = {},
    scopeDepartmentId?: string,
  ) {
    const employee = await this.prisma.employee.findUniqueOrThrow({
      where: { id },
      include: { user: true },
    });

    if (scopeDepartmentId && employee.departmentId !== scopeDepartmentId) {
      throw new ForbiddenException("You can only manage employees in your own department.");
    }

    if (employee.employmentStatus === "SEPARATED") {
      throw new BadRequestException("This employee is already archived.");
    }

    const effectiveDate = dto.effectiveDate ? new Date(dto.effectiveDate) : null;
    if (effectiveDate && Number.isNaN(effectiveDate.getTime())) {
      throw new BadRequestException("Effective date is not a valid date.");
    }

    // All three writes succeed or none do — never a deactivated login on an
    // active employee, or an archived employee with no archive row.
    const [archiveRow, archivedEmployee] = await this.prisma.$transaction(async (tx) => {
      if (employee.userId) {
        await tx.user.update({
          where: { id: employee.userId },
          data: { status: "INACTIVE" },
        });
      }

      const row = await tx.employeeArchive.create({
        data: {
          employeeId: id,
          archiveType: dto.archiveType?.trim() || "Separated",
          reason: dto.reason?.trim() || null,
          effectiveDate,
          archivedByUserId: context.actorUserId ?? null,
        },
      });

      const updated = await tx.employee.update({
        where: { id },
        data: { employmentStatus: "SEPARATED" },
        include: { user: true, department: true, position: true, employeeType: true },
      });

      return [row, updated] as const;
    });

    const archived = { ...archivedEmployee, ...this.archiveDetails(archiveRow) };

    await this.auditLogs.record({
      ...context,
      action: "ARCHIVE_EMPLOYEE",
      module: "Employees",
      entityType: "Employee",
      entityId: id,
      description: `Archived employee record for ${archived.firstName} ${archived.lastName}.`,
      oldValues: { employmentStatus: employee.employmentStatus, userStatus: employee.user?.status },
      newValues: {
        archiveType: dto.archiveType ?? "Separated",
        reason: dto.reason?.trim() || "No reason provided",
        userStatus: "INACTIVE",
        employmentStatus: "SEPARATED",
      },
    });

    return archived;
  }

  // Counterpart to archive() above — reactivates both halves that archive()
  // deactivated (employmentStatus and the linked login account). Restoring
  // via the generic update() path alone left the login permanently locked
  // out, since update() never touches user.status.
  async restore(id: string, context: AuditLogContext = {}, scopeDepartmentId?: string) {
    const employee = await this.prisma.employee.findUniqueOrThrow({
      where: { id },
      include: { user: true, employeeType: true },
    });

    if (scopeDepartmentId && employee.departmentId !== scopeDepartmentId) {
      throw new ForbiddenException("You can only manage employees in your own department.");
    }

    if (employee.employmentStatus !== "SEPARATED") {
      throw new BadRequestException("This employee is not archived.");
    }

    const restored = await this.prisma.$transaction(async (tx) => {
      if (employee.userId) {
        await tx.user.update({
          where: { id: employee.userId },
          data: { status: "ACTIVE" },
        });
      }

      // Closes the open archive row(s) — kept as history, never deleted.
      await tx.employeeArchive.updateMany({
        where: { employeeId: id, restoredAt: null },
        data: { restoredAt: new Date(), restoredByUserId: context.actorUserId ?? null },
      });

      return tx.employee.update({
        where: { id },
        // Back to the Employment Status of the type they kept while archived —
        // previously always REGULAR, which silently promoted a separated
        // probationary employee on restore.
        data: { employmentStatus: employee.employeeType.employmentStatus },
        include: { user: true, department: true, position: true, employeeType: true },
      });
    });

    await this.auditLogs.record({
      ...context,
      action: "RESTORE_EMPLOYEE",
      module: "Employees",
      entityType: "Employee",
      entityId: id,
      description: `Restored employee record for ${restored.firstName} ${restored.lastName}.`,
      oldValues: { employmentStatus: employee.employmentStatus, userStatus: employee.user?.status },
      newValues: { employmentStatus: restored.employmentStatus, userStatus: "ACTIVE" },
    });

    return restored;
  }
}
