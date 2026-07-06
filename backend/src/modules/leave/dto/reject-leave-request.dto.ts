import { IsBoolean, IsOptional, IsString } from "class-validator";

export class RejectLeaveRequestDto {
  @IsOptional()
  @IsString()
  remarks?: string;

  @IsOptional()
  @IsBoolean()
  requiresAdditionalRequirements?: boolean;

  @IsOptional()
  @IsString()
  requirementDetails?: string;
}
