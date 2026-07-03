import { IsDateString, IsEmail, IsEnum, IsOptional, IsString, MinLength } from "class-validator";

export enum CreateEmployeeEmploymentStatus {
  REGULAR = "REGULAR",
  CONTRACTUAL_SEASONAL = "CONTRACTUAL_SEASONAL",
  PIECE_RATE = "PIECE_RATE",
}

export enum CreateEmployeeAttendanceMode {
  FIXED = "FIXED",
  FIELD = "FIELD",
}

export enum EmployeeSoloParentStatus {
  NOT_APPLICABLE = "NOT_APPLICABLE",
  ELIGIBLE = "ELIGIBLE",
  INELIGIBLE = "INELIGIBLE",
}

export class CreateEmployeeDto {
  @IsString()
  firstName!: string;

  @IsString()
  lastName!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsString()
  department!: string;

  @IsOptional()
  @IsDateString()
  hireDate?: string;

  @IsEnum(CreateEmployeeEmploymentStatus)
  employmentStatus!: CreateEmployeeEmploymentStatus;

  @IsOptional()
  @IsEnum(CreateEmployeeAttendanceMode)
  attendanceMode?: CreateEmployeeAttendanceMode;
}

export class UpdateEmployeeDto {
  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  department?: string;

  @IsOptional()
  @IsString()
  position?: string;

  @IsOptional()
  @IsDateString()
  hireDate?: string;

  @IsOptional()
  @IsEnum(CreateEmployeeEmploymentStatus)
  employmentStatus?: CreateEmployeeEmploymentStatus;

  @IsOptional()
  @IsEnum(CreateEmployeeAttendanceMode)
  attendanceMode?: CreateEmployeeAttendanceMode;

  @IsOptional()
  @IsEnum(EmployeeSoloParentStatus)
  soloParentStatus?: EmployeeSoloParentStatus;
}
