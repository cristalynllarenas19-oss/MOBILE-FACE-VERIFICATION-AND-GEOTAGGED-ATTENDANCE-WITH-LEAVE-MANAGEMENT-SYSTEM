import { IsOptional, IsString } from "class-validator";

export class ResubmitLeaveRequestDto {
  @IsOptional()
  @IsString()
  note?: string;

  @IsString()
  attachmentName!: string;

  @IsString()
  attachmentMimeType!: string;

  @IsString()
  attachmentData!: string;
}
