import { BadRequestException, ForbiddenException, Injectable, Logger } from "@nestjs/common";
import * as argon2 from "argon2";
import { generateTemporaryPassword } from "../../common/utils/password.util";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditLogContext, AuditLogsService } from "../audit-logs/audit-logs.service";
import { MailService } from "../mail/mail.service";
import { CreateEmployeeDto, CreateEmployeeSex, UpdateEmployeeDto } from "./dto/create-employee.dto";

const GENDER_LEAVE_TYPE_NAME: Record<string, string> = {
  MALE: "Paternity Leave",
  FEMALE: "Maternity Leave",
};

@Injectable()
export class EmployeesService {
  private readonly logger = new Logger(EmployeesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly mail: MailService,
  ) {}

  findAll(departmentId?: string) {
    return this.prisma.employee.findMany({
      where: departmentId ? { departmentId } : undefined,
      include: { user: true, department: true, position: true, supervisor: true },
      orderBy: { lastName: "asc" },
    });
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

  // Face enrollment and work-location assignment are both prerequisites the
  // mobile app checks before letting an employee attempt Time In/Out at all
  // (rather than only failing after they've already gone through the camera
  // scan) — see AttendanceScreen's eligibility gate.
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

    return { ...employee, hasActiveFaceEnrollment: faceProfiles.length > 0 };
  }

  updateMyPhoto(employeeId: string, profilePhotoData: string, profilePhotoMimeType: string) {
    return this.prisma.employee.update({
      where: { id: employeeId },
      data: { profilePhotoData, profilePhotoMimeType },
      include: { user: true, department: true, position: true },
    });
  }

  async create(dto: CreateEmployeeDto, context: AuditLogContext = {}, scopeDepartmentId?: string) {
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
        employeeNo: `UL-${Date.now().toString().slice(-6)}`,
        firstName: dto.firstName,
        lastName: dto.lastName,
        departmentId: department.id,
        positionId: position.id,
        hireDate: dto.hireDate ? new Date(dto.hireDate) : new Date(),
        employmentStatus: dto.employmentStatus,
        attendanceMode: dto.attendanceMode ?? "FIXED",
        sex: dto.sex,
        soloParentStatus: dto.soloParentStatus ?? "NOT_APPLICABLE",
        ...(resolvedSupervisorId !== undefined ? { supervisorId: resolvedSupervisorId } : {}),
      },
      include: { user: true, department: true, position: true, supervisor: true },
    });

    if (created.attendanceMode === "FIXED") {
      const standardShift = await this.prisma.shift.findFirst({
        where: { name: "Standard Shift", isActive: true },
        orderBy: { createdAt: "asc" },
      });

      if (standardShift) {
        await this.prisma.employeeSchedule.create({
          data: {
            employeeId: created.id,
            shiftId: standardShift.id,
            startsOn: new Date(),
          },
        });
      }
    }

    await this.assignGenderLeaveType(created.id, dto.sex);

    // Delivery failure shouldn't roll back an otherwise-successful hire —
    // the account and temporary password already exist either way.
    try {
      await this.mail.sendNewEmployeeCredentialsEmail(dto.email, temporaryPassword);
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

  // Male hires are auto-enrolled in Paternity Leave and female hires in
  // Maternity Leave so HR never has to add these manually after registration.
  private async assignGenderLeaveType(employeeId: string, sex: CreateEmployeeSex) {
    const leaveTypeName = GENDER_LEAVE_TYPE_NAME[sex];
    const leaveType = await this.prisma.leaveType.findFirst({ where: { name: leaveTypeName } });
    if (!leaveType) return;

    const year = new Date().getFullYear();
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

    if (dto.email) {
      if (!employee.userId) {
        throw new BadRequestException("Cannot update login email because this employee has no user account.");
      }

      await this.prisma.user.update({
        where: { id: employee.userId },
        data: { email: dto.email },
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

    const updated = await this.prisma.employee.update({
      where: { id },
      data: {
        ...(dto.firstName ? { firstName: dto.firstName } : {}),
        ...(dto.lastName ? { lastName: dto.lastName } : {}),
        ...(department ? { departmentId: department.id } : {}),
        ...(position ? { positionId: position.id } : {}),
        ...(dto.hireDate ? { hireDate: new Date(dto.hireDate) } : {}),
        ...(dto.employmentStatus ? { employmentStatus: dto.employmentStatus } : {}),
        ...(dto.attendanceMode ? { attendanceMode: dto.attendanceMode } : {}),
        ...(dto.soloParentStatus ? { soloParentStatus: dto.soloParentStatus } : {}),
        ...(resolvedSupervisorId !== undefined ? { supervisorId: resolvedSupervisorId } : {}),
      },
      include: { user: true, department: true, position: true, supervisor: true },
    });

    if (dto.leaveAllocationDays !== undefined && employee.sex) {
      await this.updateGenderLeaveAllocation(id, employee.sex, dto.leaveAllocationDays);
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
    const leaveTypeName = GENDER_LEAVE_TYPE_NAME[sex];
    if (!leaveTypeName) return;

    const leaveType = await this.prisma.leaveType.findFirst({ where: { name: leaveTypeName } });
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
