import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { PositionDepartmentScope } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

type PositionInput = { title?: string; departmentScope?: string; departmentIds?: string[] };

const SCOPES = new Set<string>(Object.values(PositionDepartmentScope));

// Is this position offered in that department? The single rule behind both
// the Add Employee dropdown and create-employee validation.
export function isPositionAvailableIn(
  position: { isActive: boolean; departmentScope: PositionDepartmentScope; departments: { departmentId: string }[] },
  departmentId: string,
) {
  if (!position.isActive) return false;
  const listed = position.departments.some((link) => link.departmentId === departmentId);
  if (position.departmentScope === "ALL") return true;
  if (position.departmentScope === "ALL_EXCEPT") return !listed;
  return listed;
}

@Injectable()
export class PositionsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.position.findMany({
      orderBy: [{ createdAt: "asc" }, { title: "asc" }],
      include: {
        departments: { include: { department: { select: { id: true, name: true } } } },
        _count: { select: { employees: { where: { employmentStatus: { not: "SEPARATED" } } } } },
      },
    });
  }

  async findAvailableForDepartment(departmentId: string) {
    const positions = await this.prisma.position.findMany({
      where: { isActive: true },
      orderBy: [{ createdAt: "asc" }, { title: "asc" }],
      include: { departments: { select: { departmentId: true } } },
    });
    return positions
      .filter((position) => isPositionAvailableIn(position, departmentId))
      .map(({ id, title }) => ({ id, title }));
  }

  // Used by EmployeesService.create — rejects e.g. Human Resources + Manager I.
  async assertAvailableIn(positionId: string, department: { id: string; name: string }) {
    const position = await this.prisma.position.findUnique({
      where: { id: positionId },
      include: { departments: { select: { departmentId: true } } },
    });
    if (!position) throw new BadRequestException("Selected position was not found.");
    if (!isPositionAvailableIn(position, department.id)) {
      throw new BadRequestException(`"${position.title}" is not an available position for the ${department.name} department.`);
    }
    return position;
  }

  private parseInput(dto: PositionInput) {
    if (dto.departmentScope !== undefined && !SCOPES.has(dto.departmentScope)) {
      throw new BadRequestException("Choose where this position is available.");
    }
    const departmentScope = dto.departmentScope as PositionDepartmentScope | undefined;
    const departmentIds = Array.from(new Set(dto.departmentIds ?? []));
    if (departmentScope && departmentScope !== "ALL" && departmentIds.length === 0) {
      throw new BadRequestException("Select at least one department.");
    }
    return { departmentScope, departmentIds: departmentScope === "ALL" ? [] : departmentIds };
  }

  private async assertNoDuplicateTitle(title: string, excludeId?: string) {
    const existing = await this.prisma.position.findFirst({
      where: { title: { equals: title, mode: "insensitive" }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    });
    if (existing) throw new ConflictException(`A position named "${title}" already exists.`);
  }

  async create(dto: PositionInput, actorUserId?: string) {
    const title = dto.title?.trim();
    if (!title) throw new BadRequestException("Position name is required.");
    const { departmentScope, departmentIds } = this.parseInput({ ...dto, departmentScope: dto.departmentScope ?? "ALL" });
    await this.assertNoDuplicateTitle(title);

    const created = await this.prisma.position.create({
      data: {
        title,
        departmentScope,
        departments: { create: departmentIds.map((departmentId) => ({ departmentId })) },
      },
    });

    await this.prisma.auditLog.create({
      data: {
        actorUserId,
        action: "CREATE_POSITION",
        entityType: "Position",
        entityId: created.id,
        newValues: { title, departmentScope, departmentIds },
      },
    });

    return created;
  }

  async update(id: string, dto: PositionInput, actorUserId?: string) {
    const existing = await this.prisma.position.findUniqueOrThrow({
      where: { id },
      include: { departments: { select: { departmentId: true } } },
    });

    const title = dto.title?.trim();
    if (dto.title !== undefined && !title) throw new BadRequestException("Position name is required.");
    if (title && title.toLowerCase() !== existing.title.toLowerCase()) {
      await this.assertNoDuplicateTitle(title, id);
    }
    const { departmentScope, departmentIds } = this.parseInput(dto);

    const updated = await this.prisma.$transaction(async (tx) => {
      if (departmentScope) {
        await tx.positionDepartment.deleteMany({ where: { positionId: id } });
        if (departmentIds.length > 0) {
          await tx.positionDepartment.createMany({
            data: departmentIds.map((departmentId) => ({ positionId: id, departmentId })),
          });
        }
      }
      return tx.position.update({
        where: { id },
        data: { ...(title ? { title } : {}), ...(departmentScope ? { departmentScope } : {}) },
      });
    });

    await this.prisma.auditLog.create({
      data: {
        actorUserId,
        action: "UPDATE_POSITION",
        entityType: "Position",
        entityId: id,
        oldValues: {
          title: existing.title,
          departmentScope: existing.departmentScope,
          departmentIds: existing.departments.map((link) => link.departmentId),
        },
        newValues: {
          title: updated.title,
          departmentScope: updated.departmentScope,
          ...(departmentScope ? { departmentIds } : {}),
        },
      },
    });

    return updated;
  }

  async setStatus(id: string, isActive: boolean, actorUserId?: string) {
    const updated = await this.prisma.position.update({ where: { id }, data: { isActive } });

    await this.prisma.auditLog.create({
      data: {
        actorUserId,
        action: isActive ? "RESTORE_POSITION" : "ARCHIVE_POSITION",
        entityType: "Position",
        entityId: id,
        newValues: { isActive },
      },
    });

    return updated;
  }
}
