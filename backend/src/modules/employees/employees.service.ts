import { Injectable } from "@nestjs/common";
import * as argon2 from "argon2";
import { PrismaService } from "../../prisma/prisma.service";
import { CreateEmployeeDto, UpdateEmployeeDto } from "./dto/create-employee.dto";
import { UpdateMeDto } from "./dto/update-me.dto";

@Injectable()
export class EmployeesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.employee.findMany({
      include: { user: true, department: true, position: true },
      orderBy: { lastName: "asc" },
    });
  }

  findMe(employeeId: string) {
    return this.prisma.employee.findUniqueOrThrow({
      where: { id: employeeId },
      include: { user: true, department: true, position: true },
    });
  }

  async updateMe(employeeId: string, dto: UpdateMeDto) {
    const employee = await this.prisma.employee.findUniqueOrThrow({ where: { id: employeeId } });

    if (dto.email) {
      await this.prisma.user.update({
        where: { id: employee.userId },
        data: { email: dto.email },
      });
    }

    return this.prisma.employee.update({
      where: { id: employeeId },
      data: {
        ...(dto.firstName ? { firstName: dto.firstName } : {}),
        ...(dto.lastName ? { lastName: dto.lastName } : {}),
        ...(dto.contactNumber !== undefined ? { contactNumber: dto.contactNumber } : {}),
        ...(dto.profilePhotoData !== undefined ? { profilePhotoData: dto.profilePhotoData } : {}),
        ...(dto.profilePhotoMimeType !== undefined ? { profilePhotoMimeType: dto.profilePhotoMimeType } : {}),
      },
      include: { user: true, department: true, position: true },
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

  async update(id: string, dto: UpdateEmployeeDto) {
    const employee = await this.prisma.employee.findUniqueOrThrow({ where: { id } });
    const department = dto.department
      ? await this.prisma.department.upsert({
          where: { name: dto.department },
          update: {},
          create: { name: dto.department },
        })
      : null;
    const position = dto.position
      ? (await this.prisma.position.findFirst({ where: { title: dto.position } })) ??
        (await this.prisma.position.create({ data: { title: dto.position } }))
      : null;

    if (dto.email) {
      await this.prisma.user.update({
        where: { id: employee.userId },
        data: { email: dto.email },
      });
    }

    return this.prisma.employee.update({
      where: { id },
      data: {
        ...(dto.firstName ? { firstName: dto.firstName } : {}),
        ...(dto.lastName ? { lastName: dto.lastName } : {}),
        ...(department ? { departmentId: department.id } : {}),
        ...(position ? { positionId: position.id } : {}),
        ...(dto.hireDate ? { hireDate: new Date(dto.hireDate) } : {}),
        ...(dto.employmentStatus ? { employmentStatus: dto.employmentStatus } : {}),
      },
      include: { user: true, department: true, position: true },
    });
  }

  async archive(id: string, dto: { reason?: string; archiveType?: string }) {
    const employee = await this.prisma.employee.findUniqueOrThrow({
      where: { id },
      include: { user: true },
    });

    await this.prisma.user.update({
      where: { id: employee.userId },
      data: { status: "INACTIVE" },
    });

    const archived = await this.prisma.employee.update({
      where: { id },
      data: { employmentStatus: "SEPARATED" },
      include: { user: true, department: true, position: true },
    });

    await this.prisma.auditLog.create({
      data: {
        action: "ARCHIVE_EMPLOYEE",
        entityType: "Employee",
        entityId: id,
        newValues: {
          archiveType: dto.archiveType ?? "Separated",
          reason: dto.reason?.trim() || "No reason provided",
          userStatus: "INACTIVE",
          employmentStatus: "SEPARATED",
        },
      },
    });

    return archived;
  }
}
