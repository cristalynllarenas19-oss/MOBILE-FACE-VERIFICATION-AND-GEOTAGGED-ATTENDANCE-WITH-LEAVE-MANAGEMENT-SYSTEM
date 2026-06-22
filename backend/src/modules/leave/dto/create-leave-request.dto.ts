import { IsDateString, IsNumber, IsOptional, IsString } from "class-validator";

export class CreateLeaveRequestDto {
  @IsString()
  employeeId!: string;

  @IsString()
  leaveTypeId!: string;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsNumber()
  totalDays!: number;

  @IsString()
  reason!: string;

  @IsOptional()
  @IsString()
  attachmentName?: string;

  @IsOptional()
  @IsString()
  attachmentMimeType?: string;

  @IsOptional()
  @IsString()
  attachmentData?: string;
}
