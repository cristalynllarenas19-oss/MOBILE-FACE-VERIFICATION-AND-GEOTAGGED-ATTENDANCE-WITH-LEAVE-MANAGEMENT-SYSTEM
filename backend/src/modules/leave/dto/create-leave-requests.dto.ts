import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsOptional, IsString } from "class-validator";

// Several single-day requests of one leave type filed together — Sick Leave
// for a handful of past absences (plus today) picked at once. Each date
// becomes its own request; everything else is shared.
export class CreateLeaveRequestsDto {
  @IsString()
  employeeId!: string;

  @IsString()
  leaveTypeId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(31)
  @IsDateString({}, { each: true })
  dates!: string[];

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
