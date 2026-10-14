import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { GeolocationModule } from "../geolocation/geolocation.module";
import { DepartmentsController } from "./departments.controller";
import { DepartmentsService } from "./departments.service";

@Module({
  imports: [PrismaModule, GeolocationModule],
  controllers: [DepartmentsController],
  providers: [DepartmentsService],
})
export class DepartmentsModule {}
