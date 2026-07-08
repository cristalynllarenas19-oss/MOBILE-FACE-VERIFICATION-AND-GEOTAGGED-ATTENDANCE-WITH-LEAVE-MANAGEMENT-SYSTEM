import { BadRequestException, ConflictException, ForbiddenException, Injectable } from "@nestjs/common";
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

  async createAssignment(
    dto: { employeeId: string; shiftId: string; startsOn: string; endsOn?: string },
    scopeDepartmentId?: string,
  ) {
    if (scopeDepartmentId) {
      const employee = await this.prisma.employee.findUniqueOrThrow({
        where: { id: dto.employeeId },
        select: { departmentId: true },
      });
      if (employee.departmentId !== scopeDepartmentId) {
        throw new ForbiddenException("You can only assign schedules to employees in your own department.");
      }
    }

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

  async updateAssignment(
    id: string,
    dto: { shiftId?: string; startsOn?: string; endsOn?: string | null },
    scopeDepartmentId?: string,
  ) {
    if (scopeDepartmentId) {
      const assignment = await this.prisma.employeeSchedule.findUniqueOrThrow({
        where: { id },
        select: { employee: { select: { departmentId: true } } },
      });
      if (assignment.employee.departmentId !== scopeDepartmentId) {
        throw new ForbiddenException("You can only manage schedules for employees in your own department.");
      }
    }

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

  private optionalWholeMinutes(value: number | undefined, fieldLabel: string, min = 0) {
    if (value === undefined) return undefined;
    if (!Number.isInteger(value) || value < min) {
      throw new BadRequestException(`${fieldLabel} must be a whole number greater than or equal to ${min}.`);
    }
    return value;
  }

  private shiftAuditValues(shift: {
    name: string;
    startTime: string;
    endTime: string;
    morningBreakMinutes: number;
    afternoonBreakMinutes: number;
    lunchBreakMinutes: number;
    enableRounding: boolean;
    roundingIntervalMinutes: number;
    lateThresholdMinutes: number;
    undertimeThresholdMinutes: number;
    autoShiftAdjustment: boolean;
  }) {
    return {
      name: shift.name,
      startTime: shift.startTime,
      endTime: shift.endTime,
      morningBreakMinutes: shift.morningBreakMinutes,
      afternoonBreakMinutes: shift.afternoonBreakMinutes,
      lunchBreakMinutes: shift.lunchBreakMinutes,
      enableRounding: shift.enableRounding,
      roundingIntervalMinutes: shift.roundingIntervalMinutes,
      lateThresholdMinutes: shift.lateThresholdMinutes,
      undertimeThresholdMinutes: shift.undertimeThresholdMinutes,
      autoShiftAdjustment: shift.autoShiftAdjustment,
    };
  }

  async createShift(
    dto: {
      name: string;
      startTime: string;
      endTime: string;
      morningBreakMinutes?: number;
      afternoonBreakMinutes?: number;
      lunchBreakMinutes?: number;
      enableRounding?: boolean;
      roundingIntervalMinutes?: number;
      lateThresholdMinutes?: number;
      undertimeThresholdMinutes?: number;
      autoShiftAdjustment?: boolean;
    },
    actorUserId?: string,
  ) {
    const name = dto.name.trim();
    await this.assertNoDuplicateShiftName(name);
    this.assertValidShiftTimes(dto.startTime, dto.endTime);
    const morningBreakMinutes = this.optionalWholeMinutes(dto.morningBreakMinutes, "Morning Break") ?? 15;
    const afternoonBreakMinutes = this.optionalWholeMinutes(dto.afternoonBreakMinutes, "Afternoon Break") ?? 15;
    const lunchBreakMinutes = this.optionalWholeMinutes(dto.lunchBreakMinutes, "Lunch Break") ?? 60;
    const roundingIntervalMinutes = this.optionalWholeMinutes(dto.roundingIntervalMinutes, "Rounding Interval", 1) ?? 15;
    const lateThresholdMinutes = this.optionalWholeMinutes(dto.lateThresholdMinutes, "Late Threshold") ?? 0;
    const undertimeThresholdMinutes = this.optionalWholeMinutes(dto.undertimeThresholdMinutes, "Undertime Threshold") ?? 0;

    const created = await this.prisma.shift.create({
      data: {
        name,
        startTime: dto.startTime,
        endTime: dto.endTime,
        morningBreakMinutes,
        afternoonBreakMinutes,
        lunchBreakMinutes,
        enableRounding: dto.enableRounding ?? false,
        roundingIntervalMinutes,
        lateThresholdMinutes,
        undertimeThresholdMinutes,
        autoShiftAdjustment: dto.autoShiftAdjustment ?? false,
        createdBy: actorUserId,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        actorUserId,
        action: "CREATE_SHIFT",
        entityType: "Shift",
        entityId: created.id,
        newValues: this.shiftAuditValues(created),
      },
    });

    return created;
  }

  async updateShift(
    id: string,
    dto: {
      name?: string;
      startTime?: string;
      endTime?: string;
      morningBreakMinutes?: number;
      afternoonBreakMinutes?: number;
      lunchBreakMinutes?: number;
      enableRounding?: boolean;
      roundingIntervalMinutes?: number;
      lateThresholdMinutes?: number;
      undertimeThresholdMinutes?: number;
      autoShiftAdjustment?: boolean;
    },
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
    const morningBreakMinutes = this.optionalWholeMinutes(dto.morningBreakMinutes, "Morning Break");
    const afternoonBreakMinutes = this.optionalWholeMinutes(dto.afternoonBreakMinutes, "Afternoon Break");
    const lunchBreakMinutes = this.optionalWholeMinutes(dto.lunchBreakMinutes, "Lunch Break");
    const roundingIntervalMinutes = this.optionalWholeMinutes(dto.roundingIntervalMinutes, "Rounding Interval", 1);
    const lateThresholdMinutes = this.optionalWholeMinutes(dto.lateThresholdMinutes, "Late Threshold");
    const undertimeThresholdMinutes = this.optionalWholeMinutes(dto.undertimeThresholdMinutes, "Undertime Threshold");

    const updated = await this.prisma.shift.update({
      where: { id },
      data: {
        name,
        startTime: dto.startTime,
        endTime: dto.endTime,
        morningBreakMinutes,
        afternoonBreakMinutes,
        lunchBreakMinutes,
        enableRounding: dto.enableRounding,
        roundingIntervalMinutes,
        lateThresholdMinutes,
        undertimeThresholdMinutes,
        autoShiftAdjustment: dto.autoShiftAdjustment,
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
        oldValues: this.shiftAuditValues(existing),
        newValues: this.shiftAuditValues(updated),
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
