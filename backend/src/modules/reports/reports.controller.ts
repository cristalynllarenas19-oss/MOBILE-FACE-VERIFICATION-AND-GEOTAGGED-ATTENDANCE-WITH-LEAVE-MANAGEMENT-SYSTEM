import { Controller, Get, Query } from "@nestjs/common";
import { ReportsService } from "./reports.service";

@Controller("reports")
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get()
  summary(
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("department") department?: string,
  ) {
    return this.reportsService.summary({ from, to, department });
  }
}
