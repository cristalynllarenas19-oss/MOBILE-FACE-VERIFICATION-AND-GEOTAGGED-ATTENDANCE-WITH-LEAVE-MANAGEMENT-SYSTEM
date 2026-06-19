import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { SchedulesService } from "./schedules.service";

@Controller("schedules")
export class SchedulesController {
  constructor(private readonly schedulesService: SchedulesService) {}

  @Get()
  findAll(
    @Query("department") department?: string,
    @Query("shiftId") shiftId?: string,
    @Query("status") status?: string,
  ) {
    return this.schedulesService.findAll({ department, shiftId, status });
  }

  @Get("shifts")
  findShifts() {
    return this.schedulesService.findShifts();
  }

  @Post()
  createAssignment(
    @Body()
    dto: {
      employeeId: string;
      shiftId: string;
      startsOn: string;
      endsOn?: string;
    },
  ) {
    return this.schedulesService.createAssignment(dto);
  }

  @Post("shifts")
  createShift(
    @Body()
    dto: {
      name: string;
      startTime: string;
      endTime: string;
      gracePeriodMinutes?: number;
    },
  ) {
    return this.schedulesService.createShift(dto);
  }
}
