import { Injectable } from "@nestjs/common";
import { EmploymentStatus, LeaveTypeKind, Sex } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

// Standard PH working-days-per-year reference (365 − 52 Sundays) — used as a
// fixed denominator for the classification-level "days left" gauge instead of
// summing every employee's individual balance into one ballooning total.
const WORKING_DAYS_PER_YEAR = 313;

// Maternity/Paternity-kind leave types are sex-restricted even though both
// are listed as applicable to REGULAR employees on the leave type itself —
// an employee with no sex on file is eligible for neither until HR fills it
// in. Keyed off `kind`, not `name`, so HR can freely rename these types.
function isEligibleForLeaveType(kind: LeaveTypeKind, sex: Sex | null | undefined) {
  if (kind === "MATERNITY") return sex === "FEMALE";
  if (kind === "PATERNITY") return sex === "MALE";
  return true;
}

@Injectable()
export class LeaveBalancesService {
  constructor(private readonly prisma: PrismaService) {}

  // Proactively materializes this year's LeaveBalance row for any leave type
  // flagged isAutoCredited (Vacation/Sick Leave) for REGULAR employees, so
  // credits are locked in for the year rather than only appearing once an
  // employee's first request against that type is approved. Idempotent —
  // safe to call on every read.
  private async ensureAutoCreditedBalances(year: number, employeeIds?: string[]) {
    const autoTypes = await this.prisma.leaveType.findMany({
      where: { isAutoCredited: true, isActive: true },
    });
    if (autoTypes.length === 0) return;

    const employees = await this.prisma.employee.findMany({
      where: {
        employmentStatus: "REGULAR",
        ...(employeeIds ? { id: { in: employeeIds } } : {}),
      },
      select: { id: true },
    });
    if (employees.length === 0) return;

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
        if (!existingKeys.has(key)) {
          toCreate.push({ employeeId: employee.id, leaveTypeId: type.id, year, earnedDays: Number(type.defaultDays), usedDays: 0 });
        }
      }
    }

    if (toCreate.length > 0) {
      await this.prisma.leaveBalance.createMany({ data: toCreate, skipDuplicates: true });
    }
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

 
  async getSummary(year: number) {
    await this.ensureAutoCreditedBalances(year);

    const [employees, leaveTypes, balances] = await Promise.all([
      this.prisma.employee.findMany({
        where: { employmentStatus: { not: "SEPARATED" } },
        select: {
          id: true,
          employmentStatus: true,
          sex: true,
          departmentId: true,
          department: { select: { name: true } },
        },
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

    const statusMap = new Map<EmploymentStatus, { usedDays: number; employeeIds: Set<string> }>();
    // Pre-seed every non-separated classification so each always gets its own
    // donut in the overview, even when no employee currently holds it yet.
    for (const status of ["REGULAR", "CONTRACTUAL_SEASONAL", "PIECE_RATE"] as EmploymentStatus[]) {
      statusMap.set(status, { usedDays: 0, employeeIds: new Set<string>() });
    }
    const typeMap = new Map<
      string,
      {
        employmentStatus: EmploymentStatus;
        leaveTypeId: string;
        leaveTypeName: string;
        earnedDays: number;
        usedDays: number;
      }
    >();
    const deptMap = new Map<
      string,
      { departmentId: string; departmentName: string; earnedDays: number; usedDays: number; employeeIds: Set<string> }
    >();


    // byLeaveType reflects each leave type's own configured entitlement (as
    // set on the Leave Types page), not a sum across every employee in the
    // classification — otherwise a type like Maternity Leave (105 days) would
    // balloon to 105 × headcount instead of just showing 105.
    for (const status of ["REGULAR", "CONTRACTUAL_SEASONAL", "PIECE_RATE"] as EmploymentStatus[]) {
      for (const leaveType of leaveTypes) {
        if (!leaveType.applicableStatuses.includes(status)) continue;
        typeMap.set(`${status}::${leaveType.id}`, {
          employmentStatus: status,
          leaveTypeId: leaveType.id,
          leaveTypeName: leaveType.name,
          earnedDays: leaveType.requiresAdminGrant ? 0 : Number(leaveType.defaultDays),
          usedDays: 0,
        });
      }
    }

    for (const employee of employees) {
      const status = employee.employmentStatus;

      for (const leaveType of leaveTypes) {
        if (!leaveType.applicableStatuses.includes(status)) continue;
        if (!isEligibleForLeaveType(leaveType.kind, employee.sex)) continue;

        const existing = balanceLookup.get(`${employee.id}::${leaveType.id}`);
        const earnedDays = existing ? existing.earnedDays : leaveType.requiresAdminGrant ? 0 : Number(leaveType.defaultDays);
        const usedDays = existing ? existing.usedDays : 0;

        const statusEntry = statusMap.get(status) ?? { usedDays: 0, employeeIds: new Set<string>() };
        statusEntry.usedDays += usedDays;
        statusEntry.employeeIds.add(employee.id);
        statusMap.set(status, statusEntry);

        const deptEntry =
          deptMap.get(employee.departmentId) ?? {
            departmentId: employee.departmentId,
            departmentName: employee.department.name,
            earnedDays: 0,
            usedDays: 0,
            employeeIds: new Set<string>(),
          };
        deptEntry.earnedDays += earnedDays;
        deptEntry.usedDays += usedDays;
        deptEntry.employeeIds.add(employee.id);
        deptMap.set(employee.departmentId, deptEntry);
      }
    }

    // The classification-level gauge is scaled against the fixed working-days-
    // per-year reference, not a headcount-multiplied sum of every employee's
    // individual entitlements — usedDays still reflects real, sex-aware usage.
    const byEmploymentStatus = Array.from(statusMap.entries()).map(([employmentStatus, v]) => ({
      employmentStatus,
      earnedDays: WORKING_DAYS_PER_YEAR,
      usedDays: v.usedDays,
      remainingDays: Math.max(0, WORKING_DAYS_PER_YEAR - v.usedDays),
      employeeCount: v.employeeIds.size,
    }));

    const byLeaveType = Array.from(typeMap.values()).map((v) => ({
      ...v,
      remainingDays: Math.max(0, v.earnedDays - v.usedDays),
    }));

    const byDepartment = Array.from(deptMap.values())
      .map((v) => ({
        departmentId: v.departmentId,
        departmentName: v.departmentName,
        earnedDays: v.earnedDays,
        usedDays: v.usedDays,
        remainingDays: Math.max(0, v.earnedDays - v.usedDays),
        employeeCount: v.employeeIds.size,
      }))
      .sort((a, b) => a.departmentName.localeCompare(b.departmentName));

    return { year, byEmploymentStatus, byLeaveType, byDepartment };
  }
}