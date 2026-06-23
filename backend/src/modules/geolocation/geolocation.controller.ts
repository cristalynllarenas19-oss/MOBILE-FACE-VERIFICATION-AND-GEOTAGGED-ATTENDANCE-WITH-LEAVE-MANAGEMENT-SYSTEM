import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from "@nestjs/common";
import { GeolocationService } from "./geolocation.service";

@Controller("geolocation")
export class GeolocationController {
  constructor(private readonly geolocationService: GeolocationService) {}

  @Get("locations")
  findAllLocations() {
    return this.geolocationService.findAllLocations();
  }

  @Get("my-location")
  getMyLocation(@Req() request: Request) {
    const employeeId = (request as any).user.employeeId;
    return this.geolocationService.getLocationForEmployee(employeeId);
  }

  @Post("locations")
  createLocation(@Body() data: any) {
    return this.geolocationService.createLocation({
      name: data.name,
      latitude: Number(data.latitude),
      longitude: Number(data.longitude),
      radiusMeters: Number(data.radiusMeters),
      allowedAccuracyMeters: data.allowedAccuracyMeters !== undefined ? Number(data.allowedAccuracyMeters) : undefined,
      employeeIds: Array.isArray(data.employeeIds) ? data.employeeIds : [],
      assignAllEmployees: Boolean(data.assignAllEmployees),
    });
  }

  @Patch("locations/:id")
  updateLocation(@Param("id") id: string, @Body() data: any) {
    return this.geolocationService.updateLocation(id, {
      name: data.name,
      latitude: data.latitude !== undefined ? Number(data.latitude) : undefined,
      longitude: data.longitude !== undefined ? Number(data.longitude) : undefined,
      radiusMeters: data.radiusMeters !== undefined ? Number(data.radiusMeters) : undefined,
      allowedAccuracyMeters: data.allowedAccuracyMeters !== undefined ? Number(data.allowedAccuracyMeters) : undefined,
      isActive: data.isActive !== undefined ? Boolean(data.isActive) : undefined,
      employeeIds: Array.isArray(data.employeeIds) ? data.employeeIds : undefined,
      assignAllEmployees: data.assignAllEmployees !== undefined ? Boolean(data.assignAllEmployees) : undefined,
    });
  }

  @Post("locations/:id/employees/:employeeId")
  addEmployee(@Param("id") id: string, @Param("employeeId") employeeId: string) {
    return this.geolocationService.addEmployee(id, employeeId);
  }

  @Delete("locations/:id/employees/:employeeId")
  removeEmployee(@Param("id") id: string, @Param("employeeId") employeeId: string) {
    return this.geolocationService.removeEmployee(id, employeeId);
  }

  @Delete("locations/:id")
  removeLocation(@Param("id") id: string) {
    return this.geolocationService.removeLocation(id);
  }
}
