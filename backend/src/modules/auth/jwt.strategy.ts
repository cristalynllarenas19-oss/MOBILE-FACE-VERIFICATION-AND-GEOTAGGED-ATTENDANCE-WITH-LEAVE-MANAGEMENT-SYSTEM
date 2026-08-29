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
    // it valid until it naturally expires. Permissions and the employee's
    // department are also read live (rather than trusted from the token
    // payload) so a department reassignment takes effect immediately instead
    // of waiting for the Supervisor to log out and back in.
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
        employee: { select: { id: true, departmentId: true } },
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
      employeeId: user.employee?.id ?? payload.employeeId,
      departmentId: user.employee?.departmentId ?? payload.departmentId,
    };
  }
}
