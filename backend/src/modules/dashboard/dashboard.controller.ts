import { Controller, Get, Query, Req } from "@nestjs/common";
import { getSupervisorDepartmentScope } from "../../common/utils/supervisor-scope.util";
import { DashboardService } from "./dashboard.service";

@Controller("dashboard")
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get("summary")
  summary(@Query("month") month: string | undefined, @Query("year") year: string | undefined, @Req() request: Request) {
    const now = new Date();
    const m = month ? parseInt(month, 10) - 1 : now.getMonth(); // 0-indexed
    const y = year ? parseInt(year, 10) : now.getFullYear();
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.dashboardService.summary(m, y, departmentId);
  }
}