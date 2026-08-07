import { AnnouncementStatus } from "@prisma/client";
import { IsArray, IsBoolean, IsDateString, IsEnum, IsOptional, IsString } from "class-validator";

export class CreateAnnouncementDto {
  @IsString()
  title!: string;

  @IsString()
  message!: string;

  // Omitted = PUBLISHED (send immediately), same as the original behavior.
  // DRAFT skips recipient resolution/notification entirely; SCHEDULED
  // requires scheduledAt and is published later by the cron in
  // AnnouncementsService.
  @IsOptional()
  @IsEnum(AnnouncementStatus)
  status?: AnnouncementStatus;

  @IsOptional()
  @IsDateString()
  scheduledAt?: string;

  // All three target fields omitted/empty/false = all active employees.
  // Otherwise the recipient set is the union of these three scopes — see
  // AnnouncementsService.resolveTargetEmployees. Validity (existing
  // department/employee IDs) is checked there, not here.
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
