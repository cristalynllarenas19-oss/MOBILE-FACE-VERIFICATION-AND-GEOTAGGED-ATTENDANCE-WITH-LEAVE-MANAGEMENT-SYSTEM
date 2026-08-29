import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { RequirePermissions } from "../../common/decorators/permissions.decorator";
import { getAuditContext } from "../../common/utils/audit-context.util";
import { getSupervisorDepartmentScope } from "../../common/utils/supervisor-scope.util";
import { CreateLeaveRequestDto } from "./dto/create-leave-request.dto";
import { RejectLeaveRequestDto } from "./dto/reject-leave-request.dto";
import { ResubmitLeaveRequestDto } from "./dto/resubmit-leave-request.dto";
import { LeaveService } from "./leave.service";

@Controller("leave-requests")
export class LeaveController {
  constructor(private readonly leaveService: LeaveService) {}

  @Get()
  @RequirePermissions("leave:read")
  findAll(
    @Req() request: Request,
    @Query("employeeId") employeeId?: string,
    @Query("includeAttachments") includeAttachments?: string,
  ) {
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
    // Defaults to true (today's behavior) unless a caller explicitly opts out.
    const shouldIncludeAttachments = includeAttachments !== "false";
    return this.leaveService.findAll(scopedEmployeeId, departmentId, shouldIncludeAttachments);
  }

  @Post()
  @RequirePermissions("leave:write")
  create(@Body() dto: CreateLeaveRequestDto, @Req() request: Request) {
    return this.leaveService.create(dto, getAuditContext(request));
  }

  @Patch(":id/approve")
  @RequirePermissions("leave:approve")
  approve(@Param("id") id: string, @Body() body: { remarks?: string }, @Req() request: Request) {
    const user = (request as any).user;
    const roles: string[] = user.roles ?? [user.role];
    const isAdmin = roles.includes("ADMIN");
    // Single-step approval: a Supervisor's approval of their own department's
    // requests is final, same as an Admin's — no second HR sign-off tier.
    const departmentId = getSupervisorDepartmentScope(user);
    // A Supervisor still can never approve their own leave request — it must
    // sit PENDING until HR/Admin acts on it directly.
    const selfReviewEmployeeId = isAdmin ? undefined : user.employeeId;
    return this.leaveService.updateStatus(id, "APPROVED", body.remarks, getAuditContext(request), departmentId, selfReviewEmployeeId);
  }

  @Patch(":id/reject")
  @RequirePermissions("leave:approve")
  reject(@Param("id") id: string, @Body() body: RejectLeaveRequestDto, @Req() request: Request) {
    const user = (request as any).user;
    const roles: string[] = user.roles ?? [user.role];
    const isAdmin = roles.includes("ADMIN");
    const departmentId = getSupervisorDepartmentScope(user);
    const selfReviewEmployeeId = isAdmin ? undefined : user.employeeId;
    return this.leaveService.reject(id, body, getAuditContext(request), departmentId, selfReviewEmployeeId);
  }

  @Patch(":id/cancel")
  @RequirePermissions("leave:write")
  cancel(@Param("id") id: string, @Body() body: { note?: string }, @Req() request: Request) {
    const user = (request as any).user;
    const roles: string[] = user.roles ?? [user.role];
    // Cancelling is reserved for the employee who filed the request or an
    // ADMIN override — a SUPERVISOR is never treated as elevated here, so
    // they can only cancel a request that's their own (via user.employeeId),
    // never a subordinate's.
    const isAdmin = roles.includes("ADMIN");
    return this.leaveService.cancel(id, getAuditContext(request), isAdmin ? undefined : user?.employeeId, body?.note);
  }

  @Patch(":id/approve-cancellation")
  @RequirePermissions("leave:approve")
  approveCancellation(@Param("id") id: string, @Req() request: Request) {
    const user = (request as any).user;
    const roles: string[] = user.roles ?? [user.role];
    const isAdmin = roles.includes("ADMIN");
    const departmentId = getSupervisorDepartmentScope(user);
    // Same self-review guard as approve/reject — a Supervisor can never
    // decide on their own leave, including their own cancellation request.
    const selfReviewEmployeeId = isAdmin ? undefined : user.employeeId;
    return this.leaveService.approveCancellation(id, getAuditContext(request), departmentId, selfReviewEmployeeId);
  }

  @Patch(":id/deny-cancellation")
  @RequirePermissions("leave:approve")
  denyCancellation(@Param("id") id: string, @Body() body: { remarks?: string }, @Req() request: Request) {
    const user = (request as any).user;
    const roles: string[] = user.roles ?? [user.role];
    const isAdmin = roles.includes("ADMIN");
    const departmentId = getSupervisorDepartmentScope(user);
    const selfReviewEmployeeId = isAdmin ? undefined : user.employeeId;
    return this.leaveService.denyCancellation(id, body?.remarks, getAuditContext(request), departmentId, selfReviewEmployeeId);
  }

  @Patch(":id/resubmit")
  @RequirePermissions("leave:write")
  resubmit(@Param("id") id: string, @Body() body: ResubmitLeaveRequestDto, @Req() request: Request) {
    const user = (request as any).user;
    const roles: string[] = user.roles ?? [user.role];
    const hasElevatedRole = roles.includes("ADMIN") || roles.includes("SUPERVISOR");
    return this.leaveService.resubmit(id, body, getAuditContext(request), hasElevatedRole ? undefined : user?.employeeId);
  }

  @Patch(":id/extension-decision")
  @RequirePermissions("leave:approve")
  setExtensionDecision(
    @Param("id") id: string,
    @Body() body: { extensionApproved: boolean },
    @Req() request: Request,
  ) {
    const user = (request as any).user;
    const roles: string[] = user.roles ?? [user.role];
    if (!roles.includes("ADMIN")) {
      throw new ForbiddenException("Only HR/Admin can decide a maternity leave extension.");
    }
    return this.leaveService.setExtensionDecision(id, body.extensionApproved, user?.userId);
  }
}
