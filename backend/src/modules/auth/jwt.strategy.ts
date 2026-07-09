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
    // it valid until it naturally expires.
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { tokenVersion: true },
    });

    if (!user || user.tokenVersion !== payload.tokenVersion) {
      throw new UnauthorizedException("Session is no longer valid.");
    }

    return {
      userId: payload.sub,
      email: payload.email,
      role: payload.role,
      roles: payload.roles,
      permissions: payload.permissions,
      employeeId: payload.employeeId,
      departmentId: payload.departmentId,
    };
  }
}
