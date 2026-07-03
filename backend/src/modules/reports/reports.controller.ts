import { Controller, Get, Query, Req } from "@nestjs/common";
import { getSupervisorDepartmentScope } from "../../common/utils/supervisor-scope.util";
import { ReportsService } from "./reports.service";

@Controller("reports")
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get()
  summary(
    @Req() request: Request,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("department") department?: string,
  ) {
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.reportsService.summary({ from, to, department, departmentId });
  }
}
