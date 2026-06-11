import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { CreateLeaveRequestDto } from "./dto/create-leave-request.dto";
import { LeaveService } from "./leave.service";

@Controller("leave-requests")
export class LeaveController {
  constructor(private readonly leaveService: LeaveService) {}

  @Get()
  findAll() {
    return this.leaveService.findAll();
  }

  @Post()
  create(@Body() dto: CreateLeaveRequestDto) {
    return this.leaveService.create(dto);
  }

  @Patch(":id/approve")
  approve(@Param("id") id: string) {
    return this.leaveService.updateStatus(id, "APPROVED");
  }

  @Patch(":id/reject")
  reject(@Param("id") id: string) {
    return this.leaveService.updateStatus(id, "REJECTED");
  }
}
