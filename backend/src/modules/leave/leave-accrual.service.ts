import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../../prisma/prisma.service";
import { isDayOff } from "../../common/utils/schedule.util";

// The two fixed credits a Permanent Seasonal employee earns per completed
// perfect-attendance month — see the LeaveType.isSeasonalAccrualEligible
// flag (Sick Leave, Vacation Leave) for which balances actually receive it.
const ACCRUAL_DAYS_PER_TYPE = 1.25;

// Cap on how many qualifying periods one employee can be advanced through in
// a single run — purely a safety bound against a runaway loop bug, not a
// real limit (a daily cron never needs to catch up more than ~a handful of
// months even after extended downtime).
const MAX_CYCLES_PER_RUN = 60;

function toLocalMidnight(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addOneMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

function dateKey(date: Date): string {
  return toLocalMidnight(date).toISOString().slice(0, 10);
}

@Injectable()
export class LeaveAccrualService {
  private readonly logger = new Logger(LeaveAccrualService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Runs once a day — each qualifying period is anchored to the individual
  // employee's own permanentSeasonalSince date, not a shared calendar
  // boundary, so a fixed daily check (rather than a specific day-of-month
  // cron) is what catches every employee's cycle boundary as it comes due.
  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async runDailyAccrual() {
    try {
      await this.processAccruals();
    } catch (error) {
      this.logger.error("Leave accrual processing failed", error instanceof Error ? error.stack : undefined);
    }
  }

  // Separated from the @Cron trigger so it can be invoked directly (e.g. a
  // future manual "recompute" admin action) without waiting on the schedule.
  async processAccruals() {
    const today = toLocalMidnight(new Date());

    const employees = await this.prisma.employee.findMany({
      where: { employmentStatus: "PERMANENT_SEASONAL", permanentSeasonalSince: { not: null } },
      select: { id: true, hireDate: true, permanentSeasonalSince: true },
    });
    if (employees.length === 0) return;

    const employeeIds = employees.map((e) => e.id);

    // Only the single latest record per employee is needed — that's where
    // the next unprocessed cycle picks up.
    const lastRecords = await this.prisma.leaveAccrualRecord.findMany({
      where: { employeeId: { in: employeeIds } },
      orderBy: { cycleEnd: "desc" },
      distinct: ["employeeId"],
      select: { employeeId: true, cycleEnd: true },
    });
    const lastCycleEndByEmployee = new Map(lastRecords.map((r) => [r.employeeId, r.cycleEnd]));

    const cursors = new Map<string, Date>();
    let earliestCursor: Date | null = null;
    for (const emp of employees) {
      const cursor = toLocalMidnight(lastCycleEndByEmployee.get(emp.id) ?? emp.permanentSeasonalSince!);
      cursors.set(emp.id, cursor);
      if (!earliestCursor || cursor < earliestCursor) earliestCursor = cursor;
    }
    // Nobody has an open, elapsed-enough cycle to evaluate yet.
    if (!earliestCursor || earliestCursor >= today) return;

    // One batch of queries covers every employee's date range, instead of
    // one round trip per employee per day.
    const [attendanceRows, activeSchedules, leaveRows] = await Promise.all([
      this.prisma.attendanceRecord.findMany({
        where: { employeeId: { in: employeeIds }, attendanceDate: { gte: earliestCursor, lt: today } },
        select: { employeeId: true, attendanceDate: true },
      }),
      this.prisma.employeeSchedule.findMany({
        where: {
          employeeId: { in: employeeIds },
          startsOn: { lte: today },
          OR: [{ endsOn: null }, { endsOn: { gte: today } }],
        },
        orderBy: { startsOn: "desc" },
        select: { employeeId: true, workingDays: true },
      }),
      this.prisma.leaveRequest.findMany({
        where: {
          employeeId: { in: employeeIds },
          status: "APPROVED",
          startDate: { lt: today },
          endDate: { gte: earliestCursor },
        },
        select: { employeeId: true, startDate: true, endDate: true },
      }),
    ]);

    const hasAttendanceRecord = new Set(attendanceRows.map((r) => `${r.employeeId}::${dateKey(r.attendanceDate)}`));

    // First (most recent, per the orderBy above) schedule row wins, same
    // "current schedule applied uniformly to past dates too" simplification
    // DashboardService already uses for its own historical no-show checks.
    const workingDaysByEmployee = new Map<string, number[] | null>();
    for (const schedule of activeSchedules) {
      if (!workingDaysByEmployee.has(schedule.employeeId)) {
        workingDaysByEmployee.set(schedule.employeeId, schedule.workingDays);
      }
    }

    const leavesByEmployee = new Map<string, { startDate: Date; endDate: Date }[]>();
    for (const leave of leaveRows) {
      const list = leavesByEmployee.get(leave.employeeId) ?? [];
      list.push(leave);
      leavesByEmployee.set(leave.employeeId, list);
    }

    const isOnApprovedLeave = (employeeId: string, date: Date): boolean => {
      const leaves = leavesByEmployee.get(employeeId);
      if (!leaves) return false;
      const t = date.getTime();
      return leaves.some(
        (leave) => toLocalMidnight(leave.startDate).getTime() <= t && t <= toLocalMidnight(leave.endDate).getTime(),
      );
    };

    // Mirrors the no-show definition DashboardService already uses for
    // Absent counts (no record, past their cutoff, a working day, not on
    // approved leave) — kept as its own copy here rather than a shared
    // import because dashboard.service.ts computes it inline as part of a
    // much larger per-day aggregation, and this only ever evaluates fully-
    // elapsed past dates (never "today"), so the cutoff-time check that
    // matters for today's dashboard stat doesn't apply here at all.
    const isAbsentOnDate = (employeeId: string, hireDate: Date, date: Date): boolean => {
      if (date < toLocalMidnight(hireDate)) return false;
      if (isDayOff(date)) return false;
      const workingDays = workingDaysByEmployee.get(employeeId);
      if (workingDays && workingDays.length > 0 && !workingDays.includes(date.getDay())) return false;
      if (hasAttendanceRecord.has(`${employeeId}::${dateKey(date)}`)) return false;
      if (isOnApprovedLeave(employeeId, date)) return false;
      return true;
    };

    type PendingRecord = {
      employeeId: string;
      cycleStart: Date;
      cycleEnd: Date;
      outcome: "PERFECT" | "VIOLATED";
      sickLeaveEarned: number;
      vacationLeaveEarned: number;
    };
    const pending: PendingRecord[] = [];

    for (const employee of employees) {
      let cursor = cursors.get(employee.id)!;
      for (let i = 0; i < MAX_CYCLES_PER_RUN && cursor < today; i++) {
        const cycleEnd = addOneMonth(cursor);
        let violationDate: Date | null = null;
        for (
          let day = new Date(cursor);
          day < today && day < cycleEnd;
          day.setDate(day.getDate() + 1)
        ) {
          if (isAbsentOnDate(employee.id, employee.hireDate, day)) {
            violationDate = new Date(day);
            break;
          }
        }

        if (violationDate) {
          pending.push({
            employeeId: employee.id,
            cycleStart: cursor,
            cycleEnd: violationDate,
            outcome: "VIOLATED",
            sickLeaveEarned: 0,
            vacationLeaveEarned: 0,
          });
          cursor = new Date(violationDate);
          cursor.setDate(cursor.getDate() + 1);
        } else if (today >= cycleEnd) {
          pending.push({
            employeeId: employee.id,
            cycleStart: cursor,
            cycleEnd,
            outcome: "PERFECT",
            sickLeaveEarned: ACCRUAL_DAYS_PER_TYPE,
            vacationLeaveEarned: ACCRUAL_DAYS_PER_TYPE,
          });
          cursor = cycleEnd;
        } else {
          // Still mid-cycle with a clean streak so far — nothing more to
          // resolve for this employee until a later run.
          break;
        }
      }
    }

    if (pending.length === 0) return;

    const seasonalTypes = await this.prisma.leaveType.findMany({
      where: { isSeasonalAccrualEligible: true, isActive: true },
    });

    let creditedCount = 0;
    for (const record of pending) {
      // employeeId+cycleStart is unique, so a duplicate run (e.g. the cron
      // firing twice, or a manual reprocess) safely no-ops here instead of
      // double-crediting — the createMany's actual insert count (0 if it
      // collided) gates whether the balance update below even runs.
      await this.prisma.$transaction(async (tx) => {
        const created = await tx.leaveAccrualRecord.createMany({
          data: [record],
          skipDuplicates: true,
        });
        if (created.count === 0 || record.outcome !== "PERFECT") return;

        const year = record.cycleEnd.getFullYear();
        for (const type of seasonalTypes) {
          await tx.leaveBalance.upsert({
            where: { employeeId_leaveTypeId_year: { employeeId: record.employeeId, leaveTypeId: type.id, year } },
            create: { employeeId: record.employeeId, leaveTypeId: type.id, year, earnedDays: ACCRUAL_DAYS_PER_TYPE, usedDays: 0 },
            update: { earnedDays: { increment: ACCRUAL_DAYS_PER_TYPE } },
          });
        }
        creditedCount++;
      });
    }

    this.logger.log(
      `Leave accrual: evaluated ${pending.length} qualifying period(s) across ${employees.length} Permanent Seasonal employee(s), credited ${creditedCount}.`,
    );
  }

  // Called from EmployeesService.update the moment an Admin converts someone
  // to PERMANENT_SEASONAL — seeds an explicit 0-day balance for every
  // seasonal-accrual-eligible type immediately, so LeaveBalancesService's
  // no-balance-row fallback (which shows the type's full default, e.g. 15
  // days) never applies to them before they've actually earned anything.
  async startAccrualForNewlyPermanentSeasonal(employeeId: string) {
    const seasonalTypes = await this.prisma.leaveType.findMany({
      where: { isSeasonalAccrualEligible: true, isActive: true },
    });
    if (seasonalTypes.length === 0) return;

    const year = new Date().getFullYear();
    for (const type of seasonalTypes) {
      await this.prisma.leaveBalance.upsert({
        where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId: type.id, year } },
        create: { employeeId, leaveTypeId: type.id, year, earnedDays: 0, usedDays: 0 },
        update: {},
      });
    }
  }

  // Backs the Leave page's accrual history table (requirement: Qualifying
  // Period, Employee Name, Employee Type, Attendance Status, SL/VL Earned,
  // Date Credited) — every evaluated period is included, PERFECT and
  // VIOLATED alike, so HR can see why a given month didn't get credited too.
  async getHistory(departmentId?: string) {
    const records = await this.prisma.leaveAccrualRecord.findMany({
      where: departmentId ? { employee: { departmentId } } : undefined,
      orderBy: { cycleStart: "desc" },
      include: {
        employee: {
          select: {
            firstName: true,
            lastName: true,
            employmentStatus: true,
            department: { select: { name: true } },
          },
        },
      },
    });

    return records.map((record) => ({
      id: record.id,
      employeeName: `${record.employee.firstName} ${record.employee.lastName}`,
      employeeType: record.employee.employmentStatus,
      department: record.employee.department.name,
      cycleStart: record.cycleStart,
      cycleEnd: record.cycleEnd,
      attendanceStatus: record.outcome,
      sickLeaveEarned: Number(record.sickLeaveEarned),
      vacationLeaveEarned: Number(record.vacationLeaveEarned),
      creditedAt: record.creditedAt,
    }));
  }
}
