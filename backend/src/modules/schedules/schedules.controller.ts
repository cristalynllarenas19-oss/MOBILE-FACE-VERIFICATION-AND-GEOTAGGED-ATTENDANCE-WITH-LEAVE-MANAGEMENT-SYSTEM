import { Body, Controller, Get, Post, Query, Req } from "@nestjs/common";
import { RequirePermissions } from "../../common/decorators/permissions.decorator";
import { SchedulesService } from "./schedules.service";

@Controller("schedules")
export class SchedulesController {
  constructor(private readonly schedulesService: SchedulesService) {}

  @Get()
  findAll(
    @Req() request: Request,
    @Query("department") department?: string,
    @Query("shiftId") shiftId?: string,
    @Query("status") status?: string,
  ) {
    const user = (request as any).user;
    const departmentId = user.role === "SUPERVISOR" ? user.departmentId : undefined;
    return this.schedulesService.findAll({ department, departmentId, shiftId, status });
  }

  @Get("shifts")
  findShifts() {
    return this.schedulesService.findShifts();
  }

  @Post()
  @RequirePermissions("schedules:write")
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
  @RequirePermissions("schedules:write")
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
