import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from "@nestjs/common";
import { RequirePermissions } from "../../common/decorators/permissions.decorator";
import { GeolocationService } from "./geolocation.service";

@Controller("geolocation")
export class GeolocationController {
  constructor(private readonly geolocationService: GeolocationService) {}

  @Get("locations")
  findAllLocations(@Req() request: Request) {
    const user = (request as any).user;
    const departmentId = user.role === "SUPERVISOR" ? user.departmentId : undefined;
    return this.geolocationService.findAllLocations(departmentId);
  }

  @Get("my-location")
  getMyLocation(@Req() request: Request) {
    const employeeId = (request as any).user.employeeId;
    return this.geolocationService.getLocationForEmployee(employeeId);
  }

  @Post("locations")
  @RequirePermissions("geolocation:write")
  createLocation(@Body() data: any) {
    return this.geolocationService.createLocation({
      name: data.name,
      latitude: Number(data.latitude),
      longitude: Number(data.longitude),
      radiusMeters: Number(data.radiusMeters),
      allowedAccuracyMeters: data.allowedAccuracyMeters !== undefined ? Number(data.allowedAccuracyMeters) : undefined,
      employeeIds: Array.isArray(data.employeeIds) ? data.employeeIds : [],
    });
  }

  @Patch("locations/:id")
  @RequirePermissions("geolocation:write")
  updateLocation(@Param("id") id: string, @Body() data: any) {
    return this.geolocationService.updateLocation(id, {
      name: data.name,
      latitude: data.latitude !== undefined ? Number(data.latitude) : undefined,
      longitude: data.longitude !== undefined ? Number(data.longitude) : undefined,
      radiusMeters: data.radiusMeters !== undefined ? Number(data.radiusMeters) : undefined,
      allowedAccuracyMeters: data.allowedAccuracyMeters !== undefined ? Number(data.allowedAccuracyMeters) : undefined,
      isActive: data.isActive !== undefined ? Boolean(data.isActive) : undefined,
      employeeIds: Array.isArray(data.employeeIds) ? data.employeeIds : undefined,
    });
  }

  @Post("locations/:id/employees/:employeeId")
  @RequirePermissions("geolocation:write")
  addEmployee(@Param("id") id: string, @Param("employeeId") employeeId: string) {
    return this.geolocationService.addEmployee(id, employeeId);
  }

  @Delete("locations/:id/employees/:employeeId")
  @RequirePermissions("geolocation:write")
  removeEmployee(@Param("id") id: string, @Param("employeeId") employeeId: string) {
    return this.geolocationService.removeEmployee(id, employeeId);
  }

  @Delete("locations/:id")
  @RequirePermissions("geolocation:write")
  removeLocation(@Param("id") id: string) {
    return this.geolocationService.removeLocation(id);
  }
}
