import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: {
        employee: true,
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
        displayName,
      },
    };
  }
}
