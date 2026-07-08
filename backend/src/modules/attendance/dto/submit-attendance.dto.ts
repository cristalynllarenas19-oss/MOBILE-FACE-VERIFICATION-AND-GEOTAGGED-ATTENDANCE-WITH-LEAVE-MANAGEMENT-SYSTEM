import { IsEnum, IsNumber, IsOptional, IsString, Max, Min } from "class-validator";

export enum SubmitAttendanceType {
  TIME_IN = "TIME_IN",
  TIME_OUT = "TIME_OUT",
}

// What the employee tapped, for the ambiguous window after Time In and
// before Time Out where lunch break is optional — state alone (which
// timestamps are already set) can't tell TIME_OUT, LUNCH_OUT, and LUNCH_IN
// apart since all three can be legal next actions at once. Only meaningful
// for OFFICE/FIXED submissions; ignored for FIELD visits and for Time In.
export enum SubmitAttendanceAction {
  TIME_OUT = "TIME_OUT",
  LUNCH_OUT = "LUNCH_OUT",
  LUNCH_IN = "LUNCH_IN",
}

export class SubmitAttendanceDto {
  @IsString()
  employeeId!: string;

  @IsOptional()
  @IsEnum(SubmitAttendanceType)
  logType?: SubmitAttendanceType;

  @IsOptional()
  @IsEnum(SubmitAttendanceAction)
  action?: SubmitAttendanceAction;

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
  faceImageBase64!: string;

  @IsString()
  deviceId!: string;

  @IsOptional()
  @IsString()
  workLocationId?: string;
}
