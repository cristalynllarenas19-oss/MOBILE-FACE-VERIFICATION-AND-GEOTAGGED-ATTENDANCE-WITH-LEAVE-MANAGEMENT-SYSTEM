import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { LeaveBalancesModule } from "../leave/leave-balances.module";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";

@Module({
  imports: [PrismaModule, LeaveBalancesModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
