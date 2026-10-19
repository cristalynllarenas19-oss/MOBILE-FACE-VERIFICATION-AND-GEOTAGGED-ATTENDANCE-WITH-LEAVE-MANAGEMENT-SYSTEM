import { BadRequestException, ConflictException, ForbiddenException, Injectable } from "@nestjs/common";
import { defaultBreakKind, defaultBreakStartTime, resolveBreakWindow } from "../attendance/attendance-shift.util";
import { PrismaService } from "../../prisma/prisma.service";

type ScheduleFilters = {
  department?: string;
  departmentId?: string;
  shiftId?: string;
  status?: string;
  archived?: boolean;
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
    // A separated employee's own record is excluded from every other picker
    // in the app (Employee Management, Geotagging's assignment panel) — a
    // schedule assignment is no different, and without this an offboarded
    // employee's still-open assignment lingers here indefinitely looking
    // like an active, current schedule.
    const employeeWhere: Record<string, unknown> = { employmentStatus: { not: "SEPARATED" } };
    if (filters.departmentId) {
      employeeWhere.departmentId = filters.departmentId;
    } else if (filters.department && filters.department !== "ALL") {
      employeeWhere.department = { name: filters.department };
    }

    return this.prisma.employeeSchedule.findMany({
      where: {
        employee: employeeWhere,
        isActive: !filters.archived,
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

  // Self-scoped: an employee's own active schedule assignments, used by
  // employee-mobile both to know which weekdays are theirs to work (so the
  // leave calendar can mark/block their non-working days) and to render the
  // "My Schedule" view's shift/weekday plot, without exposing the org-wide
  // findAll() list above.
  findMine(employeeId: string) {
    const today = new Date();
    return this.prisma.employeeSchedule.findMany({
      where: {
        employeeId,
        isActive: true,
        OR: [{ endsOn: null }, { endsOn: { gte: today } }],
      },
      select: {
        id: true,
        startsOn: true,
        endsOn: true,
        workingDays: true,
        shift: { select: { id: true, name: true, startTime: true, endTime: true } },
      },
      orderBy: { startsOn: "desc" },
    });
  }

  async setAssignmentStatus(id: string, isActive: boolean, scopeDepartmentId?: string) {
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
      data: { isActive },
      include: {
        employee: { include: { department: true, position: true } },
        shift: true,
      },
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
    dto: { employeeId: string; shiftId: string; startsOn: string; endsOn?: string; workingDays?: number[] },
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

    // Defaults to the shift template's own working days when the caller
    // doesn't override them (e.g. for a part-timer on a shared shift).
    let workingDays = dto.workingDays;
    if (workingDays) {
      this.assertValidWorkingDays(workingDays);
    } else {
      const shift = await this.prisma.shift.findUniqueOrThrow({
        where: { id: dto.shiftId },
        select: { workingDays: true },
      });
      workingDays = shift.workingDays;
    }

    return this.prisma.employeeSchedule.create({
      data: {
        employeeId: dto.employeeId,
        shiftId: dto.shiftId,
        startsOn: new Date(dto.startsOn),
        endsOn: dto.endsOn ? new Date(dto.endsOn) : null,
        workingDays,
      },
      include: {
        employee: { include: { department: true, position: true } },
        shift: true,
      },
    });
  }

  async updateAssignment(
    id: string,
    dto: { shiftId?: string; startsOn?: string; endsOn?: string | null; workingDays?: number[] },
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

    if (dto.workingDays !== undefined) this.assertValidWorkingDays(dto.workingDays);

    return this.prisma.employeeSchedule.update({
      where: { id },
      data: {
        ...(dto.shiftId ? { shiftId: dto.shiftId } : {}),
        ...(dto.startsOn ? { startsOn: new Date(dto.startsOn) } : {}),
        ...(dto.endsOn !== undefined ? { endsOn: dto.endsOn ? new Date(dto.endsOn) : null } : {}),
        ...(dto.workingDays !== undefined ? { workingDays: dto.workingDays } : {}),
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

  // Resolves what to save for a shift's break. Anything the admin didn't
  // choose falls back to the default (the shift's 5th hour; lunch if around
  // midday) — and the result has to actually fit inside the shift.
  private resolveShiftBreak(input: {
    startTime: string;
    endTime: string;
    lunchBreakMinutes: number;
    breakStartTime?: string;
    breakKind?: string;
  }) {
    const breakStartTime = input.breakStartTime || defaultBreakStartTime(input.startTime);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(breakStartTime)) {
      throw new BadRequestException("Break start must be a valid time.");
    }
    if (input.breakKind !== undefined && input.breakKind !== "LUNCH" && input.breakKind !== "BREAK") {
      throw new BadRequestException("Break type must be Lunch or Break.");
    }
    const breakKind = input.breakKind ?? defaultBreakKind(breakStartTime);

    const shift = { ...input, breakStartTime, breakKind, lateThresholdMinutes: 0 };
    if (input.lunchBreakMinutes > 0 && !resolveBreakWindow(shift, new Date(2000, 0, 1))) {
      throw new BadRequestException("The break must start and end within the shift's hours.");
    }
    return { breakStartTime, breakKind };
  }

  private optionalWholeMinutes(value: number | undefined, fieldLabel: string, min = 0) {
    if (value === undefined) return undefined;
    if (!Number.isInteger(value) || value < min) {
      throw new BadRequestException(`${fieldLabel} must be a whole number greater than or equal to ${min}.`);
    }
    return value;
  }

  // Sunday (0) is deliberately excluded — it's a fixed company-wide day off
  // (see isDayOff), not something a shift/assignment can opt back into.
  private assertValidWorkingDays(workingDays: number[]) {
    if (workingDays.length === 0) {
      throw new BadRequestException("Select at least one working day.");
    }
    if (workingDays.some((day) => !Number.isInteger(day) || day < 1 || day > 6)) {
      throw new BadRequestException("Working days must be between Monday and Saturday — Sunday is always a day off.");
    }
  }

  private shiftAuditValues(shift: {
    name: string;
    startTime: string;
    endTime: string;
    lunchBreakMinutes: number;
    breakStartTime: string | null;
    breakKind: string;
    enableRounding: boolean;
    roundingIntervalMinutes: number;
    lateThresholdMinutes: number;
    undertimeThresholdMinutes: number;
    workingDays: number[];
  }) {
    return {
      name: shift.name,
      startTime: shift.startTime,
      endTime: shift.endTime,
      lunchBreakMinutes: shift.lunchBreakMinutes,
      breakStartTime: shift.breakStartTime,
      breakKind: shift.breakKind,
      enableRounding: shift.enableRounding,
      roundingIntervalMinutes: shift.roundingIntervalMinutes,
      lateThresholdMinutes: shift.lateThresholdMinutes,
      undertimeThresholdMinutes: shift.undertimeThresholdMinutes,
      workingDays: shift.workingDays,
    };
  }

  async createShift(
    dto: {
      name: string;
      startTime: string;
      endTime: string;
      lunchBreakMinutes?: number;
      breakStartTime?: string;
      breakKind?: string;
      enableRounding?: boolean;
      roundingIntervalMinutes?: number;
      lateThresholdMinutes?: number;
      undertimeThresholdMinutes?: number;
      workingDays?: number[];
    },
    actorUserId?: string,
  ) {
    const name = dto.name.trim();
    await this.assertNoDuplicateShiftName(name);
    this.assertValidShiftTimes(dto.startTime, dto.endTime);
    const lunchBreakMinutes = this.optionalWholeMinutes(dto.lunchBreakMinutes, "Break") ?? 60;
    const roundingIntervalMinutes = this.optionalWholeMinutes(dto.roundingIntervalMinutes, "Rounding Interval", 1) ?? 15;
    const lateThresholdMinutes = this.optionalWholeMinutes(dto.lateThresholdMinutes, "Late Threshold") ?? 0;
    const undertimeThresholdMinutes = this.optionalWholeMinutes(dto.undertimeThresholdMinutes, "Undertime Threshold") ?? 0;
    const workingDays = dto.workingDays ?? [1, 2, 3, 4, 5];
    this.assertValidWorkingDays(workingDays);
    const shiftBreak = this.resolveShiftBreak({
      startTime: dto.startTime,
      endTime: dto.endTime,
      lunchBreakMinutes,
      breakStartTime: dto.breakStartTime,
      breakKind: dto.breakKind,
    });

    const created = await this.prisma.shift.create({
      data: {
        name,
        startTime: dto.startTime,
        endTime: dto.endTime,
        lunchBreakMinutes,
        ...shiftBreak,
        enableRounding: dto.enableRounding ?? false,
        roundingIntervalMinutes,
        lateThresholdMinutes,
        undertimeThresholdMinutes,
        workingDays,
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
      lunchBreakMinutes?: number;
      breakStartTime?: string;
      breakKind?: string;
      enableRounding?: boolean;
      roundingIntervalMinutes?: number;
      lateThresholdMinutes?: number;
      undertimeThresholdMinutes?: number;
      workingDays?: number[];
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
    const lunchBreakMinutes = this.optionalWholeMinutes(dto.lunchBreakMinutes, "Break");
    const roundingIntervalMinutes = this.optionalWholeMinutes(dto.roundingIntervalMinutes, "Rounding Interval", 1);
    const lateThresholdMinutes = this.optionalWholeMinutes(dto.lateThresholdMinutes, "Late Threshold");
    const undertimeThresholdMinutes = this.optionalWholeMinutes(dto.undertimeThresholdMinutes, "Undertime Threshold");
    if (dto.workingDays !== undefined) this.assertValidWorkingDays(dto.workingDays);
    // A changed start time moves the default break with it unless the admin
    // set the break explicitly in this same save.
    const startChanged = startTime !== existing.startTime;
    const shiftBreak = this.resolveShiftBreak({
      startTime,
      endTime,
      lunchBreakMinutes: lunchBreakMinutes ?? existing.lunchBreakMinutes,
      breakStartTime: dto.breakStartTime ?? (startChanged ? undefined : existing.breakStartTime ?? undefined),
      breakKind: dto.breakKind ?? (startChanged || dto.breakStartTime ? undefined : existing.breakKind),
    });

    const updated = await this.prisma.shift.update({
      where: { id },
      data: {
        name,
        startTime: dto.startTime,
        endTime: dto.endTime,
        lunchBreakMinutes,
        ...shiftBreak,
        enableRounding: dto.enableRounding,
        roundingIntervalMinutes,
        lateThresholdMinutes,
        undertimeThresholdMinutes,
        workingDays: dto.workingDays,
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
