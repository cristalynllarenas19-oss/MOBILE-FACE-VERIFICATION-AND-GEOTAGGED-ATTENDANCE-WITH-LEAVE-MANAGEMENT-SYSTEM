import { BadRequestException, Injectable } from "@nestjs/common";
import { EmploymentStatus, LeaveTypeKind, Prisma, Sex } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { currentLeaveYear } from "./leave-year.util";

// Maternity/Paternity-kind leave types are sex-restricted even though both
// are listed as applicable to REGULAR employees on the leave type itself —
// an employee with no sex on file is eligible for neither until HR fills it
// in. Keyed off `kind`, not `name`, so HR can freely rename these types.
export function isEligibleForLeaveType(kind: LeaveTypeKind, sex: Sex | null | undefined) {
  if (kind === "MATERNITY") return sex === "FEMALE";
  if (kind === "PATERNITY") return sex === "MALE";
  return true;
}

// Added Paternity Leave (the isTransferable type, RA 11210) is days the
// mother gives up from her own maternity leave. So while a husband is linked
// to his ULPI-employed wife (Employee.spouseEmployeeId), her Maternity balance
// for the year is kept short by exactly his Added Paternity earnedDays:
// positive `days` takes them from her, negative hands them back. A wife with
// no balance row yet starts from the maternity type's default allotment.
export async function shiftMaternityDaysFromSpouse(
  prisma: Prisma.TransactionClient,
  spouseEmployeeId: string,
  year: number,
  days: number,
) {
  if (days === 0) return;
  const maternity = await prisma.leaveType.findFirst({ where: { kind: "MATERNITY", isActive: true } });
  if (!maternity) return;

  const key = { employeeId_leaveTypeId_year: { employeeId: spouseEmployeeId, leaveTypeId: maternity.id, year } };
  await prisma.leaveBalance.upsert({
    where: key,
    update: { earnedDays: { decrement: days } },
    create: {
      employeeId: spouseEmployeeId,
      leaveTypeId: maternity.id,
      year,
      earnedDays: Number(maternity.defaultDays) - days,
      usedDays: 0,
    },
  });
}

