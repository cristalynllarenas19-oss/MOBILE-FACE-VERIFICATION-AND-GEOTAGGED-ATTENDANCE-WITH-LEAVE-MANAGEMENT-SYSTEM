import { BadRequestException, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { randomInt } from "crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { MailService } from "../mail/mail.service";
import { AuditLogContext, AuditLogsService } from "../audit-logs/audit-logs.service";

const RESET_PURPOSE = "password_reset";
const OTP_TTL_MS = 10 * 60 * 1000;
const RESET_TOKEN_TTL = "5m";
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const GENERIC_FORGOT_PASSWORD_MESSAGE =
  "If an account with that email exists, a verification code has been sent.";

type AuthTokenPayload = {
  sub: string;
  email: string;
  role: string | undefined;
  roles: string[];
  permissions: string[];
  employeeId?: string;
  departmentId?: string;
  tokenVersion: number;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async login(email: string, password: string | undefined, context: AuditLogContext = {}) {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: {
        employee: { include: { department: true } },
        userRoles: {
          include: {
            role: {
              include: { permissions: { include: { permission: true } } },
            },
          },
        },
      },
    });

    if (!user || user.status !== "ACTIVE") {
      throw new UnauthorizedException("Invalid credentials");
    }

    // A brand-new employee has no password yet (passwordHash is null) and is
    // let in on email alone; they're forced to set one right after (see
    // mustChangePassword below and UsersService.changePassword).
    if (user.passwordHash) {
      if (!password || !(await argon2.verify(user.passwordHash, password))) {
        throw new UnauthorizedException("Invalid credentials");
      }
    }

    const roleObjs = user.userRoles.map((userRole) => userRole.role);
    const roles = roleObjs.map((role) => role.code);
    const primaryRole = roleObjs[0]?.code;
    const permissions = [
      ...new Set(roleObjs.flatMap((role) => role.permissions.map((item) => item.permission.code))),
    ];
    // Scoped to ADMIN/SUPERVISOR roles only — used by the frontend to decide
    // which admin-side modules to show, so a Supervisor's implicit EMPLOYEE
    // role (granted for their own attendance/leave self-service) never leaks
    // extra modules into their admin nav. `permissions` above stays the full
    // union and remains what backend route guards check.
    const adminPermissions = [
      ...new Set(
        roleObjs
          .filter((role) => role.code !== "EMPLOYEE")
          .flatMap((role) => role.permissions.map((item) => item.permission.code)),
      ),
    ];
    const displayName = user.employee ? `${user.employee.firstName} ${user.employee.lastName}` : user.email;
    const payload: AuthTokenPayload = {
      sub: user.id,
      email: user.email,
      role: primaryRole,
      roles,
      permissions,
      employeeId: user.employee?.id,
      departmentId: user.employee?.departmentId,
      tokenVersion: user.tokenVersion,
    };

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // Only one ADMIN is ever *active* — granting the role doesn't log out the
    // outgoing admin (see UsersService.create); that handoff happens the
    // moment the NEWLY-APPOINTED admin first logs in. Eviction is by grant
    // recency: only admins granted *earlier* than the logging-in admin are
    // evicted, so the outgoing admin logging back in first evicts nobody and
    // can never take the role away from the new appointee.
    const adminRole = user.userRoles.find((userRole) => userRole.role.code === "ADMIN");
    if (adminRole) {
      await this.evictOutrankedAdmins(user.id, adminRole.assignedAt, displayName, context);
    }

    await this.auditLogs.record({
      ...context,
      actorUserId: user.id,
      actorRole: primaryRole,
      action: "LOGIN",
      module: "Authentication",
      entityType: "User",
      entityId: user.id,
      description: `${displayName} logged in.`,
      newValues: { email: user.email, roles },
    });

    return {
      accessToken: await this.jwtService.signAsync(payload, {
        secret: this.config.get<string>("JWT_ACCESS_SECRET") ?? "dev-access-secret-change-me",
        // 12h keeps the access token short-lived while mobile can refresh it.
        // uses its stored refreshToken (apiRequest has no refresh-and-retry,
        // and /auth/refresh is a stub), so once this expires every request
        // 401s until the user logs in again — shorten only after real
        // refresh-token rotation exists.
        expiresIn: "12h",
      }),
      refreshToken: await this.jwtService.signAsync(payload, {
        secret: this.config.get<string>("JWT_REFRESH_SECRET") ?? "dev-refresh-secret-change-me",
        expiresIn: "7d",
      }),
      user: {
        id: user.id,
        email: user.email,
        role: primaryRole,
        roles,
        permissions,
        adminPermissions,
        employeeId: user.employee?.id,
        departmentId: user.employee?.departmentId,
        department: user.employee?.department?.name,
        displayName,
        attendanceMode: user.employee?.attendanceMode,
        defaultView: user.defaultView,
        mustChangePassword: user.mustChangePassword,
        faceConsentAcceptedAt: user.employee?.faceConsentAcceptedAt ?? null,
        requiresFaceConsent: user.employee?.requiresFaceConsent ?? false,
      },
    };
  }

  async refresh(refreshToken: string) {
    let payload: AuthTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<AuthTokenPayload>(refreshToken, {
        secret: this.config.get<string>("JWT_REFRESH_SECRET") ?? "dev-refresh-secret-change-me",
      });
    } catch {
      throw new UnauthorizedException("Session has expired. Please log in again.");
    }

    // Preserve immediate invalidation when an account is disabled or an
    // administrator changes its roles/permissions.
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { status: true, tokenVersion: true },
    });
    if (!user || user.status !== "ACTIVE" || user.tokenVersion !== payload.tokenVersion) {
      throw new UnauthorizedException("Session is no longer valid.");
    }

    // verifyAsync returns the full decoded JWT, including the exp/iat claims
    // stamped on the old refresh token — signAsync refuses to issue a new
    // token when the payload already carries an exp, so those must be
    // dropped before reusing this payload to sign the new token pair.
    const { exp, iat, ...freshPayload } = payload as AuthTokenPayload & { exp?: number; iat?: number };
    return this.issueTokenPair(freshPayload);
  }

  private async issueTokenPair(payload: AuthTokenPayload) {
    return {
      accessToken: await this.jwtService.signAsync(payload, {
        secret: this.config.get<string>("JWT_ACCESS_SECRET") ?? "dev-access-secret-change-me",
        expiresIn: "12h",
      }),
      refreshToken: await this.jwtService.signAsync(payload, {
        secret: this.config.get<string>("JWT_REFRESH_SECRET") ?? "dev-refresh-secret-change-me",
        expiresIn: "7d",
      }),
    };
  }

  // Revokes ADMIN from every account whose grant is OLDER than the
  // logging-in admin's, falling back to EMPLOYEE for anyone left with zero
  // roles, and bumps their tokenVersion so their existing session is
  // rejected on its very next request (see JwtStrategy.validate) instead of
  // staying valid until it expires.
  private async evictOutrankedAdmins(
    newAdminId: string,
    newAdminAssignedAt: Date,
    newAdminName: string,
    context: AuditLogContext,
  ) {
    // Neon can take several seconds to respond on a cold connection —
    // Prisma's default 5s interactive-transaction timeout is too tight,
    // hence the explicit timeout below.
    const evicted = await this.prisma.$transaction(async (tx) => {
      const outrankedAdmins = await tx.user.findMany({
        where: {
          id: { not: newAdminId },
          userRoles: { some: { role: { code: "ADMIN" }, assignedAt: { lt: newAdminAssignedAt } } },
        },
        select: { id: true, email: true, employee: true, userRoles: { include: { role: true } } },
      });

      const result: { id: string; email: string; name: string }[] = [];
      for (const admin of outrankedAdmins) {
        await tx.userRole.deleteMany({ where: { userId: admin.id, role: { code: "ADMIN" } } });

        const remainingRoles = admin.userRoles.filter((userRole) => userRole.role.code !== "ADMIN");
        if (remainingRoles.length === 0) {
          const employeeRole = await tx.role.findUniqueOrThrow({ where: { code: "EMPLOYEE" } });
          await tx.userRole.create({ data: { userId: admin.id, roleId: employeeRole.id } });
        }

        await tx.user.update({ where: { id: admin.id }, data: { tokenVersion: { increment: 1 } } });

        result.push({
          id: admin.id,
          email: admin.email,
          name: admin.employee ? `${admin.employee.firstName} ${admin.employee.lastName}` : admin.email,
        });
      }
      return result;
    }, { timeout: 15000 });

    for (const admin of evicted) {
      await this.auditLogs.record({
        ...context,
        action: "REVOKE_USER_ROLE",
        module: "Users",
        entityType: "User",
        entityId: admin.id,
        description: `Revoked ADMIN access from ${admin.name} — ${newAdminName} logged in as the newly appointed admin. Account was logged out immediately.`,
        newValues: { revokedRole: "ADMIN", email: admin.email },
      });
    }
  }

  async logout(context: AuditLogContext = {}) {
    await this.auditLogs.record({
      ...context,
      action: "LOGOUT",
      module: "Authentication",
      entityType: "User",
      entityId: context.actorUserId,
      description: "User logged out.",
    });

    return { message: "Logged out" };
  }

  private get accessSecret() {
    return this.config.get<string>("JWT_ACCESS_SECRET") ?? "dev-access-secret-change-me";
  }

  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (user) {
      const lastOtp = await this.prisma.passwordResetOtp.findFirst({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
      });

      if (lastOtp && Date.now() - lastOtp.createdAt.getTime() < RESEND_COOLDOWN_MS) {
        throw new BadRequestException("Please wait a minute before requesting another code.");
      }

      const otp = randomInt(100000, 1000000).toString();
      await this.prisma.passwordResetOtp.create({
        data: {
          userId: user.id,
          otpHash: await argon2.hash(otp),
          expiresAt: new Date(Date.now() + OTP_TTL_MS),
        },
      });

      await this.mail.sendOtpEmail(user.email, otp);
    }

    return { message: GENERIC_FORGOT_PASSWORD_MESSAGE };
  }

  async verifyResetOtp(email: string, otp: string) {
    const invalidCodeError = new UnauthorizedException("Invalid or expired code.");
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw invalidCodeError;
    }

    const otpRow = await this.prisma.passwordResetOtp.findFirst({
      where: { userId: user.id, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });

    if (!otpRow || otpRow.attempts >= MAX_OTP_ATTEMPTS) {
      throw invalidCodeError;
    }

    const matches = await argon2.verify(otpRow.otpHash, otp);
    if (!matches) {
      await this.prisma.passwordResetOtp.update({
        where: { id: otpRow.id },
        data: { attempts: { increment: 1 } },
      });
      throw invalidCodeError;
    }

    await this.prisma.passwordResetOtp.update({
      where: { id: otpRow.id },
      data: { verifiedAt: new Date() },
    });

    const resetToken = await this.jwtService.signAsync(
      { sub: user.id, otpId: otpRow.id, purpose: RESET_PURPOSE },
      { secret: this.accessSecret, expiresIn: RESET_TOKEN_TTL },
    );

    return { resetToken };
  }

  async resetPassword(resetToken: string, newPassword: string) {
    const sessionExpiredError = new BadRequestException(
      "This reset session has expired. Please request a new code.",
    );

    let payload: { sub: string; otpId: string; purpose: string };
    try {
      payload = await this.jwtService.verifyAsync(resetToken, { secret: this.accessSecret });
    } catch {
      throw sessionExpiredError;
    }

    if (payload.purpose !== RESET_PURPOSE) {
      throw sessionExpiredError;
    }

    const otpRow = await this.prisma.passwordResetOtp.findUnique({ where: { id: payload.otpId } });
    if (!otpRow || otpRow.userId !== payload.sub || !otpRow.verifiedAt || otpRow.consumedAt) {
      throw sessionExpiredError;
    }

    await this.prisma.user.update({
      where: { id: payload.sub },
      data: { passwordHash: await argon2.hash(newPassword) },
    });

    await this.prisma.passwordResetOtp.update({
      where: { id: otpRow.id },
      data: { consumedAt: new Date() },
    });

    return { message: "Your password has been updated. You can now log in." };
  }
}
