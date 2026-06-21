import { Controller, Get, Param, Query } from "@nestjs/common";
import { LeaveBalancesService } from "./leave-balances.service";

@Controller("leave-balances")
export class LeaveBalancesController {
  constructor(private readonly leaveBalancesService: LeaveBalancesService) {}

  @Get(":employeeId")
  findForEmployee(@Param("employeeId") employeeId: string, @Query("year") year?: string) {
    const resolvedYear = year ? Number(year) : new Date().getFullYear();
    return this.leaveBalancesService.findForEmployee(employeeId, resolvedYear);
  }
}