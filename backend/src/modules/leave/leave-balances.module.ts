import { Module } from "@nestjs/common";
import { LeaveBalancesController } from "./leave-balances.controller";
import { LeaveBalancesService } from "./leave-balances.service";
import { LeaveMonetizationController } from "./leave-monetization.controller";
import { LeaveMonetizationService } from "./leave-monetization.service";

@Module({
  controllers: [LeaveBalancesController, LeaveMonetizationController],
  providers: [LeaveBalancesService, LeaveMonetizationService],
})
export class LeaveBalancesModule {}
