import { Body, Controller, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { RequirePermissions } from "../../common/decorators/permissions.decorator";
import { getAuditContext } from "../../common/utils/audit-context.util";
import { getSupervisorDepartmentScope } from "../../common/utils/supervisor-scope.util";
import { CutoffBounds } from "../../common/utils/cutoff.util";
import { CreateUndertimeFilingDto } from "./dto/create-undertime-filing.dto";
import { UndertimeService } from "./undertime.service";

// Reuses the leave module's permission codes rather than introducing new
// ones — undertime filing/approval is the same kind of employee self-service
// + supervisor/HR review action as a leave request, and adding a parallel
// "undertime:read/write/approve" permission set (plus RBAC seed rows and
// admin-permissions UI entries) would duplicate machinery that already
// covers this case.
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

  // Reuses "leave-types:write" (ADMIN-only in practice, see seed.ts) rather
  // than a new permission — same reasoning as the rest of this controller.
  @Get("settings")
  @RequirePermissions("leave:read")
  getSettings() {
    return this.undertimeService.getSettings();
  }

  @Patch("settings")
  @RequirePermissions("leave-types:write")
  updateSettings(@Body() body: { filingDaysOfMonth: number[] }, @Req() request: Request) {
    return this.undertimeService.updateSettings(body.filingDaysOfMonth, getAuditContext(request));
  }

  @Patch("settings/cutoffs")
  @RequirePermissions("leave-types:write")
  updateCutoffBounds(@Body() body: CutoffBounds, @Req() request: Request) {
    return this.undertimeService.updateCutoffBounds(body, getAuditContext(request));
  }

  @Post()
  @RequirePermissions("leave:write")
  create(@Body() dto: CreateUndertimeFilingDto, @Req() request: Request) {
    return this.undertimeService.file(dto.employeeId, dto.attendanceRecordId, dto.reason, getAuditContext(request));
  }

  @Patch(":id/approve")
  @RequirePermissions("leave:approve")
  approve(@Param("id") id: string, @Body() body: { remarks?: string }, @Req() request: Request) {
    const user = (request as any).user;
    const roles: string[] = user.roles ?? [user.role];
    const isAdmin = roles.includes("ADMIN");
    const departmentId = getSupervisorDepartmentScope(user);
    // A Supervisor can never approve their own filing — it must sit PENDING
    // until HR/Admin acts on it directly, same rule as leave requests.
    const selfReviewEmployeeId = isAdmin ? undefined : user.employeeId;
    return this.undertimeService.updateStatus(id, "APPROVED", body.remarks, getAuditContext(request), departmentId, selfReviewEmployeeId);
  }

  @Patch(":id/reject")
  @RequirePermissions("leave:approve")
  reject(@Param("id") id: string, @Body() body: { remarks?: string }, @Req() request: Request) {
    const user = (request as any).user;
    const roles: string[] = user.roles ?? [user.role];
    const isAdmin = roles.includes("ADMIN");
    const departmentId = getSupervisorDepartmentScope(user);
    const selfReviewEmployeeId = isAdmin ? undefined : user.employeeId;
    return this.undertimeService.updateStatus(id, "REJECTED", body.remarks, getAuditContext(request), departmentId, selfReviewEmployeeId);
  }
}
