import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Patch,
  Post,
  Param,
  Query,
  Req,
} from "@nestjs/common";

import { RequirePermissions } from "../../common/decorators/permissions.decorator";
import { getAuditContext } from "../../common/utils/audit-context.util";
import { getSupervisorDepartmentScope } from "../../common/utils/supervisor-scope.util";
import { AttendanceService } from "./attendance.service";
import { SubmitAttendanceDto } from "./dto/submit-attendance.dto";

@Controller("attendance")
export class AttendanceController {
  constructor(
    private readonly attendanceService: AttendanceService,
  ) {}

  @Get()
  findAll(
    @Req() request: Request,
    @Query("department") department?: string,
    @Query("status") status?: string,
    @Query("recordType") recordType?: string,
    @Query("date") date?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("employeeId") employeeId?: string,
  ) {
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.attendanceService.findAll({ department, departmentId, status, recordType, date, from, to, employeeId });
  }

  @Get("today/:employeeId")
  getTodayAttendance(
    @Param("employeeId") employeeId: string,
  ) {
    return this.attendanceService.getTodayAttendance(
      employeeId,
    );
  }

  @Get("history/:employeeId")
  getHistory(
    @Param("employeeId") employeeId: string,
    @Query("limit") limit?: string,
  ) {
    return this.attendanceService.getHistory(employeeId, limit ? Number(limit) : undefined);
  }

  // The caller's own monthly DTR for the mobile Download/Print DTR. Takes no
  // employee id at all — it's read from the JWT, so changing a request
  // parameter can't return another employee's record.
  @Get("me/dtr")
  getMyMonthlyDtr(
    @Req() request: Request,
    @Query("year") year?: string,
    @Query("month") month?: string,
  ) {
    const employeeId = (request as any).user?.employeeId;
    if (!employeeId) throw new ForbiddenException("Only employees have a DTR.");
    return this.attendanceService.getMonthlyDtr(employeeId, Number(year), Number(month));
  }

  // Lazily loaded by the DTR viewer's detail modal — see getHistory()'s
  // comment for why photos aren't inlined in the list response.
  @Get("records/:id/photos")
  getRecordPhotos(@Param("id") id: string) {
    return this.attendanceService.getRecordPhotos(id);
  }

  // Lazily loaded by Attendance Management's detail modal — capture photos
  // plus the registered face, which findAll() leaves out of the list.
  @Get("records/:id/review-photos")
  getRecordReviewPhotos(@Param("id") id: string, @Req() request: Request) {
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.attendanceService.getRecordReviewPhotos(id, departmentId);
  }

  // Face-mismatch attempts awaiting an admin/supervisor decision. Gated the
  // same as approve below since it surfaces a captured
  // "this might not be you" photo per attempt.
  @Get("flagged")
  @RequirePermissions("attendance:write")
  findFlagged(@Req() request: Request, @Query("status") status?: string) {
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.attendanceService.findFlaggedLogs({ departmentId, rejected: status === "REJECTED" });
  }

  // A single attempt as opened from an attendance notification — see
  // findLogForReview. Same gating as the flagged list (it carries the photos).
  @Get("logs/:logId/review")
  @RequirePermissions("attendance:write")
  findLogForReview(@Param("logId") logId: string, @Req() request: Request) {
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.attendanceService.findLogForReview(logId, departmentId);
  }

  // The earlier failed attempts the given flagged log superseded — lazily
  // loaded by the review modal, same gating as the list above.
  @Get("flagged/:logId/attempts")
  @RequirePermissions("attendance:write")
  findPreviousFlaggedAttempts(@Param("logId") logId: string, @Req() request: Request) {
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.attendanceService.findPreviousFlaggedAttempts(logId, departmentId);
  }

  @Post("session")
  createSession() {
    return this.attendanceService.createSession();
  }

  @Post("submit")
  submit(
    @Req() request: Request,
    @Body()
    dto: SubmitAttendanceDto,
  ) {
    return this.attendanceService.submit(dto, getAuditContext(request));
  }

  @Patch(":id/approve")
  @RequirePermissions("attendance:write")
  approve(@Param("id") id: string, @Body() body: { remarks?: string }, @Req() request: Request) {
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.attendanceService.updateStatus(id, "PRESENT", body.remarks, getAuditContext(request), departmentId);
  }

  @Patch("flagged/:logId/validate")
  @RequirePermissions("attendance:write")
  validateFlagged(@Param("logId") logId: string, @Body() body: { remarks?: string }, @Req() request: Request) {
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.attendanceService.validateFlaggedLog(logId, body.remarks, getAuditContext(request), departmentId);
  }

  @Patch("flagged/:logId/reject")
  @RequirePermissions("attendance:write")
  rejectFlagged(@Param("logId") logId: string, @Body() body: { remarks?: string }, @Req() request: Request) {
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.attendanceService.rejectFlaggedLog(logId, body.remarks, getAuditContext(request), departmentId);
  }

  @Patch("flagged/:logId/archive")
  @RequirePermissions("attendance:write")
  archiveFlagged(@Param("logId") logId: string, @Body() body: { remarks?: string }, @Req() request: Request) {
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.attendanceService.archiveFlaggedLog(logId, body.remarks, getAuditContext(request), departmentId);
  }
}
