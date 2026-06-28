import { Injectable } from "@nestjs/common";
import { EmploymentStatus } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class LeaveBalancesService {
  constructor(private readonly prisma: PrismaService) {}

  async findForEmployee(employeeId: string, year: number) {
    const [employee, leaveTypes, balances] = await Promise.all([
      this.prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { employmentStatus: true } }),
      this.prisma.leaveType.findMany({ orderBy: { name: "asc" } }),
      this.prisma.leaveBalance.findMany({ where: { employeeId, year } }),
    ]);

    return leaveTypes
      .filter((leaveType) => leaveType.applicableStatuses.includes(employee.employmentStatus))
      .map((leaveType) => {
      const balance = balances.find((row) => row.leaveTypeId === leaveType.id);
      const earnedDays = balance ? Number(balance.earnedDays) : Number(leaveType.defaultDays);
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

 
  async getSummary(year: number) {
    const [employees, leaveTypes, balances] = await Promise.all([
      this.prisma.employee.findMany({
        where: { employmentStatus: { not: "SEPARATED" } },
        select: {
          id: true,
          employmentStatus: true,
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

    const statusMap = new Map<
      EmploymentStatus,
      { earnedDays: number; usedDays: number; employeeIds: Set<string> }
    >();
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


    for (const employee of employees) {
      const status = employee.employmentStatus;

      for (const leaveType of leaveTypes) {
        if (!leaveType.applicableStatuses.includes(status)) continue;

        const existing = balanceLookup.get(`${employee.id}::${leaveType.id}`);
        const earnedDays = existing ? existing.earnedDays : Number(leaveType.defaultDays);
        const usedDays = existing ? existing.usedDays : 0;

        const statusEntry =
          statusMap.get(status) ?? { earnedDays: 0, usedDays: 0, employeeIds: new Set<string>() };
        statusEntry.earnedDays += earnedDays;
        statusEntry.usedDays += usedDays;
        statusEntry.employeeIds.add(employee.id);
        statusMap.set(status, statusEntry);

        const typeKey = `${status}::${leaveType.id}`;
        const typeEntry =
          typeMap.get(typeKey) ?? {
            employmentStatus: status,
            leaveTypeId: leaveType.id,
            leaveTypeName: leaveType.name,
            earnedDays: 0,
            usedDays: 0,
          };
        typeEntry.earnedDays += earnedDays;
        typeEntry.usedDays += usedDays;
        typeMap.set(typeKey, typeEntry);

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

    const byEmploymentStatus = Array.from(statusMap.entries()).map(([employmentStatus, v]) => ({
      employmentStatus,
      earnedDays: v.earnedDays,
      usedDays: v.usedDays,
      remainingDays: Math.max(0, v.earnedDays - v.usedDays),
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