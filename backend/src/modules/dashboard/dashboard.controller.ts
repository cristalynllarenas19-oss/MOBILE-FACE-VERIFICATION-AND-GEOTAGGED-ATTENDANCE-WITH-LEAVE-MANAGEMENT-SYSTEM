import { Controller, Get, Query } from "@nestjs/common";
import { DashboardService } from "./dashboard.service";

@Controller("dashboard")
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get("summary")
  summary(@Query("month") month?: string, @Query("year") year?: string) {
    const now = new Date();
    const m = month ? parseInt(month, 10) - 1 : now.getMonth(); // 0-indexed
    const y = year ? parseInt(year, 10) : now.getFullYear();
    return this.dashboardService.summary(m, y);
  }
}