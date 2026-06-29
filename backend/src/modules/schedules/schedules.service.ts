import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

type ScheduleFilters = {
  department?: string;
  departmentId?: string;
  shiftId?: string;
  status?: string;
};

const ACTOR_SELECT = {
  select: {
    email: true,
    employee: { select: { firstName: true, lastName: true } },
  },
} as const;

@Injectable()
export class SchedulesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(filters: ScheduleFilters = {}) {
    const today = new Date();
    return this.prisma.employeeSchedule.findMany({
      where: {
        ...(filters.departmentId
          ? { employee: { departmentId: filters.departmentId } }
          : filters.department && filters.department !== "ALL"
            ? { employee: { department: { name: filters.department } } }
            : {}),
        ...(filters.shiftId && filters.shiftId !== "ALL" ? { shiftId: filters.shiftId } : {}),
        ...(filters.status === "ACTIVE" ? { OR: [{ endsOn: null }, { endsOn: { gte: today } }] } : {}),
        ...(filters.status === "ENDED" ? { endsOn: { lt: today } } : {}),
      },
      include: {
        employee: { include: { department: true, position: true } },
        shift: true,
      },
      orderBy: { startsOn: "desc" },
    });
  }

  findShifts() {
    const today = new Date();
    return this.prisma.shift.findMany({
      orderBy: { startTime: "asc" },
      include: {
        createdByUser: ACTOR_SELECT,
        updatedByUser: ACTOR_SELECT,
        _count: {
          select: {
            schedules: { where: { OR: [{ endsOn: null }, { endsOn: { gte: today } }] } },
          },
        },
      },
    });
  }

  createAssignment(dto: { employeeId: string; shiftId: string; startsOn: string; endsOn?: string }) {
    return this.prisma.employeeSchedule.create({
      data: {
        employeeId: dto.employeeId,
        shiftId: dto.shiftId,
        startsOn: new Date(dto.startsOn),
        endsOn: dto.endsOn ? new Date(dto.endsOn) : null,
      },
      include: {
        employee: { include: { department: true, position: true } },
        shift: true,
      },
    });
  }

  updateAssignment(id: string, dto: { shiftId?: string; startsOn?: string; endsOn?: string | null }) {
    return this.prisma.employeeSchedule.update({
      where: { id },
      data: {
        ...(dto.shiftId ? { shiftId: dto.shiftId } : {}),
        ...(dto.startsOn ? { startsOn: new Date(dto.startsOn) } : {}),
        ...(dto.endsOn !== undefined ? { endsOn: dto.endsOn ? new Date(dto.endsOn) : null } : {}),
      },
      include: {
        employee: { include: { department: true, position: true } },
        shift: true,
      },
    });
  }

  private async assertNoDuplicateShiftName(name: string, excludeId?: string) {
    const existing = await this.prisma.shift.findFirst({
      where: { name: { equals: name, mode: "insensitive" }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    });
    if (existing) throw new ConflictException(`A shift named "${name}" already exists.`);
  }

  private assertValidShiftTimes(startTime: string, endTime: string) {
    if (startTime === endTime) {
      throw new BadRequestException("Start time and end time cannot be the same.");
    }
  }

  async createShift(dto: { name: string; startTime: string; endTime: string; gracePeriodMinutes?: number }, actorUserId?: string) {
    const name = dto.name.trim();
    await this.assertNoDuplicateShiftName(name);
    this.assertValidShiftTimes(dto.startTime, dto.endTime);

    const created = await this.prisma.shift.create({
      data: {
        name,
        startTime: dto.startTime,
        endTime: dto.endTime,
        gracePeriodMinutes: dto.gracePeriodMinutes ?? 0,
        createdBy: actorUserId,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        actorUserId,
        action: "CREATE_SHIFT",
        entityType: "Shift",
        entityId: created.id,
        newValues: { name: created.name, startTime: created.startTime, endTime: created.endTime, gracePeriodMinutes: created.gracePeriodMinutes },
      },
    });

    return created;
  }

  async updateShift(
    id: string,
    dto: { name?: string; startTime?: string; endTime?: string; gracePeriodMinutes?: number },
    actorUserId?: string,
  ) {
    const existing = await this.prisma.shift.findUniqueOrThrow({ where: { id } });

    const name = dto.name?.trim();
    if (name && name !== existing.name) {
      await this.assertNoDuplicateShiftName(name, id);
    }
    const startTime = dto.startTime ?? existing.startTime;
    const endTime = dto.endTime ?? existing.endTime;
    this.assertValidShiftTimes(startTime, endTime);

    const updated = await this.prisma.shift.update({
      where: { id },
      data: {
        name,
        startTime: dto.startTime,
        endTime: dto.endTime,
        gracePeriodMinutes: dto.gracePeriodMinutes,
        updatedBy: actorUserId,
      },
      include: { createdByUser: ACTOR_SELECT, updatedByUser: ACTOR_SELECT },
    });

    await this.prisma.auditLog.create({
      data: {
        actorUserId,
        action: "UPDATE_SHIFT",
        entityType: "Shift",
        entityId: id,
        oldValues: {
          name: existing.name,
          startTime: existing.startTime,
          endTime: existing.endTime,
          gracePeriodMinutes: existing.gracePeriodMinutes,
        },
        newValues: {
          name: updated.name,
          startTime: updated.startTime,
          endTime: updated.endTime,
          gracePeriodMinutes: updated.gracePeriodMinutes,
        },
      },
    });

    return updated;
  }

  async setShiftStatus(id: string, isActive: boolean, actorUserId?: string) {
    const updated = await this.prisma.shift.update({
      where: { id },
      data: { isActive, updatedBy: actorUserId },
      include: { createdByUser: ACTOR_SELECT, updatedByUser: ACTOR_SELECT },
    });

    await this.prisma.auditLog.create({
      data: {
        actorUserId,
        action: isActive ? "RESTORE_SHIFT" : "ARCHIVE_SHIFT",
        entityType: "Shift",
        entityId: id,
        newValues: { isActive },
      },
    });

    return updated;
  }
}
