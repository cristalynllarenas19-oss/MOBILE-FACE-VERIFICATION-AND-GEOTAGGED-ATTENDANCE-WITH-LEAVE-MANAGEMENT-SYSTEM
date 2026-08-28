import { Controller, ForbiddenException, Get, Body, Param, Patch, Post, Req } from "@nestjs/common";
import { RequirePermissions } from "../../common/decorators/permissions.decorator";
import { getAuditContext } from "../../common/utils/audit-context.util";
import { SaveEvaluationDraftDto, SubmitEvaluationDto } from "./dto/evaluation.dto";
import { EvaluationsService } from "./evaluations.service";

// Most routes here are Supervisor-facing — ownership (employee.supervisorId
// === the caller's own employeeId) is enforced in the service, not here,
// since it needs a DB lookup — same split as EmployeesService.resolveSupervisorId.
// The one exception is admin-view below, which is Admin-only and read-only.
@Controller("evaluations")
export class EvaluationsController {
  constructor(private readonly evaluationsService: EvaluationsService) {}

  @Get("employee/:employeeId")
  @RequirePermissions("evaluations:write")
  findMine(@Param("employeeId") employeeId: string, @Req() request: Request) {
    const supervisorEmployeeId = (request as any).user.employeeId;
    return this.evaluationsService.findForSupervisor(employeeId, supervisorEmployeeId);
  }

  // Read-only, Admin-only — feeds the "View Performance" action on the
  // existing Employee Details modal. Deliberately gated on the ADMIN role
  // itself (not just a permission code) so a Supervisor calling this
  // directly with an arbitrary employeeId can never bypass their own
  // department scoping via this route — they already have findMine above,
  // ownership-checked, for their own submissions.
  @Get("employee/:employeeId/admin-view")
  @RequirePermissions("employees:read")
  async findForAdmin(@Param("employeeId") employeeId: string, @Req() request: Request) {
    const user = (request as any).user;
    const roles: string[] = user.roles ?? [user.role];
    if (!roles.includes("ADMIN")) {
      throw new ForbiddenException("Only Admin can view a submitted evaluation this way.");
    }
    const [evaluation, attendance] = await Promise.all([
      this.evaluationsService.findLatestSubmitted(employeeId),
      this.evaluationsService.computeAttendanceSummary(employeeId),
    ]);
    return { evaluation, attendance };
  }

  @Patch("employee/:employeeId/draft")
  @RequirePermissions("evaluations:write")
  saveDraft(@Param("employeeId") employeeId: string, @Body() dto: SaveEvaluationDraftDto, @Req() request: Request) {
    const supervisorEmployeeId = (request as any).user.employeeId;
    return this.evaluationsService.saveDraft(employeeId, supervisorEmployeeId, dto);
  }

  @Post("employee/:employeeId/submit")
  @RequirePermissions("evaluations:write")
  submit(@Param("employeeId") employeeId: string, @Body() dto: SubmitEvaluationDto, @Req() request: Request) {
    const supervisorEmployeeId = (request as any).user.employeeId;
    return this.evaluationsService.submit(employeeId, supervisorEmployeeId, dto, getAuditContext(request));
  }
}
