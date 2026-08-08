import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { RequirePermissions } from "../../common/decorators/permissions.decorator";
import { getSupervisorDepartmentScope } from "../../common/utils/supervisor-scope.util";
import { CreateUndertimeFilingDto } from "./dto/create-undertime-filing.dto";
import { UndertimeService } from "./undertime.service";

// Reuses the leave module's permission codes rather than introducing new
// ones — undertime filing is the same kind of employee self-service action
// as filing a leave request, and adding a parallel "undertime:read/write"
// permission pair (plus RBAC seed rows and admin-permissions UI entries)
// would duplicate machinery that already covers this case.
@Controller("undertime-filings")
export class UndertimeController {
  constructor(private readonly undertimeService: UndertimeService) {}

  @Get()
  @RequirePermissions("leave:read")
  findAll(@Req() request: Request, @Query("employeeId") employeeId?: string) {
    const user = (request as any).user;
    const roles: string[] = user.roles ?? [user.role];
    const hasElevatedRole = roles.includes("ADMIN") || roles.includes("SUPERVISOR");
    const scopedEmployeeId = hasElevatedRole ? employeeId : user.employeeId;
    const departmentId = getSupervisorDepartmentScope(user);
    return this.undertimeService.findAll(scopedEmployeeId, departmentId);
  }

  @Get("eligibility/:employeeId")
  @RequirePermissions("leave:read")
  getEligibility(@Param("employeeId") employeeId: string) {
    return this.undertimeService.getEligibility(employeeId);
  }

  @Post()
  @RequirePermissions("leave:write")
  create(@Body() dto: CreateUndertimeFilingDto) {
    return this.undertimeService.file(dto.employeeId, dto.reason);
  }
}