// The year's Added Paternity days a husband currently holds — what his linked
// wife's Maternity balance is short by (see shiftMaternityDaysFromSpouse).
export async function getTransferredPaternityDays(prisma: Prisma.TransactionClient, employeeId: string, year: number) {
  const balances = await prisma.leaveBalance.findMany({
    where: { employeeId, year, leaveType: { isTransferable: true } },
    select: { earnedDays: true },
  });
  return balances.reduce((sum, balance) => sum + Number(balance.earnedDays), 0);
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
  async ensureAutoCreditedBalances(year: number, employeeIds?: string[]) {
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

    const [employee, leaveTypes, balances, extensions] = await Promise.all([
      this.prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { employmentStatus: true, sex: true } }),
      this.prisma.leaveType.findMany({ orderBy: { name: "asc" } }),
      this.prisma.leaveBalance.findMany({ where: { employeeId, year } }),
      this.prisma.leaveRequest.findMany({
        where: { employeeId, extensionOfId: { not: null }, status: { in: ["APPROVED", "CANCELLATION_PENDING"] } },
        select: { leaveTypeId: true, totalDays: true, extensionOfId: true },
      }),
    ]);
    // An approved Maternity Leave extension never draws on the balance (see
    // LeaveService.updateStatus), but the employee's balance shows it on top
    // of the leave's own days — counted in the year of the leave it extends.
    const extendedLeaves = extensions.length
      ? await this.prisma.leaveRequest.findMany({
          where: { id: { in: extensions.map((extension) => extension.extensionOfId!) } },
          select: { id: true, startDate: true },
        })
      : [];
    const extensionDaysFor = (leaveTypeId: string) =>
      extensions
        .filter(
          (extension) =>
            extension.leaveTypeId === leaveTypeId &&
            extendedLeaves.find((leave) => leave.id === extension.extensionOfId)?.startDate.getFullYear() === year,
        )
        .reduce((sum, extension) => sum + Number(extension.totalDays), 0);

    return leaveTypes
      .filter(
        (leaveType) =>
          leaveType.applicableStatuses.includes(employee.employmentStatus) &&
          isEligibleForLeaveType(leaveType.kind, employee.sex) &&
          // An archived type drops out unless this employee already used days
          // of it this year — those stay visible so the history adds up.
          (leaveType.isActive ||
            Number(balances.find((row) => row.leaveTypeId === leaveType.id)?.usedDays ?? 0) > 0),
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
        // Approved extension days, shown on top of earnedDays/usedDays —
        // never part of them (or of remainingDays).
        extensionDays: extensionDaysFor(leaveType.id),
        // "As needed" — no allotment, so there is no "of N days" to show.
        isUnlimitedDays: leaveType.isUnlimitedDays,
      };
    });
  }

  // Grants (or adjusts) an employee's balance for a specific leave type/year —
  // the mechanism HR/Admin uses on the Leave page to give a specific employee
  // access to an admin-grant-only leave type (Solo Parent, Study Leave, Added
  // Paternity Leave) after they've applied for it outside the system.
  async grant(employeeId: string, dto: { leaveTypeId: string; earnedDays: number; year?: number }, actorUserId?: string) {
    const leaveType = await this.prisma.leaveType.findUniqueOrThrow({ where: { id: dto.leaveTypeId } });
    const year = dto.year ?? (await currentLeaveYear(this.prisma));

    // Added Paternity Leave comes out of the linked wife's Maternity Leave.
    const employee = leaveType.isTransferable
      ? await this.prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { sex: true, spouseEmployeeId: true } })
      : null;
    const spouseEmployeeId = employee?.sex === "MALE" ? employee.spouseEmployeeId : null;

    return this.prisma.$transaction(async (tx) => {
      const key = { employeeId_leaveTypeId_year: { employeeId, leaveTypeId: dto.leaveTypeId, year } };
      const previous = await tx.leaveBalance.findUnique({ where: key, select: { earnedDays: true } });
      // Only the change moves days, so re-granting the same amount is a no-op
      // for the wife and revoking (0) gives back exactly what was taken.
      const transferDays = dto.earnedDays - Number(previous?.earnedDays ?? 0);

      if (spouseEmployeeId && transferDays > 0) {
        await this.assertSpouseCanTransfer(tx, spouseEmployeeId, year, transferDays);
      }

      const balance = await tx.leaveBalance.upsert({
        where: key,
        update: { earnedDays: dto.earnedDays },
        create: { employeeId, leaveTypeId: dto.leaveTypeId, year, earnedDays: dto.earnedDays, usedDays: 0 },
      });

      if (spouseEmployeeId) {
        await shiftMaternityDaysFromSpouse(tx, spouseEmployeeId, year, transferDays);
      }

      await tx.auditLog.create({
        data: {
          actorUserId,
          action: "GRANT_LEAVE_BALANCE",
          entityType: "LeaveBalance",
          entityId: balance.id,
          newValues: {
            employeeId,
            leaveTypeId: dto.leaveTypeId,
            leaveTypeName: leaveType.name,
            year,
            earnedDays: dto.earnedDays,
            ...(spouseEmployeeId && transferDays !== 0 ? { spouseEmployeeId, maternityDaysTransferred: transferDays } : {}),
          },
        },
      });

      return balance;
    });
  }

  // The wife can only give up maternity days she still has left this year.
  private async assertSpouseCanTransfer(tx: Prisma.TransactionClient, spouseEmployeeId: string, year: number, days: number) {
    const maternity = await tx.leaveType.findFirst({ where: { kind: "MATERNITY", isActive: true } });
    if (!maternity) return;
    const balance = await tx.leaveBalance.findUnique({
      where: { employeeId_leaveTypeId_year: { employeeId: spouseEmployeeId, leaveTypeId: maternity.id, year } },
      select: { earnedDays: true, usedDays: true },
    });
    const remaining = balance ? Number(balance.earnedDays) - Number(balance.usedDays) : Number(maternity.defaultDays);
    if (remaining < days) {
      throw new BadRequestException(
        `The spouse only has ${Math.max(0, remaining)} day(s) of ${maternity.name} left — not enough to transfer ${days} day(s) as Added Paternity Leave.`,
      );
    }
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
          isEligibleForLeaveType(leaveType.kind, employee.sex) &&
          // Same archived-type rule as findForEmployee.
          (leaveType.isActive || (balanceLookup.get(`${employee.id}::${leaveType.id}`)?.usedDays ?? 0) > 0),
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