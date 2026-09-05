import { Controller, Get, Post, Query, Req } from "@nestjs/common";
import { RequirePermissions } from "../../common/decorators/permissions.decorator";
import { getSupervisorDepartmentScope } from "../../common/utils/supervisor-scope.util";
import { LeaveAccrualService } from "./leave-accrual.service";

@Controller("leave-accrual")
export class LeaveAccrualController {
  constructor(private readonly leaveAccrualService: LeaveAccrualService) {}

  @Get("history")
  @RequirePermissions("leave:read")
  getHistory(@Req() request: Request) {
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.leaveAccrualService.getHistory(departmentId);
  }

  // Lets an Admin force an immediate recompute instead of waiting for the
  // nightly cron — same entry point @Cron uses, just triggered on demand
  // (e.g. right after backdating a test employee's permanentSeasonalSince,
  // or if HR wants to confirm today's conversions took effect right away).
  @Post("run-now")
  @RequirePermissions("leave:approve")
  async runNow() {
    await this.leaveAccrualService.processAccruals();
    return { ok: true };
  }
}
