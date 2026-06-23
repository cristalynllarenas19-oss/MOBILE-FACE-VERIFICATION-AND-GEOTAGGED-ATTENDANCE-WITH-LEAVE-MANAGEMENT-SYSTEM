import { BadRequestException, Injectable, UnauthorizedException } from "@nestjs/common";
import * as argon2 from "argon2";
import { PrismaService } from "../../prisma/prisma.service";
import { CreateUserDto } from "./dto/create-user.dto";

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

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
    const passwordHash = await argon2.hash(dto.password);
    const department = await this.prisma.department.upsert({
      where: { name: "Human Resources" },
      update: {},
      create: { name: "Human Resources" },
    });
    const positionTitle = dto.role === "SUPERVISOR" ? "Department Supervisor" : "HR Admin";
    const position =
      (await this.prisma.position.findFirst({ where: { title: positionTitle } })) ??
      (await this.prisma.position.create({ data: { title: positionTitle } }));
    const employeeNo = dto.employeeNo?.trim() || `UL-${Date.now().toString().slice(-6)}`;

    return this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        userRoles: { create: { roleId: role.id } },
        employee: {
          create: {
            employeeNo,
            firstName: dto.firstName,
            lastName: dto.lastName,
            departmentId: department.id,
            positionId: position.id,
            hireDate: dto.hireDate ? new Date(dto.hireDate) : new Date(),
          },
        },
      },
      select: {
        id: true,
        email: true,
        status: true,
        userRoles: { include: { role: true } },
        employee: true,
      },
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
