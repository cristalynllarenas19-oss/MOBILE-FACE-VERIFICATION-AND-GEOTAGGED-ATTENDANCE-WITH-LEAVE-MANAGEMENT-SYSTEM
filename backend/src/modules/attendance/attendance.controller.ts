import {
  Body,
  Controller,
  Get,
  Post,
  Param,
} from "@nestjs/common";

import { AttendanceService } from "./attendance.service";
import { SubmitAttendanceDto } from "./dto/submit-attendance.dto";

@Controller("attendance")
export class AttendanceController {
  constructor(
    private readonly attendanceService: AttendanceService,
  ) {}

  @Get()
  findAll() {
    return this.attendanceService.findAll();
  }

  @Get("today/:employeeId")
  getTodayAttendance(
    @Param("employeeId") employeeId: string,
  ) {
    return this.attendanceService.getTodayAttendance(
      employeeId,
    );
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
}