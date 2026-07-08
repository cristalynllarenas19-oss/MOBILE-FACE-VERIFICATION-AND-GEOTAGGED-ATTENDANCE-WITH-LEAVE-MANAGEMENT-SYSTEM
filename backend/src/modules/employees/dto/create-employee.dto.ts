import { IsDateString, IsEmail, IsEnum, IsInt, IsOptional, IsString, Min } from "class-validator";

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

export enum CreateEmployeeSex {
  MALE = "MALE",
  FEMALE = "FEMALE",
}

export class CreateEmployeeDto {
  @IsString()
  firstName!: string;

  @IsString()
  lastName!: string;

  @IsEmail()
  email!: string;

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

  @IsEnum(CreateEmployeeSex)
  sex!: CreateEmployeeSex;

  @IsOptional()
  @IsEnum(EmployeeSoloParentStatus)
  soloParentStatus?: EmployeeSoloParentStatus;

  // Must be the id of an existing Employee who carries the SUPERVISOR role in
  // the same department — validated in EmployeesService, not here, since it
  // needs a DB lookup. Omit to leave unassigned; not present on this DTO
  // means "no change" on update, but on create it simply means "no supervisor".
  @IsOptional()
  @IsString()
  supervisorId?: string;
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

  // Earned days for the employee's gender-linked leave type (Paternity for
  // MALE, Maternity for FEMALE) for the current year — set from Edit Employee.
  @IsOptional()
  @IsInt()
  @Min(0)
  leaveAllocationDays?: number;

  // Same validation as CreateEmployeeDto.supervisorId. An empty string means
  // "clear the current supervisor"; omitting the field entirely means "leave
  // it unchanged" — EmployeesService.update() distinguishes undefined from "".
  @IsOptional()
  @IsString()
  supervisorId?: string;
}
