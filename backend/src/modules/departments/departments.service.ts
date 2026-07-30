import { ConflictException, Injectable } from "@nestjs/common";
import { DepartmentAttendanceMode } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class DepartmentsService {
  constructor(private readonly prisma: PrismaService) {}

  findAttendanceModes() {
    return this.prisma.$queryRaw<
      {
        id: string;
        code: DepartmentAttendanceMode;
        label: string;
        description: string | null;
        sortOrder: number;
        isActive: boolean;
        availableForEmployees: boolean;
        availableForDepartments: boolean;
      }[]
    >`
      SELECT
        id,
        code,
        label,
        description,
        sort_order AS "sortOrder",
        is_active AS "isActive",
        available_for_employees AS "availableForEmployees",
        available_for_departments AS "availableForDepartments"
      FROM attendance_mode_options
      WHERE is_active = true
      ORDER BY sort_order ASC, label ASC
    `;
  }

  findAll() {
    return this.prisma.department.findMany({
      orderBy: { name: "asc" },
      include: {
        _count: { select: { employees: true } },
      },
    });
  }

  private async assertNoDuplicateName(name: string, excludeId?: string) {
    const existing = await this.prisma.department.findFirst({
      where: { name: { equals: name, mode: "insensitive" }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    });
    if (existing) throw new ConflictException(`A department named "${name}" already exists.`);
  }

  async create(dto: { name: string; attendanceMode?: DepartmentAttendanceMode }, actorUserId?: string) {
    const name = dto.name.trim();
    await this.assertNoDuplicateName(name);

    const created = await this.prisma.department.create({
      data: { name, attendanceMode: dto.attendanceMode ?? "BOTH" },
    });

    await this.prisma.auditLog.create({
      data: {
        actorUserId,
        action: "CREATE_DEPARTMENT",
        entityType: "Department",
        entityId: created.id,
        newValues: { name: created.name, attendanceMode: created.attendanceMode },
      },
    });

    return created;
  }

  async update(id: string, dto: { name?: string; attendanceMode?: DepartmentAttendanceMode }, actorUserId?: string) {
    const existing = await this.prisma.department.findUniqueOrThrow({ where: { id } });

    const name = dto.name?.trim();
    if (name && name !== existing.name) {
      await this.assertNoDuplicateName(name, id);
    }

    const updated = await this.prisma.department.update({
      where: { id },
      data: { name, attendanceMode: dto.attendanceMode },
    });

    await this.prisma.auditLog.create({
      data: {
        actorUserId,
        action: "UPDATE_DEPARTMENT",
        entityType: "Department",
        entityId: id,
        oldValues: { name: existing.name, attendanceMode: existing.attendanceMode },
        newValues: { name: updated.name, attendanceMode: updated.attendanceMode },
      },
    });

    return updated;
  }

  async setStatus(id: string, isActive: boolean, actorUserId?: string) {
    const updated = await this.prisma.department.update({
      where: { id },
      data: { isActive },
    });

    await this.prisma.auditLog.create({
      data: {
        actorUserId,
        action: isActive ? "RESTORE_DEPARTMENT" : "ARCHIVE_DEPARTMENT",
        entityType: "Department",
        entityId: id,
        newValues: { isActive },
      },
    });

    return updated;
  }
}
