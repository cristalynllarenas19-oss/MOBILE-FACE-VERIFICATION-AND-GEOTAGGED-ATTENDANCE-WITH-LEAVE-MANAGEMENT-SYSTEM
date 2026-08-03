import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class DepartmentsService {
  constructor(private readonly prisma: PrismaService) {}

  findAttendanceModes() {
    return this.prisma.attendanceMode.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
    });
  }

  // Validates an incoming department-level attendanceMode code against the
  // DB-managed set (rather than a compiled enum) — "BOTH" (or any other row
  // flagged availableForDepartments) is legal here even though it's excluded
  // from the employee-level set in EmployeesService.
  private async resolveDepartmentAttendanceMode(code: string) {
    const mode = await this.prisma.attendanceMode.findUnique({ where: { code } });
    if (!mode || !mode.isActive || !mode.availableForDepartments) {
      throw new BadRequestException(`"${code}" is not a valid attendance mode for a department.`);
    }
    return mode.code;
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

  async create(dto: { name: string; attendanceMode?: string }, actorUserId?: string) {
    const name = dto.name.trim();
    await this.assertNoDuplicateName(name);
    const attendanceMode = dto.attendanceMode
      ? await this.resolveDepartmentAttendanceMode(dto.attendanceMode)
      : "BOTH";

    const created = await this.prisma.department.create({
      data: { name, attendanceMode },
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

  async update(id: string, dto: { name?: string; attendanceMode?: string }, actorUserId?: string) {
    const existing = await this.prisma.department.findUniqueOrThrow({ where: { id } });

    const name = dto.name?.trim();
    if (name && name !== existing.name) {
      await this.assertNoDuplicateName(name, id);
    }

    const attendanceMode = dto.attendanceMode
      ? await this.resolveDepartmentAttendanceMode(dto.attendanceMode)
      : undefined;

    // A department's restriction (anything other than "BOTH") forces every
    // employee currently in it to that same mode — done in the same
    // transaction as the department update itself. Moving TO "BOTH" doesn't
    // cascade: existing employees keep whatever mode they were last given,
    // and HR can still edit them individually going forward.
    const [updated] = await this.prisma.$transaction([
      this.prisma.department.update({
        where: { id },
        data: { name, attendanceMode },
      }),
      ...(attendanceMode && attendanceMode !== "BOTH" && attendanceMode !== existing.attendanceMode
        ? [this.prisma.employee.updateMany({ where: { departmentId: id }, data: { attendanceMode } })]
        : []),
    ]);

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
