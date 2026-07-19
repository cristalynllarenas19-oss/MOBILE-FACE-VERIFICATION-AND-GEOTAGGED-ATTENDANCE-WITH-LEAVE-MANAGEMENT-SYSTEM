import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { EmploymentStatus } from "@prisma/client";
import { IsNumber, IsOptional, IsString, Min } from "class-validator";
import { RequirePermissions } from "../../common/decorators/permissions.decorator";
import { LeaveBalancesService } from "./leave-balances.service";

export class GrantLeaveBalanceDto {
  @IsString()
  leaveTypeId!: string;

  @IsNumber()
  @Min(0)
  earnedDays!: number;

  @IsOptional()
  @IsNumber()
  year?: number;
}

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

  // Per-employee balance rows for the Leave Balances Overview's
  // classification drill-down list — same route-ordering reason as
  // "summary" above, must come before ":employeeId".
  @Get("by-classification")
  getByClassification(@Query("year") year?: string, @Query("employmentStatus") employmentStatus?: EmploymentStatus) {
    const resolvedYear = year ? Number(year) : new Date().getFullYear();
    return this.leaveBalancesService.getByClassification(resolvedYear, employmentStatus);
  }

  @Get(":employeeId")
  findForEmployee(@Param("employeeId") employeeId: string, @Query("year") year?: string) {
    const resolvedYear = year ? Number(year) : new Date().getFullYear();
    return this.leaveBalancesService.findForEmployee(employeeId, resolvedYear);
  }

  // HR/Admin grants a specific employee access to an admin-grant-only leave
  // type (Solo Parent, Study Leave, Added Paternity Leave) after they've
  // applied for it outside the system — see the "Grant Leave Type" action on
  // the Leave page.
  @Post(":employeeId/grant")
  @RequirePermissions("leave:approve")
  grant(@Param("employeeId") employeeId: string, @Body() dto: GrantLeaveBalanceDto, @Req() request: Request) {
    return this.leaveBalancesService.grant(employeeId, dto, (request as any).user?.userId);
  }
}
