import { BadRequestException, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { randomInt } from "crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { MailService } from "../mail/mail.service";

const RESET_PURPOSE = "password_reset";
const OTP_TTL_MS = 10 * 60 * 1000;
const RESET_TOKEN_TTL = "5m";
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const GENERIC_FORGOT_PASSWORD_MESSAGE =
  "If an account with that email exists, a verification code has been sent.";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {}

  async login(email: string, password: string) {
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

    const passwordValid = await argon2.verify(user.passwordHash, password);
    if (!passwordValid) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const role = user.userRoles[0]?.role;
    const permissions = role?.permissions.map((item) => item.permission.code) ?? [];
    const displayName = user.employee ? `${user.employee.firstName} ${user.employee.lastName}` : user.email;
    const payload = {
      sub: user.id,
      email: user.email,
      role: role?.code,
      permissions,
      employeeId: user.employee?.id,
      departmentId: user.employee?.departmentId,
    };

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return {
      accessToken: await this.jwtService.signAsync(payload, {
        secret: this.config.get<string>("JWT_ACCESS_SECRET") ?? "dev-access-secret-change-me",
        expiresIn: "15m",
      }),
      refreshToken: await this.jwtService.signAsync(payload, {
        secret: this.config.get<string>("JWT_REFRESH_SECRET") ?? "dev-refresh-secret-change-me",
        expiresIn: "7d",
      }),
      user: {
        id: user.id,
        email: user.email,
        role: role?.code,
        permissions,
        employeeId: user.employee?.id,
        departmentId: user.employee?.departmentId,
        department: user.employee?.department?.name,
        displayName,
      },
    };
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
