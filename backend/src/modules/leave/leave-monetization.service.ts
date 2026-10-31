import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { LeaveStatus, LeaveType } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { LeaveBalancesService } from "./leave-balances.service";
import { currentLeaveYear, getLeaveYearReset, leaveYearOf, leaveYearRange } from "./leave-year.util";

// Requests still waiting on a decision hold their days — monetizing must not
// pay those out from under them.
const UNDECIDED_STATUSES: LeaveStatus[] = ["PENDING", "SUPERVISOR_APPROVED", "NEEDS_REVISION"];

// The automatic payout only runs in the first days of a new leave year, so a
// server that was down on the reset date still catches up, but deploying
// mid-year never pays out a long-finished year after the fact.
const AUTO_MONETIZE_WINDOW_DAYS = 7;

// End-of-leave-year leave monetization, for every leave type HR marked
// "Monetizable" (Edit Leave Type → Rules; Vacation Leave by default). It runs
// on its own once a leave year ends (see runScheduled): each employee's
// unused days of that type are paid out, up to the type's
// maxMonetizableDays. The paid days are added to the balance's usedDays (so
// they come off "remaining" everywhere) and recorded as a LeaveMonetization
// row for the report. Whatever is still left at the reset date is forfeited
// — the next leave year starts with new balance rows.
@Injectable()
export class LeaveMonetizationService {
  private readonly logger = new Logger(LeaveMonetizationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly leaveBalancesService: LeaveBalancesService,
  ) {}

  // Hourly: monetize() is a no-op for anyone already paid out, so repeating
  // it is harmless, and an hour's delay after the reset doesn't matter.
  @Cron(CronExpression.EVERY_HOUR)
  async runScheduled() {
    try {
      for (const result of await this.autoMonetizeEndedYear()) {
        if (result.employeeCount) {
          this.logger.log(
            `Auto-monetized ${result.leaveTypeName} for leave year ${result.year}: ${result.employeeCount} employee(s), ${result.totalDays} day(s).`,
          );
        }
      }
    } catch (error) {
      this.logger.error("Automatic leave monetization failed", error instanceof Error ? error.stack : undefined);
    }
  }

  // Pays out the leave year that just ended, for each monetizable type —
  // only during the first AUTO_MONETIZE_WINDOW_DAYS of the new year.
  async autoMonetizeEndedYear(now = new Date()) {
    const reset = await getLeaveYearReset(this.prisma);
    const current = leaveYearOf(now, reset);
    const { start } = leaveYearRange(current, reset);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const daysIntoYear = Math.round((today.getTime() - start.getTime()) / 86_400_000);
    if (daysIntoYear < 0 || daysIntoYear >= AUTO_MONETIZE_WINDOW_DAYS) return [];

    const ended = current - 1;
    const results = [];
    for (const type of await this.findMonetizableTypes()) {
      results.push(await this.monetize(ended, type));
    }
    return results;
  }

  private findMonetizableTypes() {
    return this.prisma.leaveType.findMany({
      where: { isActive: true, isMonetizable: true },
      orderBy: { name: "asc" },
    });
  }

  // The report for one monetizable type (the first one by name if none is
  // asked for). `leaveTypes` lists every monetizable type for the picker.
  async list(year: number | undefined, departmentId?: string, leaveTypeId?: string) {
    const resolvedYear = year ?? (await currentLeaveYear(this.prisma));
    const reset = await getLeaveYearReset(this.prisma);
    const range = leaveYearRange(resolvedYear, reset);
    const types = await this.findMonetizableTypes();
    const type = types.find((t) => t.id === leaveTypeId) ?? types[0] ?? null;

    const base = {
      year: resolvedYear,
      leaveYearStart: range.start,
      leaveYearEnd: range.end,
      leaveTypes: types.map((t) => ({ id: t.id, name: t.name, maxDays: Number(t.maxMonetizableDays ?? 0) })),
      leaveTypeId: type?.id ?? null,
      leaveTypeName: type?.name ?? null,
      maxDays: Number(type?.maxMonetizableDays ?? 0),
    };
    if (!type) return { ...base, rows: [] };
    return { ...base, rows: await this.buildRows(type, resolvedYear, range, departmentId) };
  }

  // Reports → VL Monetization: the same rows as the VL Monetization tab, for
  // every monetizable type. A type no longer monetizable only keeps the
  // employees it actually paid, so past payouts stay on the report.
  async listForReport(year: number, departmentId?: string) {
    const range = leaveYearRange(year, await getLeaveYearReset(this.prisma));
    const types = await this.prisma.leaveType.findMany({
      where: { OR: [{ isActive: true, isMonetizable: true }, { leaveMonetizations: { some: { year } } }] },
      orderBy: { name: "asc" },
    });

    const rows = [];
    for (const type of types) {
      const paidOnly = !type.isActive || !type.isMonetizable;
      for (const row of await this.buildRows(type, year, range, departmentId)) {
        if (paidOnly && row.monetizedDays === null) continue;
        rows.push({ ...row, year, leaveTypeId: type.id, leaveTypeName: type.name });
      }
    }
    return rows;
  }

