import { Module } from "@nestjs/common";
import { GeolocationService } from "./geolocation.service";
import { GeolocationController } from "./geolocation.controller";

@Module({
  controllers: [GeolocationController],
  providers: [GeolocationService],
  exports: [GeolocationService],
})
export class GeolocationModule {}
