import { Controller, Get, Post, Body, UseGuards } from "@nestjs/common";
import { LeaveTypesService } from "./leave-types.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";

export class CreateLeaveTypeDto {
  name!: string;
  defaultDays!: number;
  requiresDocument?: boolean;
}


@Controller("leave-types")
@UseGuards(JwtAuthGuard)
export class LeaveTypesController {
  constructor(private readonly leaveTypesService: LeaveTypesService) {}

  @Get()
  findAll() {
    return this.leaveTypesService.findAll();
  }

  @Post()
  create(@Body() dto: CreateLeaveTypeDto) {
    return this.leaveTypesService.create(dto);
  }
}