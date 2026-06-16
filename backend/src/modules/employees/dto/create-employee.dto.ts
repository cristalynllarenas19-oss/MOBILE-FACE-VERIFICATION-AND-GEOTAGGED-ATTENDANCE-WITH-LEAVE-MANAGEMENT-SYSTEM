import { IsDateString, IsEmail, IsEnum, IsOptional, IsString, MinLength } from "class-validator";

export enum CreateEmployeeEmploymentStatus {
  REGULAR = "REGULAR",
  PROBATIONARY = "PROBATIONARY",
  CONTRACTUAL = "CONTRACTUAL",
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

  @IsString()
  position!: string;

  @IsOptional()
  @IsDateString()
  hireDate?: string;

  @IsEnum(CreateEmployeeEmploymentStatus)
  employmentStatus!: CreateEmployeeEmploymentStatus;
}
