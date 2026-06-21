// leave-types.module.ts
import { Module } from "@nestjs/common";
import { LeaveTypesController } from "./leave-types.controller";
import { LeaveTypesService } from "./leave-types.service";

@Module({
  controllers: [LeaveTypesController],
  providers: [LeaveTypesService],
})
export class LeaveTypesModule {}  // ← add "export" here