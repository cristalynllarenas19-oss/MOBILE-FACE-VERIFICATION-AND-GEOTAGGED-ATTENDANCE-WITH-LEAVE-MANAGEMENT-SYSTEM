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

  async changePassword(userId: string, currentPassword: string | undefined, newPassword: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    if (user.passwordHash) {
      const valid = currentPassword ? await argon2.verify(user.passwordHash, currentPassword) : false;
      if (!valid) {
        throw new UnauthorizedException("Current password is incorrect.");
      }
      if (currentPassword === newPassword) {
        throw new BadRequestException("New password must be different from the current password.");
      }
    } else {
      // First-time setup: no existing password to verify against, but the
      // employee's chosen password must meet the stricter initial policy.
      this.assertValidInitialPassword(newPassword);
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await argon2.hash(newPassword), mustChangePassword: false },
    });

    return { message: "Password updated." };
  }

  // Standard for a brand-new employee's first password: at least 10
  // characters, letters and digits only, with at least one of each.
  private assertValidInitialPassword(password: string) {
    if (password.length < 10 || !/^[A-Za-z0-9]+$/.test(password)) {
      throw new BadRequestException(
        "Password must be at least 10 characters and contain only letters and numbers.",
      );
    }
    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      throw new BadRequestException("Password must include at least one letter and one number.");
    }
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

    // Only one account may hold ADMIN at a time — granting it here transfers
    // the role immediately: every other holder loses ADMIN in the same
    // transaction (falling back to EMPLOYEE if left with no roles) and has
    // their tokenVersion bumped so their existing session is rejected on its
    // very next request (see JwtStrategy.validate).
    const evictedAdmins = await this.prisma.$transaction(
      async (tx) => {
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

        if (dto.role !== "ADMIN") return [];

        const otherAdmins = await tx.user.findMany({
          where: {
            id: { not: employeeUserId },
            userRoles: { some: { role: { code: "ADMIN" } } },
          },
          select: { id: true, email: true, employee: true, userRoles: { include: { role: true } } },
        });

        const evicted: { id: string; email: string; name: string }[] = [];
        for (const admin of otherAdmins) {
          await tx.userRole.deleteMany({ where: { userId: admin.id, role: { code: "ADMIN" } } });

          const remainingRoles = admin.userRoles.filter((userRole) => userRole.role.code !== "ADMIN");
          if (remainingRoles.length === 0) {
            const employeeRole = await tx.role.findUniqueOrThrow({ where: { code: "EMPLOYEE" } });
            await tx.userRole.create({ data: { userId: admin.id, roleId: employeeRole.id } });
          }

          await tx.user.update({ where: { id: admin.id }, data: { tokenVersion: { increment: 1 } } });

          evicted.push({
            id: admin.id,
            email: admin.email,
            name: admin.employee ? `${admin.employee.firstName} ${admin.employee.lastName}` : admin.email,
          });
        }
        return evicted;
      },
      // Neon can take several seconds to respond on a cold connection —
      // Prisma's default 5s interactive-transaction timeout is too tight.
      { timeout: 15000 },
    );

    const created = await this.prisma.user.findUniqueOrThrow({
      where: { id: employeeUserId },
      select: {
        id: true,
        email: true,
        status: true,
        userRoles: { include: { role: true } },
        employee: true,
      },
    });

    const newAdminName = created.employee
      ? `${created.employee.firstName} ${created.employee.lastName}`
      : created.email;
    for (const admin of evictedAdmins) {
      await this.auditLogs.record({
        ...context,
        action: "REVOKE_USER_ROLE",
        module: "Users",
        entityType: "User",
        entityId: admin.id,
        description: `Revoked ADMIN access from ${admin.name} — admin access was transferred to ${newAdminName}. Account was logged out immediately.`,
        newValues: { revokedRole: "ADMIN", email: admin.email },
      });
    }

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
