import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class LeaveBalancesService {
  constructor(private readonly prisma: PrismaService) {}

  // Returns one row per leave type for the given employee/year, even for leave types
  // the employee hasn't used yet (those show their full default allotment as remaining,
  // with no LeaveBalance row created until the first approved request touches them).
  async findForEmployee(employeeId: string, year: number) {
    const [leaveTypes, balances] = await Promise.all([
      this.prisma.leaveType.findMany({ orderBy: { name: "asc" } }),
      this.prisma.leaveBalance.findMany({ where: { employeeId, year } }),
    ]);

    return leaveTypes.map((leaveType) => {
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
}