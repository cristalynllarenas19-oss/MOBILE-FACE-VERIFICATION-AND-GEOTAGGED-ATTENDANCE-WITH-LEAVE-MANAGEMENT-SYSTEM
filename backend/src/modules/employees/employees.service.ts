import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { LeaveTypeKind } from "@prisma/client";
import * as argon2 from "argon2";
import { generateTemporaryPassword } from "../../common/utils/password.util";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditLogContext, AuditLogsService } from "../audit-logs/audit-logs.service";
import { GeolocationService } from "../geolocation/geolocation.service";
import { MailService } from "../mail/mail.service";
import { NotificationsService } from "../notifications/notifications.service";
import { CreateEmployeeDto, CreateEmployeeSex, UpdateEmployeeDto } from "./dto/create-employee.dto";

const PROBATION_MILESTONE_NOTIFICATION_TYPE = "PROBATION_REGULARIZATION_DUE";
const PROBATION_MILESTONE_MONTHS = 6;

const GENDER_LEAVE_TYPE_KIND: Record<string, LeaveTypeKind> = {
  MALE: "PATERNITY",
  FEMALE: "MATERNITY",
};

@Injectable()
export class EmployeesService {
  private readonly logger = new Logger(EmployeesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly mail: MailService,
    private readonly geolocation: GeolocationService,
    private readonly notifications: NotificationsService,
  ) {}

