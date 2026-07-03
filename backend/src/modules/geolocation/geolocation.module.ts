import { Module } from "@nestjs/common";
import { AuditLogsModule } from "../audit-logs/audit-logs.module";
import { GeolocationService } from "./geolocation.service";
import { GeolocationController } from "./geolocation.controller";

@Module({
  imports: [AuditLogsModule],
  controllers: [GeolocationController],
  providers: [GeolocationService],
  exports: [GeolocationService],
})
export class GeolocationModule {}
