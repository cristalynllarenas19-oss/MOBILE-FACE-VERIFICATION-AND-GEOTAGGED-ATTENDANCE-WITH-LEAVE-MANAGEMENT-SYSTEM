import { Module } from "@nestjs/common";
import { LeaveBalancesController } from "./leave-balances.controller";
import { LeaveBalancesService } from "./leave-balances.service";

@Module({
  controllers: [LeaveBalancesController],
  providers: [LeaveBalancesService],
})
export class LeaveBalancesModule {}