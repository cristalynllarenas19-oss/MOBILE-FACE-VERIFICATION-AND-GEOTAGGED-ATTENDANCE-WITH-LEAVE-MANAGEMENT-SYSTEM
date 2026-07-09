import { IsOptional, IsString } from "class-validator";

export class ArchiveFaceProfileDto {
  @IsOptional()
  @IsString()
  reason?: string;
}
