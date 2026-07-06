import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import * as argon2 from "argon2";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditLogContext, AuditLogsService } from "../audit-logs/audit-logs.service";
import { CreateEmployeeDto, CreateEmployeeSex, UpdateEmployeeDto } from "./dto/create-employee.dto";

const GENDER_LEAVE_TYPE_NAME: Record<string, string> = {
  MALE: "Paternity Leave",
  FEMALE: "Maternity Leave",
};

@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  findAll(departmentId?: string) {
    return this.prisma.employee.findMany({
      where: departmentId ? { departmentId } : undefined,
      include: { user: true, department: true, position: true },
      orderBy: { lastName: "asc" },
    });
  }

  findMe(employeeId: string) {
    return this.prisma.employee.findUniqueOrThrow({
      where: { id: employeeId },
      include: { user: true, department: true, position: true },
    });
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

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash: await argon2.hash(dto.password),
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
      },
      include: { user: true, department: true, position: true },
    });

    await this.assignGenderLeaveType(created.id, dto.sex);

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
      },
      include: { user: true, department: true, position: true },
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
