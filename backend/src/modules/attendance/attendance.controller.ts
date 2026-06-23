import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Param,
  Query,
} from "@nestjs/common";

import { AttendanceService } from "./attendance.service";
import { SubmitAttendanceDto } from "./dto/submit-attendance.dto";

@Controller("attendance")
export class AttendanceController {
  constructor(
    private readonly attendanceService: AttendanceService,
  ) {}

  @Get()
  findAll(
    @Query("department") department?: string,
    @Query("status") status?: string,
    @Query("date") date?: string,
  ) {
    return this.attendanceService.findAll({ department, status, date });
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
    @Body()
    dto: SubmitAttendanceDto,
  ) {
    return this.attendanceService.submit(dto);
  }

  @Patch(":id/approve")
  approve(@Param("id") id: string, @Body() body: { remarks?: string }) {
    return this.attendanceService.updateStatus(id, "PRESENT", body.remarks);
  }

  @Patch(":id/official-business")
  officialBusiness(@Param("id") id: string, @Body() body: { remarks?: string }) {
    return this.attendanceService.updateStatus(id, "OFFICIAL_BUSINESS", body.remarks);
  }
}
