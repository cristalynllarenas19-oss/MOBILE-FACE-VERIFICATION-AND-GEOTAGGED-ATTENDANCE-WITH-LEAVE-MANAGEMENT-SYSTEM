import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import * as argon2 from "argon2";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditLogContext, AuditLogsService } from "../audit-logs/audit-logs.service";
import { CreateUserDto } from "./dto/create-user.dto";

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const valid = await argon2.verify(user.passwordHash, currentPassword);
    if (!valid) {
      throw new UnauthorizedException("Current password is incorrect.");
    }
    if (currentPassword === newPassword) {
      throw new BadRequestException("New password must be different from the current password.");
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await argon2.hash(newPassword) },
    });

    return { message: "Password updated." };
  }

  // Only accounts that have actually been granted a system role ever show up
  // in User Management — a plain employee (EMPLOYEE role only, auto-created
  // in Employee Management) is not "in" User Management at all.
  findAll() {
    return this.prisma.user.findMany({
      where: { userRoles: { some: { role: { code: { in: ["ADMIN", "SUPERVISOR"] } } } } },
      select: {
        id: true,
        email: true,
        status: true,
        lastLoginAt: true,
        userRoles: { include: { role: true } },
        employee: true,
      },
      orderBy: { createdAt: "desc" },
    });
  }

  // Grants a role to an employee's existing account — never creates a new
  // account or credentials. Employee Management is the only place an account
  // (email/password) is ever created.
  async create(dto: CreateUserDto, context: AuditLogContext = {}) {
    const role = await this.prisma.role.findUniqueOrThrow({ where: { code: dto.role } });

    const employee = await this.prisma.employee.findUnique({
      where: { id: dto.employeeId },
      select: { userId: true, departmentId: true },
    });

    if (!employee) {
      throw new BadRequestException("Selected employee does not exist.");
    }

    if (!employee.userId) {
      throw new BadRequestException("Selected employee does not have a linked user account.");
    }

    if (dto.role === "SUPERVISOR" && !employee.departmentId) {
      throw new BadRequestException("Employee must be assigned to a department before being assigned as a Supervisor.");
    }

    const employeeUserId = employee.userId;

    const created = await this.prisma.$transaction(async (tx) => {
      // Only clears the role being (re)assigned — an existing EMPLOYEE role
      // (or any other) must survive so the account keeps attendance-portal
      // access after being granted HR/Supervisor access.
      await tx.userRole.deleteMany({
        where: {
          userId: employeeUserId,
          role: { code: { in: ["ADMIN", "SUPERVISOR"] } },
        },
      });
      await tx.userRole.create({ data: { userId: employeeUserId, roleId: role.id } });

      return tx.user.findUniqueOrThrow({
        where: { id: employeeUserId },
        select: {
          id: true,
          email: true,
          status: true,
          userRoles: { include: { role: true } },
          employee: true,
        },
      });
    });

    await this.auditLogs.record({
      ...context,
      action: "GRANT_USER_ROLE",
      module: "Users",
      entityType: "User",
      entityId: created.id,
      description: `Granted ${dto.role} access to ${created.employee?.firstName ?? created.email}.`,
      newValues: { role: dto.role, email: created.email, employeeId: dto.employeeId },
    });

    return created;
  }

  async updateStatus(id: string, status: "ACTIVE" | "INACTIVE" | "LOCKED", context: AuditLogContext = {}) {
    const before = await this.prisma.user.findUniqueOrThrow({
      where: { id },
      select: { id: true, email: true, status: true },
    });
    const updated = await this.prisma.user.update({
      where: { id },
      data: { status },
      select: { id: true, email: true, status: true },
    });

    await this.auditLogs.record({
      ...context,
      action: status === "ACTIVE" ? "ACTIVATE_USER" : status === "INACTIVE" ? "DEACTIVATE_USER" : "LOCK_USER",
      module: "Users",
      entityType: "User",
      entityId: id,
      description: `Changed ${updated.email} account status to ${status}.`,
      oldValues: { status: before.status },
      newValues: { status: updated.status, email: updated.email },
    });

    return updated;
  }

  async updateDefaultView(id: string, defaultView: "ADMIN" | "EMPLOYEE", requesterId: string, context: AuditLogContext = {}) {
    if (id !== requesterId) {
      throw new ForbiddenException("You can only update your own default view.");
    }

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id },
      select: { userRoles: true },
    });

    if (user.userRoles.length <= 1) {
      throw new BadRequestException("Default view is only available for accounts with more than one role.");
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: { defaultView },
      select: { id: true, defaultView: true },
    });

    await this.auditLogs.record({
      ...context,
      action: "UPDATE_SYSTEM_SETTING",
      module: "Settings",
      entityType: "User",
      entityId: id,
      description: "Updated default portal view.",
      newValues: { defaultView: updated.defaultView },
    });

    return updated;
  }
}
