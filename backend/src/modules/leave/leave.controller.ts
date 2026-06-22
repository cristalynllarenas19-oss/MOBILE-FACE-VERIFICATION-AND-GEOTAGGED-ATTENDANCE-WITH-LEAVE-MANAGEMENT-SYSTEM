import { Body, Controller, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { RequirePermissions } from "../../common/decorators/permissions.decorator";
import { CreateLeaveRequestDto } from "./dto/create-leave-request.dto";
import { LeaveService } from "./leave.service";

@Controller("leave-requests")
export class LeaveController {
  constructor(private readonly leaveService: LeaveService) {}

  @Get()
  @RequirePermissions("leave:read")
  findAll(@Req() request: Request, @Query("employeeId") employeeId?: string) {
    const user = (request as any).user;
    // Employees may only ever see their own leave history, regardless of what was requested.
    const scopedEmployeeId = user.role === "EMPLOYEE" ? user.employeeId : employeeId;
    return this.leaveService.findAll(scopedEmployeeId);
  }

  @Post()
  @RequirePermissions("leave:write")
  create(@Body() dto: CreateLeaveRequestDto) {
    return this.leaveService.create(dto);
  }

  @Patch(":id/approve")
  @RequirePermissions("leave:write")
  approve(@Param("id") id: string, @Body() body: { remarks?: string }) {
    return this.leaveService.updateStatus(id, "APPROVED", body.remarks);
  }

  @Patch(":id/reject")
  @RequirePermissions("leave:write")
  reject(@Param("id") id: string, @Body() body: { remarks?: string }) {
    return this.leaveService.updateStatus(id, "REJECTED", body.remarks);
  }
}
