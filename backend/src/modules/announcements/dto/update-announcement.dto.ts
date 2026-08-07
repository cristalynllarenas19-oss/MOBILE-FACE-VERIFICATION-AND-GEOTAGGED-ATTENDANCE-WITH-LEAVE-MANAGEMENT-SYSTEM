import { AnnouncementStatus } from "@prisma/client";
import { IsArray, IsBoolean, IsDateString, IsEnum, IsOptional, IsString } from "class-validator";

// Editing is only allowed while an announcement is still DRAFT or
// SCHEDULED (enforced in AnnouncementsService.update) — every field is
// therefore optional, same shape as CreateAnnouncementDto.
export class UpdateAnnouncementDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  message?: string;

  @IsOptional()
  @IsEnum(AnnouncementStatus)
  status?: AnnouncementStatus;

  @IsOptional()
  @IsDateString()
  scheduledAt?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  targetDepartmentIds?: string[];

  @IsOptional()
  @IsBoolean()
  targetSupervisorsOnly?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  targetEmployeeIds?: string[];
}
