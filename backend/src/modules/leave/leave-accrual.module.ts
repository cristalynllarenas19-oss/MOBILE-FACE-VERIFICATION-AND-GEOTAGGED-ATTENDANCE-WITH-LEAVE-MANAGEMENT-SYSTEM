import { Module } from "@nestjs/common";
import { LeaveAccrualController } from "./leave-accrual.controller";
import { LeaveAccrualService } from "./leave-accrual.service";

@Module({
  controllers: [LeaveAccrualController],
  providers: [LeaveAccrualService],
  exports: [LeaveAccrualService],
})
export class LeaveAccrualModule {}
