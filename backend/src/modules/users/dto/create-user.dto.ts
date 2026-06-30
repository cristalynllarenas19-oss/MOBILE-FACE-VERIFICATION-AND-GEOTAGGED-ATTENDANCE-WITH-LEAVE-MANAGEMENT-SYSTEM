import { IsDateString, IsEmail, IsEnum, IsOptional, IsString, IsUUID, MinLength } from "class-validator";

export enum CreateUserRole {
  ADMIN = "ADMIN",
  SUPERVISOR = "SUPERVISOR",
  EMPLOYEE = "EMPLOYEE",
}

export class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @IsString()
  firstName!: string;

  @IsString()
  lastName!: string;

  @IsOptional()
  @IsString()
  employeeNo?: string;

  @IsOptional()
  @IsDateString()
  hireDate?: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsEnum(CreateUserRole)
  role!: CreateUserRole;
}
