import { IsOptional, IsString } from "class-validator";

// The 30-day Maternity Leave extension request (see
// LeaveService.requestExtension). The reason is checked there (so a blank
// one gets its friendly message); the supporting document is optional.
export class RequestLeaveExtensionDto {
  @IsOptional()
  @IsString()
  reason?: string;

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
