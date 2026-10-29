import { ArrayMinSize, IsArray, IsDateString, IsOptional, IsString } from "class-validator";

// The reason is checked in LeaveService.cancel() (so a blank one gets its
// friendly message); the supporting document is optional.
export class CancelLeaveRequestDto {
  // Only these days of the leave are cancelled (the rest stay); omitted =
  // the whole leave. See LeaveService.cancel().
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsDateString({}, { each: true })
  dates?: string[];

  @IsOptional()
  @IsString()
  note?: string;

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
