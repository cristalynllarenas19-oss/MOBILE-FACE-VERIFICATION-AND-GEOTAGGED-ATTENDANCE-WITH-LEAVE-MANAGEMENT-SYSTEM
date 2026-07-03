import { Body, Controller, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { RequirePermissions } from "../../common/decorators/permissions.decorator";
import { getSupervisorDepartmentScope } from "../../common/utils/supervisor-scope.util";
import { CreateLeaveRequestDto } from "./dto/create-leave-request.dto";
import { LeaveService } from "./leave.service";

@Controller("leave-requests")
export class LeaveController {
  constructor(private readonly leaveService: LeaveService) {}

  @Get()
  @RequirePermissions("leave:read")
  findAll(@Req() request: Request, @Query("employeeId") employeeId?: string) {
    const user = (request as any).user;
    // Only ADMIN/SUPERVISOR may view org-wide leave requests; everyone else
    // (including an EMPLOYEE-linked account with no elevated role) only ever
    // sees their own history, regardless of what was requested. Checked via
    // the roles array, not the singular primary `role`, so an ADMIN or
    // SUPERVISOR account that also carries the EMPLOYEE role (the norm now
    // that promotions are additive) still gets the org-wide view.
    const roles: string[] = user.roles ?? [user.role];
    const hasElevatedRole = roles.includes("ADMIN") || roles.includes("SUPERVISOR");
    const scopedEmployeeId = hasElevatedRole ? employeeId : user.employeeId;
    const departmentId = getSupervisorDepartmentScope(user);
    return this.leaveService.findAll(scopedEmployeeId, departmentId);
  }

  @Post()
  @RequirePermissions("leave:write")
  create(@Body() dto: CreateLeaveRequestDto) {
    return this.leaveService.create(dto);
  }

  @Patch(":id/approve")
  @RequirePermissions("leave:approve")
  approve(@Param("id") id: string, @Body() body: { remarks?: string }, @Req() request: Request) {
    return this.leaveService.updateStatus(id, "APPROVED", body.remarks, (request as any).user?.userId);
  }

  @Patch(":id/reject")
  @RequirePermissions("leave:approve")
  reject(@Param("id") id: string, @Body() body: { remarks?: string }, @Req() request: Request) {
    return this.leaveService.updateStatus(id, "REJECTED", body.remarks, (request as any).user?.userId);
  }
}