  private async buildRows(type: LeaveType, year: number, range: { start: Date; end: Date }, departmentId?: string) {
    const maxDays = Number(type.maxMonetizableDays ?? 0);
    await this.leaveBalancesService.ensureAutoCreditedBalances(year);

    const departmentWhere = departmentId ? { departmentId } : {};
    const [employees, balances, pending, monetizations] = await Promise.all([
      this.prisma.employee.findMany({
        where: {
          ...departmentWhere,
          OR: [
            { employmentStatus: { in: type.applicableStatuses.filter((status) => status !== "SEPARATED") } },
            // Someone already paid out stays on the report even if they
            // have since separated or changed status.
            { leaveMonetizations: { some: { leaveTypeId: type.id, year } } },
          ],
        },
        select: {
          id: true,
          employeeNo: true,
          firstName: true,
          middleName: true,
          lastName: true,
          sex: true,
          employmentStatus: true,
          department: { select: { name: true } },
        },
        orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      }),
      this.prisma.leaveBalance.findMany({ where: { leaveTypeId: type.id, year } }),
      this.prisma.leaveRequest.groupBy({
        by: ["employeeId"],
        where: {
          leaveTypeId: type.id,
          status: { in: UNDECIDED_STATUSES },
          startDate: { gte: range.start, lte: range.end },
        },
        _sum: { totalDays: true },
      }),
      this.prisma.leaveMonetization.findMany({ where: { leaveTypeId: type.id, year } }),
    ]);

    const balanceByEmployee = new Map(balances.map((balance) => [balance.employeeId, balance]));
    const pendingByEmployee = new Map(pending.map((row) => [row.employeeId, Number(row._sum.totalDays ?? 0)]));
    const monetizationByEmployee = new Map(monetizations.map((row) => [row.employeeId, row]));

    return employees.map((employee) => {
      const balance = balanceByEmployee.get(employee.id);
      // Same no-balance-row fallback as LeaveBalancesService.findForEmployee.
      const earnedDays = balance ? Number(balance.earnedDays) : type.requiresAdminGrant ? 0 : Number(type.defaultDays);
      const usedDays = balance ? Number(balance.usedDays) : 0;
      const remainingDays = Math.max(0, earnedDays - usedDays);
      const pendingDays = pendingByEmployee.get(employee.id) ?? 0;
      const monetization = monetizationByEmployee.get(employee.id);
      const toMonetizeDays = monetization ? 0 : Math.min(maxDays, Math.max(0, remainingDays - pendingDays));

      return {
        employeeId: employee.id,
        employeeNo: employee.employeeNo,
        name: `${employee.firstName} ${employee.lastName}`,
        firstName: employee.firstName,
        lastName: employee.lastName,
        sex: employee.sex,
        department: employee.department?.name ?? null,
        employmentStatus: employee.employmentStatus,
        remainingDays,
        pendingDays,
        toMonetizeDays,
        monetizedDays: monetization ? Number(monetization.days) : null,
        monetizedAt: monetization?.monetizedAt ?? null,
      };
    });
  }

  private async monetize(year: number, type: LeaveType) {
    const range = leaveYearRange(year, await getLeaveYearReset(this.prisma));
    const maxDays = Number(type.maxMonetizableDays ?? 0);
    const due = (await this.buildRows(type, year, range)).filter((row) => row.toMonetizeDays > 0);

    let employeeCount = 0;
    let totalDays = 0;
    for (const row of due) {
      const done = await this.prisma.$transaction(async (tx) => {
        // The unique key makes a repeat run a no-op for anyone already
        // paid out.
        const created = await tx.leaveMonetization.createMany({
          data: [{ employeeId: row.employeeId, leaveTypeId: type.id, year, days: row.toMonetizeDays }],
          skipDuplicates: true,
        });
        if (created.count === 0) return false;
        await tx.leaveBalance.upsert({
          where: { employeeId_leaveTypeId_year: { employeeId: row.employeeId, leaveTypeId: type.id, year } },
          update: { usedDays: { increment: row.toMonetizeDays } },
          create: {
            employeeId: row.employeeId,
            leaveTypeId: type.id,
            year,
            earnedDays: type.defaultDays,
            usedDays: row.toMonetizeDays,
          },
        });
        return true;
      });
      if (!done) continue;
      employeeCount += 1;
      totalDays += row.toMonetizeDays;
    }

    if (employeeCount > 0) {
      await this.prisma.auditLog.create({
        data: {
          action: "MONETIZE_LEAVE",
          entityType: "LeaveMonetization",
          entityId: `${type.id}:${year}`,
          newValues: { year, leaveTypeId: type.id, leaveTypeName: type.name, maxDaysPerEmployee: maxDays, employeeCount, totalDays, automatic: true },
        },
      });
    }

    return { year, leaveTypeName: type.name, employeeCount, totalDays };
  }
}
