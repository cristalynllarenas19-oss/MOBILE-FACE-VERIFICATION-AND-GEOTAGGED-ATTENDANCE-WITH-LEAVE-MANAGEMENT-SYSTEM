import { IsBoolean, IsOptional } from "class-validator";

export class NotificationPreferencesDto {
  @IsOptional()
  @IsBoolean()
  notifyOnAttendance?: boolean;

  @IsOptional()
  @IsBoolean()
  notifyOnLeaveUpdates?: boolean;
}
