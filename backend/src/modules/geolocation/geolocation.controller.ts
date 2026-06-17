import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
import { GeolocationService } from "./geolocation.service";

@Controller("geolocation")
export class GeolocationController {
  constructor(private readonly geolocationService: GeolocationService) {}

  @Get("locations")
  findAllLocations() {
    return this.geolocationService.findAllLocations();
  }

  @Post("locations")
  createLocation(@Body() data: any) {
    return this.geolocationService.createLocation({
      name: data.name,
      latitude: Number(data.latitude),
      longitude: Number(data.longitude),
      radiusMeters: Number(data.radiusMeters),
      employeeId: data.employeeId,
    });
  }

  @Delete("locations/:id")
  removeLocation(@Param("id") id: string) {
    return this.geolocationService.removeLocation(id);
  }
}
