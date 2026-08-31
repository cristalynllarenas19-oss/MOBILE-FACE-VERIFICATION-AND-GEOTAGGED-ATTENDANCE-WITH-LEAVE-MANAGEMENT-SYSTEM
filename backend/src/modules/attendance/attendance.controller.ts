import {
  Body,
  Controller,
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
  ) {
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.attendanceService.findAll({ department, departmentId, status, recordType, date, from, to });
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

  // Lazily loaded by the DTR viewer's detail modal — see getHistory()'s
  // comment for why photos aren't inlined in the list response.
  @Get("records/:id/photos")
  getRecordPhotos(@Param("id") id: string) {
    return this.attendanceService.getRecordPhotos(id);
  }

  // Face-mismatch attempts awaiting an admin/supervisor decision. Gated the
  // same as approve/official-business below since it surfaces a captured
  // "this might not be you" photo per attempt.
  @Get("flagged")
  @RequirePermissions("attendance:write")
  findFlagged(@Req() request: Request) {
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.attendanceService.findFlaggedLogs({ departmentId });
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

  @Patch(":id/official-business")
  @RequirePermissions("attendance:write")
  officialBusiness(@Param("id") id: string, @Body() body: { remarks?: string }, @Req() request: Request) {
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.attendanceService.updateStatus(id, "OFFICIAL_BUSINESS", body.remarks, getAuditContext(request), departmentId);
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
