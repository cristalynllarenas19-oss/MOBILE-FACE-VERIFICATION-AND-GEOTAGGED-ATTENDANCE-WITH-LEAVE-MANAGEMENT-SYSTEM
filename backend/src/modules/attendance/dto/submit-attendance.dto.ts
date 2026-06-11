import { IsEnum, IsNumber, IsString, Max, Min } from "class-validator";

export enum SubmitAttendanceType {
  TIME_IN = "TIME_IN",
  TIME_OUT = "TIME_OUT",
}

export class SubmitAttendanceDto {
  @IsString()
  employeeId!: string;

  @IsEnum(SubmitAttendanceType)
  logType!: SubmitAttendanceType;

  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude!: number;

  @IsNumber()
  accuracyMeters!: number;

  @IsNumber()
  livenessScore!: number;

  @IsNumber()
  similarityScore!: number;

  @IsString()
  deviceId!: string;
}
