import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { EmployeeTypesController } from "./employee-types.controller";
import { EmployeeTypesService } from "./employee-types.service";

@Module({
  imports: [PrismaModule],
  controllers: [EmployeeTypesController],
  providers: [EmployeeTypesService],
  exports: [EmployeeTypesService],
})
export class EmployeeTypesModule {}
