import { IsEnum, IsUUID } from "class-validator";

export enum CreateUserRole {
  ADMIN = "ADMIN",
  SUPERVISOR = "SUPERVISOR",
  EMPLOYEE = "EMPLOYEE",
}

// User Management only ever assigns a role to an employee who already has an
// account (created in Employee Management) — it never creates a new account
// or new credentials, so this is intentionally just an employeeId + role.
export class CreateUserDto {
  @IsUUID()
  employeeId!: string;

  @IsEnum(CreateUserRole)
  role!: CreateUserRole;
}
