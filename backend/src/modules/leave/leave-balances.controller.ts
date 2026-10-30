import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { EmploymentStatus } from "@prisma/client";
import { IsNumber, IsOptional, IsString, Min } from "class-validator";
import { RequirePermissions } from "../../common/decorators/permissions.decorator";
import { getSupervisorDepartmentScope } from "../../common/utils/supervisor-scope.util";
import { LeaveBalancesService } from "./leave-balances.service";
import { PrismaService } from "../../prisma/prisma.service";
import { currentLeaveYear, leaveYearFor } from "./leave-year.util";

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
  constructor(
    private readonly leaveBalancesService: LeaveBalancesService,
    private readonly prisma: PrismaService,
  ) {}

  // Per-employee balance rows for the Leave Balances tab's employee table —
  // must come before ":employeeId" below, otherwise Nest will try to match
  // "by-classification" as an employeeId and call findForEmployee instead.
  @Get("by-classification")
  async getByClassification(
    @Req() request: Request,
    @Query("year") year?: string,
    @Query("employmentStatus") employmentStatus?: EmploymentStatus,
  ) {
    const resolvedYear = year ? Number(year) : await currentLeaveYear(this.prisma);
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.leaveBalancesService.getByClassification(resolvedYear, employmentStatus, departmentId);
  }

  @Get(":employeeId")
  // `date` (an ISO date-time) asks for the leave year that day falls in —
  // e.g. a request's start date, which may belong to the next leave year.
  async findForEmployee(@Param("employeeId") employeeId: string, @Query("year") year?: string, @Query("date") date?: string) {
    const resolvedYear = year
      ? Number(year)
      : date
        ? await leaveYearFor(this.prisma, new Date(date))
        : await currentLeaveYear(this.prisma);
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
