import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from "@nestjs/common";
import { RequirePermissions } from "../../common/decorators/permissions.decorator";
import { getAuditContext } from "../../common/utils/audit-context.util";
import { getSupervisorDepartmentScope } from "../../common/utils/supervisor-scope.util";
import { GeolocationService } from "./geolocation.service";

@Controller("geolocation")
export class GeolocationController {
  constructor(private readonly geolocationService: GeolocationService) {}

  @Get("locations")
  findAllLocations(@Req() request: Request) {
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.geolocationService.findAllLocations(departmentId);
  }

  @Get("my-location")
  getMyLocation(@Req() request: Request) {
    const employeeId = (request as any).user.employeeId;
    return this.geolocationService.getLocationForEmployee(employeeId);
  }

  @Get("my-locations")
  getMyLocations(@Req() request: Request) {
    const employeeId = (request as any).user.employeeId;
    return this.geolocationService.getLocationsForEmployee(employeeId);
  }

  @Post("locations")
  @RequirePermissions("geolocation:write")
  createLocation(@Body() data: any, @Req() request: Request) {
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.geolocationService.createLocation({
      name: data.name,
      latitude: Number(data.latitude),
      longitude: Number(data.longitude),
      radiusMeters: Number(data.radiusMeters),
      allowedAccuracyMeters: data.allowedAccuracyMeters !== undefined ? Number(data.allowedAccuracyMeters) : undefined,
      employeeIds: Array.isArray(data.employeeIds) ? data.employeeIds : [],
      departmentId: data.departmentId !== undefined ? data.departmentId : undefined,
    }, getAuditContext(request), { departmentId });
  }

  @Patch("locations/:id")
  @RequirePermissions("geolocation:write")
  updateLocation(@Param("id") id: string, @Body() data: any, @Req() request: Request) {
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.geolocationService.updateLocation(id, {
      name: data.name,
      latitude: data.latitude !== undefined ? Number(data.latitude) : undefined,
      longitude: data.longitude !== undefined ? Number(data.longitude) : undefined,
      radiusMeters: data.radiusMeters !== undefined ? Number(data.radiusMeters) : undefined,
      allowedAccuracyMeters: data.allowedAccuracyMeters !== undefined ? Number(data.allowedAccuracyMeters) : undefined,
      isActive: data.isActive !== undefined ? Boolean(data.isActive) : undefined,
      employeeIds: Array.isArray(data.employeeIds) ? data.employeeIds : undefined,
      departmentId: data.departmentId !== undefined ? data.departmentId : undefined,
    }, getAuditContext(request), { departmentId });
  }

  @Post("locations/:id/employees/:employeeId")
  @RequirePermissions("geolocation:write")
  addEmployee(@Param("id") id: string, @Param("employeeId") employeeId: string, @Req() request: Request) {
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.geolocationService.addEmployee(id, employeeId, getAuditContext(request), { departmentId });
  }

  @Delete("locations/:id/employees/:employeeId")
  @RequirePermissions("geolocation:write")
  removeEmployee(@Param("id") id: string, @Param("employeeId") employeeId: string, @Req() request: Request) {
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.geolocationService.removeEmployee(id, employeeId, getAuditContext(request), { departmentId });
  }

  @Delete("locations/:id")
  @RequirePermissions("geolocation:write")
  removeLocation(@Param("id") id: string, @Req() request: Request) {
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.geolocationService.removeLocation(id, getAuditContext(request), { departmentId });
  }
}
