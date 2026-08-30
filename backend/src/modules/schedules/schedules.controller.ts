import { Body, Controller, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { RequirePermissions } from "../../common/decorators/permissions.decorator";
import { getSupervisorDepartmentScope } from "../../common/utils/supervisor-scope.util";
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
    @Query("archived") archived?: string,
  ) {
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.schedulesService.findAll({ department, departmentId, shiftId, status, archived: archived === "true" });
  }

  @Get("shifts")
  findShifts() {
    return this.schedulesService.findShifts();
  }

  // Self-scoped — any authenticated user with an employee record can read
  // their own schedule (used by the leave calendar), independent of the
  // "schedules:write"-gated management endpoints below.
  @Get("mine")
  findMine(@Req() request: Request) {
    const employeeId = (request as any).user?.employeeId;
    return employeeId ? this.schedulesService.findMine(employeeId) : [];
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
      workingDays?: number[];
    },
    @Req() request: Request,
  ) {
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.schedulesService.createAssignment(dto, departmentId);
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
      workingDays?: number[];
    },
    @Req() request: Request,
  ) {
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.schedulesService.updateAssignment(id, dto, departmentId);
  }

  @Patch(":id/status")
  @RequirePermissions("schedules:write")
  setAssignmentStatus(
    @Param("id") id: string,
    @Body() dto: { isActive: boolean },
    @Req() request: Request,
  ) {
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.schedulesService.setAssignmentStatus(id, dto.isActive, departmentId);
  }

  @Post("shifts")
  @RequirePermissions("schedules:write")
  createShift(
    @Body()
    dto: {
      name: string;
      startTime: string;
      endTime: string;
      morningBreakMinutes?: number;
      afternoonBreakMinutes?: number;
      lunchBreakMinutes?: number;
      enableRounding?: boolean;
      roundingIntervalMinutes?: number;
      lateThresholdMinutes?: number;
      undertimeThresholdMinutes?: number;
      autoShiftAdjustment?: boolean;
      workingDays?: number[];
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
      morningBreakMinutes?: number;
      afternoonBreakMinutes?: number;
      lunchBreakMinutes?: number;
      enableRounding?: boolean;
      roundingIntervalMinutes?: number;
      lateThresholdMinutes?: number;
      undertimeThresholdMinutes?: number;
      autoShiftAdjustment?: boolean;
      workingDays?: number[];
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
