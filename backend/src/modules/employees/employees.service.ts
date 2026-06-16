import { Injectable } from "@nestjs/common";
import * as argon2 from "argon2";
import { PrismaService } from "../../prisma/prisma.service";
import { CreateEmployeeDto } from "./dto/create-employee.dto";

@Injectable()
export class EmployeesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.employee.findMany({
      include: { user: true, department: true, position: true },
      orderBy: { lastName: "asc" },
    });
  }

  async create(dto: CreateEmployeeDto) {
    const role = await this.prisma.role.findUniqueOrThrow({ where: { code: "EMPLOYEE" } });
    const department = await this.prisma.department.upsert({
      where: { name: dto.department },
      update: {},
      create: { name: dto.department },
    });
    const position =
      (await this.prisma.position.findFirst({ where: { title: dto.position } })) ??
      (await this.prisma.position.create({ data: { title: dto.position } }));

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash: await argon2.hash(dto.password),
        userRoles: { create: { roleId: role.id } },
      },
    });

    return this.prisma.employee.create({
      data: {
        userId: user.id,
        employeeNo: `UL-${Date.now().toString().slice(-6)}`,
        firstName: dto.firstName,
        lastName: dto.lastName,
        departmentId: department.id,
        positionId: position.id,
        hireDate: dto.hireDate ? new Date(dto.hireDate) : new Date(),
        employmentStatus: dto.employmentStatus,
      },
      include: { user: true, department: true, position: true },
    });
  }
}
