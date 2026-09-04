import { Injectable } from "@nestjs/common";
import { EmploymentStatus, LeaveTypeKind, Sex } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

// Maternity/Paternity-kind leave types are sex-restricted even though both
// are listed as applicable to REGULAR employees on the leave type itself —
// an employee with no sex on file is eligible for neither until HR fills it
// in. Keyed off `kind`, not `name`, so HR can freely rename these types.
export function isEligibleForLeaveType(kind: LeaveTypeKind, sex: Sex | null | undefined) {
  if (kind === "MATERNITY") return sex === "FEMALE";
  if (kind === "PATERNITY") return sex === "MALE";
  return true;
}

// How long a per-employee "already ensured" mark is trusted before
// ensureAutoCreditedBalances re-checks that employee for real. Bounds how
// stale a newly-added auto-credited leave type can appear for an employee
// already marked within the window — acceptable since that's an infrequent
// admin action, and worth it to skip 2-3 DB round trips on every one of the
// mobile app's 3-second leave-balance polls.
const ENSURE_AUTO_CREDIT_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class LeaveBalancesService {
  constructor(private readonly prisma: PrismaService) {}

  // employeeId::year -> last time it was confirmed to have all its
  // auto-credited balance rows materialized. Process-local is fine here —
  // worst case a second server instance redoes the check once.
  private readonly ensuredCache = new Map<string, number>();

  // Proactively materializes this year's LeaveBalance row for any leave type
  // flagged isAutoCredited (Vacation/Sick Leave) for REGULAR employees, so
  // credits are locked in for the year rather than only appearing once an
  // employee's first request against that type is approved. Idempotent —
  // safe to call on every read. When employeeIds is given, already-confirmed
  // employees are skipped without hitting the DB at all (see ensuredCache).
  private async ensureAutoCreditedBalances(year: number, employeeIds?: string[]) {
    const now = Date.now();
    if (employeeIds) {
      const pending = employeeIds.filter((id) => {
        const last = this.ensuredCache.get(`${id}::${year}`);
        return !last || now - last > ENSURE_AUTO_CREDIT_TTL_MS;
      });
      if (pending.length === 0) return;
      employeeIds = pending;
    }
    const markEnsured = () => {
      if (!employeeIds) return;
      for (const id of employeeIds) this.ensuredCache.set(`${id}::${year}`, now);
    };

    const autoTypes = await this.prisma.leaveType.findMany({
      where: { isAutoCredited: true, isActive: true },
    });
    if (autoTypes.length === 0) {
      markEnsured();
      return;
    }

    const employees = await this.prisma.employee.findMany({
      where: {
        employmentStatus: "REGULAR",
        ...(employeeIds ? { id: { in: employeeIds } } : {}),
      },
      select: { id: true, sex: true },
    });
    if (employees.length === 0) {
      markEnsured();
      return;
    }

    const existing = await this.prisma.leaveBalance.findMany({
      where: {
        year,
        employeeId: { in: employees.map((e) => e.id) },
        leaveTypeId: { in: autoTypes.map((t) => t.id) },
      },
      select: { employeeId: true, leaveTypeId: true },
    });
    const existingKeys = new Set(existing.map((b) => `${b.employeeId}::${b.leaveTypeId}`));

    const toCreate: { employeeId: string; leaveTypeId: string; year: number; earnedDays: number; usedDays: number }[] = [];
    for (const employee of employees) {
      for (const type of autoTypes) {
        const key = `${employee.id}::${type.id}`;
        if (!isEligibleForLeaveType(type.kind, employee.sex)) continue;
        if (!existingKeys.has(key)) {
          toCreate.push({ employeeId: employee.id, leaveTypeId: type.id, year, earnedDays: Number(type.defaultDays), usedDays: 0 });
        }
      }
    }

    if (toCreate.length > 0) {
      await this.prisma.leaveBalance.createMany({ data: toCreate, skipDuplicates: true });
    }
    markEnsured();
  }

  async findForEmployee(employeeId: string, year: number) {
    await this.ensureAutoCreditedBalances(year, [employeeId]);

    const [employee, leaveTypes, balances] = await Promise.all([
      this.prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { employmentStatus: true, sex: true } }),
      this.prisma.leaveType.findMany({ orderBy: { name: "asc" } }),
      this.prisma.leaveBalance.findMany({ where: { employeeId, year } }),
    ]);

    return leaveTypes
      .filter(
        (leaveType) =>
          leaveType.applicableStatuses.includes(employee.employmentStatus) &&
          isEligibleForLeaveType(leaveType.kind, employee.sex),
      )
      .map((leaveType) => {
      const balance = balances.find((row) => row.leaveTypeId === leaveType.id);
      // Admin-grant-only types (Solo Parent, Study Leave, Added Paternity
      // Leave) never fall back to the type's default allotment — an employee
      // has 0 days of these until HR/Admin explicitly grants them a balance
      // row via LeaveBalancesService.grant.
      const earnedDays = balance
        ? Number(balance.earnedDays)
        : leaveType.requiresAdminGrant
          ? 0
          : Number(leaveType.defaultDays);
      const usedDays = balance ? Number(balance.usedDays) : 0;

      return {
        leaveTypeId: leaveType.id,
        leaveTypeName: leaveType.name,
        year,
        earnedDays,
        usedDays,
        remainingDays: Math.max(0, earnedDays - usedDays),
      };
    });
  }

  // Grants (or adjusts) an employee's balance for a specific leave type/year —
  // the mechanism HR/Admin uses on the Leave page to give a specific employee
  // access to an admin-grant-only leave type (Solo Parent, Study Leave, Added
  // Paternity Leave) after they've applied for it outside the system.
  async grant(employeeId: string, dto: { leaveTypeId: string; earnedDays: number; year?: number }, actorUserId?: string) {
    const leaveType = await this.prisma.leaveType.findUniqueOrThrow({ where: { id: dto.leaveTypeId } });
    const year = dto.year ?? new Date().getFullYear();

    const balance = await this.prisma.leaveBalance.upsert({
      where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId: dto.leaveTypeId, year } },
      update: { earnedDays: dto.earnedDays },
      create: { employeeId, leaveTypeId: dto.leaveTypeId, year, earnedDays: dto.earnedDays, usedDays: 0 },
    });

    await this.prisma.auditLog.create({
      data: {
        actorUserId,
        action: "GRANT_LEAVE_BALANCE",
        entityType: "LeaveBalance",
        entityId: balance.id,
        newValues: { employeeId, leaveTypeId: dto.leaveTypeId, leaveTypeName: leaveType.name, year, earnedDays: dto.earnedDays },
      },
    });

    return balance;
  }

  // One row per employee (not aggregated) for the Leave Balances tab's
  // employee table — same per-type resolution findForEmployee uses, so a row
  // here always matches what that employee's own detail view (View button)
  // shows. Omitting employmentStatus returns every non-separated employee.
  async getByClassification(year: number, employmentStatus?: EmploymentStatus, departmentId?: string) {
    await this.ensureAutoCreditedBalances(year);

    const [employees, leaveTypes, balances] = await Promise.all([
      this.prisma.employee.findMany({
        where: {
          employmentStatus: employmentStatus ?? { not: "SEPARATED" },
          ...(departmentId ? { departmentId } : {}),
        },
        select: { id: true, employmentStatus: true, sex: true },
      }),
      this.prisma.leaveType.findMany({ orderBy: { name: "asc" } }),
      this.prisma.leaveBalance.findMany({ where: { year } }),
    ]);

    const balanceLookup = new Map<string, { earnedDays: number; usedDays: number }>();
    for (const b of balances) {
      balanceLookup.set(`${b.employeeId}::${b.leaveTypeId}`, {
        earnedDays: Number(b.earnedDays),
        usedDays: Number(b.usedDays),
      });
    }

    return employees.map((employee) => {
      const applicableTypes = leaveTypes.filter(
        (leaveType) =>
          leaveType.applicableStatuses.includes(employee.employmentStatus) &&
          isEligibleForLeaveType(leaveType.kind, employee.sex),
      );

      let totalEarnedDays = 0;
      let totalUsedDays = 0;
      // Only surfaced here when earnedDays > 0 — mirrors the same rule the
      // Overview donut's "All Leave Types" popover already uses
      // (leaveTypeRowsByStatus in LeavePage.tsx), so an ungranted
      // admin-grant-only type doesn't clutter every row with a "0" entry.
      // Totals below still sum every applicable type, granted or not.
      const balancesForEmployee: { leaveTypeId: string; leaveTypeName: string; earnedDays: number; usedDays: number; remainingDays: number }[] = [];

      for (const leaveType of applicableTypes) {
        const existing = balanceLookup.get(`${employee.id}::${leaveType.id}`);
        const earnedDays = existing ? existing.earnedDays : leaveType.requiresAdminGrant ? 0 : Number(leaveType.defaultDays);
        const usedDays = existing ? existing.usedDays : 0;
        totalEarnedDays += earnedDays;
        totalUsedDays += usedDays;

        if (earnedDays > 0) {
          balancesForEmployee.push({
            leaveTypeId: leaveType.id,
            leaveTypeName: leaveType.name,
            earnedDays,
            usedDays,
            remainingDays: Math.max(0, earnedDays - usedDays),
          });
        }
      }

      return {
        employeeId: employee.id,
        totalEarnedDays,
        totalUsedDays,
        totalRemainingDays: Math.max(0, totalEarnedDays - totalUsedDays),
        balances: balancesForEmployee,
      };
    });
  }
}