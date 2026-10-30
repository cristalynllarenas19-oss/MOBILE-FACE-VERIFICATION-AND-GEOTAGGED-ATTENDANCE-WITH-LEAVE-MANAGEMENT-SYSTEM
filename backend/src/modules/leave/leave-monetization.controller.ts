import { Controller, Get, Query, Req } from "@nestjs/common";
import { RequirePermissions } from "../../common/decorators/permissions.decorator";
import { getSupervisorDepartmentScope } from "../../common/utils/supervisor-scope.util";
import { LeaveMonetizationService } from "./leave-monetization.service";

// Read-only: the payout itself runs automatically at the leave-year reset
// (LeaveMonetizationService.runScheduled).
@Controller("leave-monetization")
export class LeaveMonetizationController {
  constructor(private readonly leaveMonetizationService: LeaveMonetizationService) {}

  // Every employee's balance of one monetizable leave type for the leave
  // year — what will be (or was) paid out. Doubles as the monetization report.
  @Get()
  @RequirePermissions("leave:read")
  list(@Req() request: Request, @Query("year") year?: string, @Query("leaveTypeId") leaveTypeId?: string) {
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.leaveMonetizationService.list(year ? Number(year) : undefined, departmentId, leaveTypeId);
  }
}
