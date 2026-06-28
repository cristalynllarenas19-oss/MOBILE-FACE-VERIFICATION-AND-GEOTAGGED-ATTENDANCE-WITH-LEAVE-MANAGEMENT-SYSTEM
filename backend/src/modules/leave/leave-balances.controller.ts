import { Controller, Get, Param, Query } from "@nestjs/common";
import { LeaveBalancesService } from "./leave-balances.service";

@Controller("leave-balances")
export class LeaveBalancesController {
  constructor(private readonly leaveBalancesService: LeaveBalancesService) {}

  // NOTE: this must come BEFORE ":employeeId" below, otherwise Nest will try
  // to match "summary" as an employeeId and call findForEmployee instead.
  @Get("summary")
  getSummary(@Query("year") year?: string) {
    const resolvedYear = year ? Number(year) : new Date().getFullYear();
    return this.leaveBalancesService.getSummary(resolvedYear);
  }

  @Get(":employeeId")
  findForEmployee(@Param("employeeId") employeeId: string, @Query("year") year?: string) {
    const resolvedYear = year ? Number(year) : new Date().getFullYear();
    return this.leaveBalancesService.findForEmployee(employeeId, resolvedYear);
  }
}