  // Derives the final attendanceMode for an employee: a department configured
  // to anything other than "BOTH" always wins — no per-employee choice is
  // accepted, closing the gap where an employee's mode could otherwise drift
  // from their department's policy. A "BOTH" department has no restriction,
  // so HR must explicitly choose one of the employee-eligible DB-managed modes.
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
    await this.checkProbationaryMilestones();
    return this.prisma.employee.findMany({
      where: departmentId ? { departmentId } : undefined,
      include: { user: true, department: true, position: true, supervisor: true },
      // Newest-added employee first (LIFO), matching leave requests.
      orderBy: { createdAt: "desc" },
    });
  }

  // Recommendation-only check, never touches employmentStatus itself — HR
  // still has to manually convert Probationary -> Regular via Edit Employee.
  // Runs opportunistically whenever the employee list is fetched (no cron
  // job exists in this backend), so it's "automatic" from HR's perspective
  // without needing a scheduler. Idempotent: the Notification table itself
  // is the source of truth for "already notified", not a flag on Employee.
  private async checkProbationaryMilestones() {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - PROBATION_MILESTONE_MONTHS);

    const probationaryEmployees = await this.prisma.employee.findMany({
      where: { employmentStatus: "PROBATIONARY", hireDate: { lte: cutoff } },
      select: { id: true, firstName: true, lastName: true },
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
      await this.notifications.notifyUsers(adminUserIds, {
        title: "Regularization Review Recommended",
        message: `${employee.firstName} ${employee.lastName} has completed six (6) months of probationary employment and may be ready for evaluation and conversion to Regular status.`,
        type: PROBATION_MILESTONE_NOTIFICATION_TYPE,
        entityId: employee.id,
      });
    }
  }

  // Candidates for the "Supervisor" field on Add/Edit Employee — anyone
  // currently carrying the SUPERVISOR role. A department is only ever
  // meaningful to pass for a scoped Supervisor (who can only supervise their
  // own department anyway); HR/Admin gets the full cross-department list and
  // the frontend narrows it to whatever department the form currently holds.
  findSupervisors(departmentId?: string) {
    return this.prisma.employee.findMany({
      where: {
        employmentStatus: { not: "SEPARATED" },
        ...(departmentId ? { departmentId } : {}),
        user: { userRoles: { some: { role: { code: "SUPERVISOR" } } } },
      },
      select: { id: true, firstName: true, lastName: true, employeeNo: true, department: { select: { name: true } } },
      orderBy: { lastName: "asc" },
    });
  }

  // Shared by create()/update(): resolves and validates the incoming
  // supervisorId against the employee's *target* department (the one they'll
  // have after this save, not necessarily their current one) so a supervisor
  // can never be assigned across departments — this must hold for
  // getSupervisorDepartmentScope-based leave/report scoping to stay correct.
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

  // Face enrollment, work-location assignment, and having an active shift
  // assignment covering today are all prerequisites the mobile/web clients
  // check before letting an employee attempt Time In/Out at all (rather than
  // only failing after they've already gone through the camera scan) — see
  // AttendanceScreen's eligibility gate.
  async findMe(employeeId: string) {
    const { faceProfiles, ...employee } = await this.prisma.employee.findUniqueOrThrow({
      where: { id: employeeId },
      include: {
        user: true,
        department: true,
        position: true,
        faceProfiles: { where: { enrollmentStatus: "ACTIVE" }, select: { id: true }, take: 1 },
      },
    });

    // Same lookup as AttendanceService.resolveActiveShift: whichever
    // EmployeeSchedule assignment is currently active, then check today is
    // one of its working days.
    const now = new Date();
    const activeSchedule = await this.prisma.employeeSchedule.findFirst({
      where: {
        employeeId,
        isActive: true,
        startsOn: { lte: now },
        OR: [{ endsOn: null }, { endsOn: { gte: now } }],
      },
      orderBy: { startsOn: "desc" },
      select: { workingDays: true },
    });
    const hasScheduleToday = Boolean(activeSchedule?.workingDays.includes(now.getDay()));

    return { ...employee, hasActiveFaceEnrollment: faceProfiles.length > 0, hasScheduleToday };
  }

  updateMyPhoto(employeeId: string, profilePhotoData: string, profilePhotoMimeType: string) {
    return this.prisma.employee.update({
      where: { id: employeeId },
      data: { profilePhotoData, profilePhotoMimeType },
      include: { user: true, department: true, position: true },
    });
  }

  // Called once by the employee from FaceConsentScreen on mobile. Idempotent
  // by design (re-accepting just keeps the original timestamp) so a retried
  // request from a flaky connection can't silently move the acceptance time.
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

  // ULPI-{YY}{NNN}, e.g. ULPI-26001 — NNN resets every calendar year (keyed
  // off the employee's hire year) and is handed out from id_sequences, a
  // one-row-per-year counter. The upsert-then-UPDATE...RETURNING runs in its
  // own short transaction so the row lock (which serializes concurrent hires
  // in the same year) is held only as long as it takes to claim a number, not
  // for the rest of employee creation.
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
    const existingUser = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existingUser) throw new ConflictException(`An account with the email "${dto.email}" already exists.`);

    const role = await this.prisma.role.findUniqueOrThrow({ where: { code: "EMPLOYEE" } });
    // A scoped Supervisor's new hire is always auto-associated with their own
    // department, regardless of what was submitted — same rule as Geotagged
    // Areas creation.
    const department = scopeDepartmentId
      ? await this.prisma.department.findUniqueOrThrow({ where: { id: scopeDepartmentId } })
      : await this.prisma.department.upsert({
          where: { name: dto.department },
          update: {},
          create: { name: dto.department },
        });
    // Position is no longer collected when adding an employee — HR can set a
    // specific title later via Edit. Every new hire starts on this
    // placeholder so `positionId` (a required FK) is always populated.
    const position =
      (await this.prisma.position.findFirst({ where: { title: "Employee" } })) ??
      (await this.prisma.position.create({ data: { title: "Employee" } }));

    // A random temporary password is generated and emailed to the new hire —
    // they log in with it once, then are forced to set their own password
    // (see AuthService.login / UsersService.changePassword).
    const resolvedSupervisorId = await this.resolveSupervisorId(dto.supervisorId, department.id);
    const temporaryPassword = generateTemporaryPassword();
    const hireDate = dto.hireDate ? new Date(dto.hireDate) : new Date();
    const attendanceMode = await this.resolveAttendanceMode(department.attendanceMode, dto.attendanceMode);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash: await argon2.hash(temporaryPassword),
        mustChangePassword: true,
        userRoles: { create: { roleId: role.id } },
      },
    });

    const created = await this.prisma.employee.create({
      data: {
        userId: user.id,
        employeeNo: await this.generateEmployeeNo(hireDate),
        firstName: dto.firstName,
        lastName: dto.lastName,
        departmentId: department.id,
        positionId: position.id,
        hireDate,
        employmentStatus: dto.employmentStatus,
        attendanceMode,
        sex: dto.sex,
        soloParentStatus: dto.soloParentStatus ?? "NOT_APPLICABLE",
        ...(resolvedSupervisorId !== undefined ? { supervisorId: resolvedSupervisorId } : {}),
      },
      include: { user: true, department: true, position: true, supervisor: true },
    });

    if (created.attendanceMode === "FIXED") {
      await this.assignDefaultScheduleIfMissing(created.id);
      await this.geolocation.assignDefaultOfficeLocation(created.id, created.departmentId, context);
    }

    await this.assignGenderLeaveType(created.id, dto.sex);

    // Delivery failure shouldn't roll back an otherwise-successful hire —
    // the account and temporary password already exist either way.
    try {
      await this.mail.sendNewEmployeeCredentialsEmail(
        dto.email,
        temporaryPassword,
        `${created.firstName} ${created.lastName}`,
      );
    } catch (error) {
      this.logger.error(`Failed to send new-employee credentials email to ${dto.email}`, error instanceof Error ? error.stack : undefined);
    }

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
        employmentStatus: created.employmentStatus,
        attendanceMode: created.attendanceMode,
        sex: created.sex,
        soloParentStatus: created.soloParentStatus,
      },
    });

    return created;
  }

  // Fixed/office employees need a real EmployeeSchedule to be visible to
  // lateness/absence tracking at all (see AttendanceService.resolveActiveShift
  // and DashboardService's no-show checks) — without one they're silently
  // excluded from both. No-ops if the employee already has an active
  // schedule (don't stomp on one HR assigned deliberately), or if no
  // "Standard Shift" exists yet to fall back to. workingDays isn't set
  // explicitly — it picks up the schema default (Mon-Fri).
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

  // Male hires are auto-enrolled in the Paternity-kind leave type and female
  // hires in the Maternity-kind one, so HR never has to add these manually
  // after registration. No-ops until HR has created a leave type with that
  // kind (see Utilities -> Leave Types).
  private async assignGenderLeaveType(employeeId: string, sex: CreateEmployeeSex) {
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

    await this.prisma.leaveBalance.upsert({
      where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId: leaveType.id, year } },
      update: {},
      create: { employeeId, leaveTypeId: leaveType.id, year, earnedDays: leaveType.defaultDays, usedDays: 0 },
    });
  }
  async update(id: string, dto: UpdateEmployeeDto, context: AuditLogContext = {}, scopeDepartmentId?: string) {
    const employee = await this.prisma.employee.findUniqueOrThrow({
      where: { id },
      include: { user: true, department: true, position: true },
    });

    if (scopeDepartmentId && employee.departmentId !== scopeDepartmentId) {
      throw new ForbiddenException("You can only manage employees in your own department.");
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
    const position = dto.position
      ? (await this.prisma.position.findFirst({ where: { title: dto.position } })) ??
        (await this.prisma.position.create({ data: { title: dto.position } }))
      : null;

    // Changing the login email is treated like a re-issue of credentials: the
    // old temporary/self-chosen password is only known as a hash, so a fresh
    // one is generated and mailed to the new address, same as on hire.
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
    let resolvedSupervisorId = await this.resolveSupervisorId(dto.supervisorId, targetDepartmentId, id);

    // Moving departments without an explicit supervisor change would otherwise
    // leave a dangling cross-department supervisorId — clear it rather than
    // silently break the "supervisor is always in the employee's own
    // department" invariant that leave/report scoping depends on.
    if (resolvedSupervisorId === undefined && department && department.id !== employee.departmentId && employee.supervisorId) {
      resolvedSupervisorId = null;
    }

    // Recompute only when it could actually change: an explicit
    // dto.attendanceMode, or an actual department move (which may carry its
    // own restriction the employee must now conform to). A same-department
    // edit that touches neither is left alone.
    let resolvedAttendanceMode: string | undefined;
    if (dto.attendanceMode !== undefined || (department && department.id !== employee.departmentId)) {
      const targetDepartmentAttendanceMode = department?.attendanceMode ?? employee.department.attendanceMode;
      resolvedAttendanceMode = await this.resolveAttendanceMode(targetDepartmentAttendanceMode, dto.attendanceMode);
    }

    const updated = await this.prisma.employee.update({
      where: { id },
      data: {
        ...(dto.firstName ? { firstName: dto.firstName } : {}),
        ...(dto.lastName ? { lastName: dto.lastName } : {}),
        ...(department ? { departmentId: department.id } : {}),
        ...(position ? { positionId: position.id } : {}),
        ...(dto.hireDate ? { hireDate: new Date(dto.hireDate) } : {}),
        ...(dto.employmentStatus ? { employmentStatus: dto.employmentStatus } : {}),
        ...(resolvedAttendanceMode !== undefined ? { attendanceMode: resolvedAttendanceMode } : {}),
        ...(dto.soloParentStatus ? { soloParentStatus: dto.soloParentStatus } : {}),
        ...(resolvedSupervisorId !== undefined ? { supervisorId: resolvedSupervisorId } : {}),
      },
      include: { user: true, department: true, position: true, supervisor: true },
    });

    // Only auto-assign on an actual transition into Fixed — not on every
    // unrelated save while already Fixed — matching how create() only ever
    // does this once, at hire.
    if (resolvedAttendanceMode === "FIXED" && employee.attendanceMode !== "FIXED") {
      await this.assignDefaultScheduleIfMissing(id);
      await this.geolocation.assignDefaultOfficeLocation(id, updated.departmentId, context);
    }

    if (dto.leaveAllocationDays !== undefined && employee.sex) {
      await this.updateGenderLeaveAllocation(id, employee.sex, dto.leaveAllocationDays);
    }

    if (newTemporaryPassword) {
      try {
        await this.mail.sendNewEmployeeCredentialsEmail(
          updated.user.email,
          newTemporaryPassword,
          `${updated.firstName} ${updated.lastName}`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to send updated credentials email to ${updated.user.email}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
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
        employmentStatus: employee.employmentStatus,
        attendanceMode: employee.attendanceMode,
      },
      newValues: {
        email: updated.user.email,
        firstName: updated.firstName,
        lastName: updated.lastName,
        department: updated.department.name,
        position: updated.position.title,
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
    dto: { reason?: string; archiveType?: string },
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

    if (employee.userId) {
      await this.prisma.user.update({
        where: { id: employee.userId },
        data: { status: "INACTIVE" },
      });
    }

    const archived = await this.prisma.employee.update({
      where: { id },
      data: { employmentStatus: "SEPARATED" },
      include: { user: true, department: true, position: true },
    });

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
}
