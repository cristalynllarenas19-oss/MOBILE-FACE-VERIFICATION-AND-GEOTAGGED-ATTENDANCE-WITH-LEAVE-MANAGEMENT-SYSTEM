import { Body, Controller, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
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

  @Patch(":id")
  @RequirePermissions("schedules:write")
  updateAssignment(
    @Param("id") id: string,
    @Body()
    dto: {
      shiftId?: string;
      startsOn?: string;
      endsOn?: string | null;
    },
  ) {
    return this.schedulesService.updateAssignment(id, dto);
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
    @Req() request: Request,
  ) {
    return this.schedulesService.createShift(dto, (request as any).user?.userId);
  }

  @Patch("shifts/:id")
  @RequirePermissions("schedules:write")
  updateShift(
    @Param("id") id: string,
    @Body()
    dto: {
      name?: string;
      startTime?: string;
      endTime?: string;
      gracePeriodMinutes?: number;
    },
    @Req() request: Request,
  ) {
    return this.schedulesService.updateShift(id, dto, (request as any).user?.userId);
  }

  @Patch("shifts/:id/status")
  @RequirePermissions("schedules:write")
  setShiftStatus(
    @Param("id") id: string,
    @Body() dto: { isActive: boolean },
    @Req() request: Request,
  ) {
    return this.schedulesService.setShiftStatus(id, dto.isActive, (request as any).user?.userId);
  }
}
