import { Body, Controller, ForbiddenException, Get, Param, Post, Req } from "@nestjs/common";
import { RequirePermissions } from "../../common/decorators/permissions.decorator";
import { getAuditContext } from "../../common/utils/audit-context.util";
import { RegularizationDecisionDto, RegularizationRemarksDto } from "./dto/evaluation.dto";
import { EvaluationsService } from "./evaluations.service";

// Regularization review of a probationary employee: the Supervisor
// recommends, the Admin decides. Ownership (employee.supervisorId === the
// caller's own employeeId) is enforced in the service, not here, since it
// needs a DB lookup — same split as EmployeesService.resolveSupervisorId.
@Controller("evaluations")
export class EvaluationsController {
  constructor(private readonly evaluationsService: EvaluationsService) {}

  // The record both roles see when they open the review — an Admin for any
  // employee, a Supervisor for their own team only (checked in the service).
  @Get("employee/:employeeId/review")
  @RequirePermissions("employees:read")
  findReview(@Param("employeeId") employeeId: string, @Req() request: Request) {
    const user = (request as any).user;
    return this.evaluationsService.findReview(employeeId, {
      employeeId: user.employeeId,
      roles: user.roles ?? [user.role],
    });
  }

  @Post("employee/:employeeId/recommend")
  @RequirePermissions("evaluations:write")
  recommend(@Param("employeeId") employeeId: string, @Body() dto: RegularizationDecisionDto, @Req() request: Request) {
    const supervisorEmployeeId = (request as any).user.employeeId;
    return this.evaluationsService.recommend(employeeId, supervisorEmployeeId, dto, getAuditContext(request));
  }

  // Admin's Reject. Gated on the ADMIN role itself (not just a permission
  // code) so a Supervisor can never settle a regularization by calling this
  // directly. The Admin's Approve is the ordinary PATCH /employees/:id.
  @Post("employee/:employeeId/reject")
  @RequirePermissions("employees:write")
  reject(@Param("employeeId") employeeId: string, @Body() dto: RegularizationRemarksDto, @Req() request: Request) {
    const user = (request as any).user;
    const roles: string[] = user.roles ?? [user.role];
    if (!roles.includes("ADMIN")) {
      throw new ForbiddenException("Only Admin can reject a regularization.");
    }
    return this.evaluationsService.rejectRegularization(employeeId, dto, getAuditContext(request));
  }
}
