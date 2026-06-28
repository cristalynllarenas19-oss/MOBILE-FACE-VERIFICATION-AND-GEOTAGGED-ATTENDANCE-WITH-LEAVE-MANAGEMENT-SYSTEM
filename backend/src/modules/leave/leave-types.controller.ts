import { Controller, Get, Post, Body, Req, UseGuards } from "@nestjs/common";
import { EmploymentStatus } from "@prisma/client";
import { IsArray, IsBoolean, IsEnum, IsNumber, IsOptional, IsString } from "class-validator";
import { LeaveTypesService } from "./leave-types.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";

export class CreateLeaveTypeDto {
  @IsString()
  name!: string;

  @IsNumber()
  defaultDays!: number;

  @IsOptional()
  @IsBoolean()
  requiresDocument?: boolean;

  @IsOptional()
  @IsArray()
  @IsEnum(EmploymentStatus, { each: true })
  applicableStatuses?: EmploymentStatus[];
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
  create(@Body() dto: CreateLeaveTypeDto, @Req() request: Request) {
    return this.leaveTypesService.create(dto, (request as any).user?.userId);
  }
}