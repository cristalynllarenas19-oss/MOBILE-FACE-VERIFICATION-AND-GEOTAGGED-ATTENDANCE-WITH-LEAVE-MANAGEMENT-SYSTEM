import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { EmploymentStatus } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

type EmployeeTypeInput = { name?: string; description?: string | null; entitledToLeave?: boolean };

// "Leave Entitlement" in the admin form just picks which existing Employment
// Status a type's employees get — no leave logic changes. Entitled = the
// Regular Employee rules; Not entitled = the Probationary Employee rules.
const ENTITLED_STATUSES: EmploymentStatus[] = ["REGULAR", "PERMANENT_SEASONAL"];
const statusForEntitlement = (entitled: boolean): EmploymentStatus => (entitled ? "REGULAR" : "PROBATIONARY");
const isEntitled = (status: EmploymentStatus) => ENTITLED_STATUSES.includes(status);

@Injectable()
export class EmployeeTypesService {
  constructor(private readonly prisma: PrismaService) {}

  // Active-only by default — that's what every assignment dropdown/filter
  // wants. Utilities → Employee Types passes includeArchived to manage both.
  findAll(includeArchived = false) {
    return this.prisma.employeeType.findMany({
      where: includeArchived ? undefined : { isActive: true },
      orderBy: { createdAt: "asc" },
      include: {
        _count: { select: { employees: { where: { employmentStatus: { not: "SEPARATED" } } } } },
      },
    });
  }

  // For assigning a type to an employee: must exist and be active, unless
  // it's the type the employee already has (an archived type stays valid
  // for employees already on it — see schema.prisma's EmployeeType note).
  async resolveAssignable(id: string, currentTypeId?: string) {
    const type = await this.prisma.employeeType.findUnique({ where: { id } });
    if (!type) throw new BadRequestException("Selected employee type was not found.");
    if (!type.isActive && type.id !== currentTypeId) {
      throw new BadRequestException(`"${type.name}" is archived and can't be assigned to employees.`);
    }
    return type;
  }

  // Legacy callers (older mobile builds, Approve Regularization) still send a
  // bare employmentStatus — map it to the earliest-created active type with
  // that Employment Status (i.e. the initially seeded one).
  async resolveDefaultForEmploymentStatus(employmentStatus: string) {
    const types = await this.prisma.employeeType.findMany({
      where: { employmentStatus: employmentStatus as EmploymentStatus },
      orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
      take: 1,
    });
    if (!types[0]) {
      throw new BadRequestException(`No employee type is configured for employment status "${employmentStatus}".`);
    }
    return types[0];
  }

  private async assertNoDuplicateName(name: string, excludeId?: string) {
    const existing = await this.prisma.employeeType.findFirst({
      where: { name: { equals: name, mode: "insensitive" }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    });
    if (existing) throw new ConflictException(`An employee type named "${name}" already exists.`);
  }

  async create(dto: EmployeeTypeInput, actorUserId?: string) {
    const name = dto.name?.trim();
    if (!name) throw new BadRequestException("Employee type name is required.");
    await this.assertNoDuplicateName(name);

    const created = await this.prisma.employeeType.create({
      data: {
        name,
        description: dto.description?.trim() || null,
        employmentStatus: statusForEntitlement(dto.entitledToLeave ?? true),
      },
    });

    await this.prisma.auditLog.create({
      data: {
        actorUserId,
        action: "CREATE_EMPLOYEE_TYPE",
        entityType: "EmployeeType",
        entityId: created.id,
        newValues: { name: created.name, description: created.description, entitledToLeave: isEntitled(created.employmentStatus) },
      },
    });

    return created;
  }

  async update(id: string, dto: EmployeeTypeInput, actorUserId?: string) {
    const existing = await this.prisma.employeeType.findUniqueOrThrow({
      where: { id },
      include: { _count: { select: { employees: true } } },
    });

    const name = dto.name?.trim();
    if (dto.name !== undefined && !name) throw new BadRequestException("Employee type name is required.");
    if (name && name.toLowerCase() !== existing.name.toLowerCase()) {
      await this.assertNoDuplicateName(name, id);
    }

    // Only switchable while nobody is on the type — otherwise existing
    // employees' leave would change under them. Seasonal types keep their
    // own rules and can't be switched here at all.
    let employmentStatus: EmploymentStatus | undefined;
    if (dto.entitledToLeave !== undefined && dto.entitledToLeave !== isEntitled(existing.employmentStatus)) {
      if (existing.employmentStatus === "PERMANENT_SEASONAL" || existing.employmentStatus === "PROBATIONARY_SEASONAL") {
        throw new BadRequestException("Leave entitlement can't be changed for seasonal employee types.");
      }
      if (existing._count.employees > 0) {
        throw new BadRequestException(
          "Leave entitlement can't be changed while employees are assigned to this type. Move them to another type first.",
        );
      }
      employmentStatus = statusForEntitlement(dto.entitledToLeave);
    }

    const updated = await this.prisma.employeeType.update({
      where: { id },
      data: {
        ...(name ? { name } : {}),
        ...(dto.description !== undefined ? { description: dto.description?.trim() || null } : {}),
        ...(employmentStatus ? { employmentStatus } : {}),
      },
    });

    await this.prisma.auditLog.create({
      data: {
        actorUserId,
        action: "UPDATE_EMPLOYEE_TYPE",
        entityType: "EmployeeType",
        entityId: id,
        oldValues: { name: existing.name, description: existing.description, entitledToLeave: isEntitled(existing.employmentStatus) },
        newValues: { name: updated.name, description: updated.description, entitledToLeave: isEntitled(updated.employmentStatus) },
      },
    });

    return updated;
  }

  async setStatus(id: string, isActive: boolean, actorUserId?: string) {
    const updated = await this.prisma.employeeType.update({
      where: { id },
      data: { isActive, archivedAt: isActive ? null : new Date() },
    });

    await this.prisma.auditLog.create({
      data: {
        actorUserId,
        action: isActive ? "RESTORE_EMPLOYEE_TYPE" : "ARCHIVE_EMPLOYEE_TYPE",
        entityType: "EmployeeType",
        entityId: id,
        newValues: { isActive },
      },
    });

    return updated;
  }
}
