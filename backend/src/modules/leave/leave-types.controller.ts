import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from "@nestjs/common";
import { EmploymentStatus, LeaveTypeKind } from "@prisma/client";
import { IsArray, IsBoolean, IsEnum, IsIn, IsNumber, IsOptional, IsString, Min } from "class-validator";
import { LeaveTypesService } from "./leave-types.service";
import { RequirePermissions } from "../../common/decorators/permissions.decorator";

const CANCELLATION_CUTOFF_UNITS = ["WORKING_DAYS_BEFORE_START", "HOURS_BEFORE_SHIFT_START"] as const;

export class CreateLeaveTypeDto {
  @IsString()
  name!: string;

  @IsNumber()
  defaultDays!: number;

  @IsOptional()
  @IsBoolean()
  requiresDocument?: boolean;

  @IsOptional()
  @IsNumber()
  supportingDocumentAfterDays?: number;

  @IsOptional()
  @IsBoolean()
  requiresHrValidation?: boolean;

  @IsOptional()
  @IsBoolean()
  requiresEhsActivation?: boolean;

  @IsOptional()
  @IsBoolean()
  allowWithoutPay?: boolean;

  @IsOptional()
  @IsBoolean()
  isTransferable?: boolean;

  @IsOptional()
  @IsBoolean()
  isAutoCredited?: boolean;

  @IsOptional()
  @IsArray()
  @IsEnum(EmploymentStatus, { each: true })
  applicableStatuses?: EmploymentStatus[];

  @IsOptional()
  @IsBoolean()
  isUnlimitedDays?: boolean;

  @IsOptional()
  @IsBoolean()
  requiresAdminGrant?: boolean;

  @IsOptional()
  @IsBoolean()
  isSingleDayOnly?: boolean;

  @IsOptional()
  @IsBoolean()
  advanceFilingAllowed?: boolean;

  @IsOptional()
  @IsEnum(LeaveTypeKind)
  kind?: LeaveTypeKind;

  @IsOptional()
  @IsBoolean()
  cancellationAllowed?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  cancellationCutoffValue?: number;

  @IsOptional()
  @IsString()
  @IsIn(CANCELLATION_CUTOFF_UNITS)
  cancellationCutoffUnit?: string;
}

export class UpdateLeaveTypeDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsNumber()
  defaultDays?: number;

  @IsOptional()
  @IsBoolean()
  requiresDocument?: boolean;

  @IsOptional()
  @IsNumber()
  supportingDocumentAfterDays?: number;

  @IsOptional()
  @IsBoolean()
  requiresHrValidation?: boolean;

  @IsOptional()
  @IsBoolean()
  requiresEhsActivation?: boolean;

  @IsOptional()
  @IsBoolean()
  allowWithoutPay?: boolean;

  @IsOptional()
  @IsBoolean()
  isTransferable?: boolean;

  @IsOptional()
  @IsBoolean()
  isAutoCredited?: boolean;

  @IsOptional()
  @IsArray()
  @IsEnum(EmploymentStatus, { each: true })
  applicableStatuses?: EmploymentStatus[];

  @IsOptional()
  @IsBoolean()
  isUnlimitedDays?: boolean;

  @IsOptional()
  @IsBoolean()
  requiresAdminGrant?: boolean;

  @IsOptional()
  @IsBoolean()
  isSingleDayOnly?: boolean;

  @IsOptional()
  @IsBoolean()
  advanceFilingAllowed?: boolean;

  @IsOptional()
  @IsEnum(LeaveTypeKind)
  kind?: LeaveTypeKind;

  @IsOptional()
  @IsBoolean()
  cancellationAllowed?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  cancellationCutoffValue?: number;

  @IsOptional()
  @IsString()
  @IsIn(CANCELLATION_CUTOFF_UNITS)
  cancellationCutoffUnit?: string;
}

export class SetLeaveTypeStatusDto {
  @IsBoolean()
  isActive!: boolean;
}

export class SetEhsActivationDto {
  @IsBoolean()
  ehsActivated!: boolean;
}


@Controller("leave-types")
export class LeaveTypesController {
  constructor(private readonly leaveTypesService: LeaveTypesService) {}

  @Get()
  findAll() {
    return this.leaveTypesService.findAll();
  }

  @Post()
  @RequirePermissions("leave-types:write")
  create(@Body() dto: CreateLeaveTypeDto, @Req() request: Request) {
    return this.leaveTypesService.create(dto, (request as any).user?.userId);
  }

  @Patch(":id")
  @RequirePermissions("leave-types:write")
  update(@Param("id") id: string, @Body() dto: UpdateLeaveTypeDto, @Req() request: Request) {
    return this.leaveTypesService.update(id, dto, (request as any).user?.userId);
  }

  @Patch(":id/status")
  @RequirePermissions("leave-types:write")
  setStatus(@Param("id") id: string, @Body() dto: SetLeaveTypeStatusDto, @Req() request: Request) {
    return this.leaveTypesService.setStatus(id, dto.isActive, (request as any).user?.userId);
  }

  @Patch(":id/ehs-activation")
  @RequirePermissions("leave-types:write")
  setEhsActivation(@Param("id") id: string, @Body() dto: SetEhsActivationDto, @Req() request: Request) {
    return this.leaveTypesService.setEhsActivation(id, dto.ehsActivated, (request as any).user?.userId);
  }

  @Delete(":id")
  @RequirePermissions("leave-types:write")
  remove(@Param("id") id: string, @Req() request: Request) {
    return this.leaveTypesService.remove(id, (request as any).user?.userId);
  }
}
