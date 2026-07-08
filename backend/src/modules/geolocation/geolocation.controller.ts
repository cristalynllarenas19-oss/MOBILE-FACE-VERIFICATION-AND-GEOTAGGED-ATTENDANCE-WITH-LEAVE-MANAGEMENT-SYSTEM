import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Req } from "@nestjs/common";
import { RequirePermissions } from "../../common/decorators/permissions.decorator";
import { getAuditContext } from "../../common/utils/audit-context.util";
import { getSupervisorDepartmentScope } from "../../common/utils/supervisor-scope.util";
import { GeolocationService } from "./geolocation.service";

// Fields that change an area's own definition rather than who's assigned to
// it — a Supervisor may never touch these (create/edit/delete/activate are
// HR/Admin-only); they may only PATCH `employeeIds` to (un)assign their own
// department's employees to an area that already exists.
const AREA_METADATA_FIELDS = [
  "name",
  "latitude",
  "longitude",
  "radiusMeters",
  "allowedAccuracyMeters",
  "isActive",
  "departmentId",
  "type",
] as const;

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
    const user = (request as any).user;
    const roles: string[] = user.roles ?? [user.role];
    if (!roles.includes("ADMIN")) {
      throw new ForbiddenException("Only HR/Admin can add a geotagged area.");
    }
    const departmentId = getSupervisorDepartmentScope(user);
    return this.geolocationService.createLocation({
      name: data.name,
      latitude: Number(data.latitude),
      longitude: Number(data.longitude),
      radiusMeters: Number(data.radiusMeters),
      allowedAccuracyMeters: data.allowedAccuracyMeters !== undefined ? Number(data.allowedAccuracyMeters) : undefined,
      employeeIds: Array.isArray(data.employeeIds) ? data.employeeIds : [],
      departmentId: data.departmentId !== undefined ? data.departmentId : undefined,
      type: data.type === "FIELD" ? "FIELD" : data.type === "OFFICE" ? "OFFICE" : undefined,
    }, getAuditContext(request), { departmentId });
  }

  @Patch("locations/:id")
  @RequirePermissions("geolocation:write")
  updateLocation(@Param("id") id: string, @Body() data: any, @Req() request: Request) {
    const user = (request as any).user;
    const roles: string[] = user.roles ?? [user.role];
    const isAdmin = roles.includes("ADMIN");
    const changesAreaDetails = AREA_METADATA_FIELDS.some((field) => data[field] !== undefined);
    if (!isAdmin && changesAreaDetails) {
      throw new ForbiddenException(
        "Supervisors can only assign or unassign employees on an existing area — area details can only be changed by HR/Admin.",
      );
    }
    const departmentId = getSupervisorDepartmentScope(user);
    return this.geolocationService.updateLocation(id, {
      name: data.name,
      latitude: data.latitude !== undefined ? Number(data.latitude) : undefined,
      longitude: data.longitude !== undefined ? Number(data.longitude) : undefined,
      radiusMeters: data.radiusMeters !== undefined ? Number(data.radiusMeters) : undefined,
      allowedAccuracyMeters: data.allowedAccuracyMeters !== undefined ? Number(data.allowedAccuracyMeters) : undefined,
      isActive: data.isActive !== undefined ? Boolean(data.isActive) : undefined,
      employeeIds: Array.isArray(data.employeeIds) ? data.employeeIds : undefined,
      departmentId: data.departmentId !== undefined ? data.departmentId : undefined,
      type: data.type === "FIELD" ? "FIELD" : data.type === "OFFICE" ? "OFFICE" : undefined,
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
    const user = (request as any).user;
    const roles: string[] = user.roles ?? [user.role];
    if (!roles.includes("ADMIN")) {
      throw new ForbiddenException("Only HR/Admin can remove a geotagged area.");
    }
    const departmentId = getSupervisorDepartmentScope(user);
    return this.geolocationService.removeLocation(id, getAuditContext(request), { departmentId });
  }
}
