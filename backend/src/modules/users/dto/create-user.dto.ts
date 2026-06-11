import { IsEmail, IsEnum, IsString, MinLength } from "class-validator";

export enum CreateUserRole {
  ADMIN = "ADMIN",
  SUPERVISOR = "SUPERVISOR",
  EMPLOYEE = "EMPLOYEE",
}

export class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsEnum(CreateUserRole)
  role!: CreateUserRole;
}
