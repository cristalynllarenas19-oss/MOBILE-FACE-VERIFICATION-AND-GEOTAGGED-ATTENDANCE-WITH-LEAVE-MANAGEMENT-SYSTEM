import { Injectable } from "@nestjs/common";
import * as argon2 from "argon2";
import { PrismaService } from "../../prisma/prisma.service";
import { CreateUserDto } from "./dto/create-user.dto";

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.user.findMany({
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

  async create(dto: CreateUserDto) {
    const role = await this.prisma.role.findUniqueOrThrow({ where: { code: dto.role } });
    return this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash: await argon2.hash(dto.password),
        userRoles: { create: { roleId: role.id } },
      },
      select: { id: true, email: true, status: true },
    });
  }

  updateStatus(id: string, status: "ACTIVE" | "INACTIVE" | "LOCKED") {
    return this.prisma.user.update({
      where: { id },
      data: { status },
      select: { id: true, email: true, status: true },
    });
  }
}
