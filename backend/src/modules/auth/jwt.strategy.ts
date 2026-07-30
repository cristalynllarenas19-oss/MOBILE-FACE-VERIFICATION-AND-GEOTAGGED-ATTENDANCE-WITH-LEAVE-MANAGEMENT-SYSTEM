import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>("JWT_ACCESS_SECRET") ?? "dev-access-secret-change-me",
    });
  }

  async validate(payload: {
    sub: string;
    email: string;
    role: string;
    roles: string[];
    permissions: string[];
    employeeId?: string;
    departmentId?: string;
    tokenVersion: number;
  }) {
    // Checked on every request so a role change (e.g. an admin being replaced)
    // invalidates their already-issued token immediately instead of leaving
    // it valid until it naturally expires. Permissions are also read live so
    // role-permission seed/backfill changes take effect without a forced login.
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        tokenVersion: true,
        userRoles: {
          include: {
            role: {
              include: { permissions: { include: { permission: true } } },
            },
          },
        },
      },
    });

    if (!user || user.tokenVersion !== payload.tokenVersion) {
      throw new UnauthorizedException("Session is no longer valid.");
    }

    const roleObjs = user.userRoles.map((userRole) => userRole.role);
    const roles = roleObjs.map((role) => role.code);
    const permissions = [
      ...new Set(roleObjs.flatMap((role) => role.permissions.map((item) => item.permission.code))),
    ];

    return {
      userId: payload.sub,
      email: payload.email,
      role: roles[0] ?? payload.role,
      roles: roles.length ? roles : payload.roles,
      permissions,
      employeeId: payload.employeeId,
      departmentId: payload.departmentId,
    };
  }
}
