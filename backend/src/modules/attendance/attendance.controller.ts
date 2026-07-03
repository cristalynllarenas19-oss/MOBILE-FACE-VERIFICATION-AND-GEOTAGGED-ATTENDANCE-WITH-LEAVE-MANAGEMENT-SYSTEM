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
    @Query("date") date?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.attendanceService.findAll({ department, departmentId, status, date, from, to });
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
    return this.attendanceService.updateStatus(id, "PRESENT", body.remarks, getAuditContext(request));
  }

  @Patch(":id/official-business")
  @RequirePermissions("attendance:write")
  officialBusiness(@Param("id") id: string, @Body() body: { remarks?: string }, @Req() request: Request) {
    return this.attendanceService.updateStatus(id, "OFFICIAL_BUSINESS", body.remarks, getAuditContext(request));
  }
}
