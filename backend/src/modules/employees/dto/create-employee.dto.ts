import { Transform } from "class-transformer";
import { IsBoolean, IsDateString, IsEmail, IsEnum, IsInt, IsOptional, IsString, Min } from "class-validator";

export enum CreateEmployeeEmploymentStatus {
  REGULAR = "REGULAR",
  PROBATIONARY = "PROBATIONARY",
  PERMANENT_SEASONAL = "PERMANENT_SEASONAL",
  PROBATIONARY_SEASONAL = "PROBATIONARY_SEASONAL",
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

export enum EmployeeCivilStatus {
  SINGLE = "SINGLE",
  MARRIED = "MARRIED",
  WIDOWED = "WIDOWED",
  SEPARATED = "SEPARATED",
  ANNULLED = "ANNULLED",
}

export class CreateEmployeeDto {
  @IsString()
  firstName!: string;

  @IsString()
  lastName!: string;

  @Transform(({ value }) => (typeof value === "string" ? value.trim().toLowerCase() : value))
  @IsEmail()
  email!: string;

  @IsString()
  department!: string;

  // Id of a position offered in that department (Utilities → Positions) —
  // validated in EmployeesService.create. Omitted only by older mobile
  // builds, which fall back to the generic "Employee" position.
  @IsOptional()
  @IsString()
  positionId?: string;

  @IsOptional()
  @IsDateString()
  hireDate?: string;

  // Id of an active row from Utilities → Employee Types. The employee's
  // employmentStatus (the business-rule field) is derived from that type's
  // Employment Status in EmployeesService — never submitted directly anymore.
  @IsOptional()
  @IsString()
  employeeTypeId?: string;

  // Legacy alternative to employeeTypeId, still accepted from older mobile
  // builds — resolved to the default type for that Employment Status. One of
  // the two is required (checked in EmployeesService.create).
  @IsOptional()
  @IsEnum(CreateEmployeeEmploymentStatus)
  employmentStatus?: CreateEmployeeEmploymentStatus;

  // Validity is a DB-existence/availability check in EmployeesService, not a
  // compiled enum — the department's own configured mode may also override
  // whatever is submitted here (see EmployeesService.resolveAttendanceMode).
  @IsOptional()
  @IsString()
  attendanceMode?: string;

  @IsEnum(CreateEmployeeSex)
  sex!: CreateEmployeeSex;

  @IsOptional()
  @IsEnum(EmployeeSoloParentStatus)
  soloParentStatus?: EmployeeSoloParentStatus;

  @IsOptional()
  @IsEnum(EmployeeCivilStatus)
  civilStatus?: EmployeeCivilStatus;

  // Set only when the employee's spouse works at another company; blank
  // means not applicable/unknown. Mutually exclusive with spouseUnemployed
  // in the admin-web form, not enforced here.
  @IsOptional()
  @IsString()
  spouseEmployerName?: string;

  @IsOptional()
  @IsBoolean()
  spouseUnemployed?: boolean;

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
  @Transform(({ value }) => (typeof value === "string" ? value.trim().toLowerCase() : value))
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  department?: string;

  // Legacy free-text title; admin-web now sends positionId instead.
  @IsOptional()
  @IsString()
  position?: string;

  // See CreateEmployeeDto.positionId — validated against the department.
  @IsOptional()
  @IsString()
  positionId?: string;

  @IsOptional()
  @IsDateString()
  hireDate?: string;

  // See CreateEmployeeDto.employeeTypeId / employmentStatus. employmentStatus
  // here is also what Approve Regularization (EvaluationViewModal) sends.
  @IsOptional()
  @IsString()
  employeeTypeId?: string;

  @IsOptional()
  @IsEnum(CreateEmployeeEmploymentStatus)
  employmentStatus?: CreateEmployeeEmploymentStatus;

  @IsOptional()
  @IsString()
  attendanceMode?: string;

  @IsOptional()
  @IsEnum(EmployeeSoloParentStatus)
  soloParentStatus?: EmployeeSoloParentStatus;

  @IsOptional()
  @IsEnum(EmployeeCivilStatus)
  civilStatus?: EmployeeCivilStatus;

  // Set only when the employee's spouse works at another company; blank
  // means not applicable/unknown. Mutually exclusive with spouseUnemployed
  // in the admin-web form, not enforced here.
  @IsOptional()
  @IsString()
  spouseEmployerName?: string;

  @IsOptional()
  @IsBoolean()
  spouseUnemployed?: boolean;

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
