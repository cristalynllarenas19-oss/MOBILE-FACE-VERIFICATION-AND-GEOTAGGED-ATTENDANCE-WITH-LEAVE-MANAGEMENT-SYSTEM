import { IsOptional, IsString, MinLength } from "class-validator";

export class ChangePasswordDto {
  // Omitted for a first-time password setup, where the account has no
  // existing password to verify against (see UsersService.changePassword).
  @IsOptional()
  @IsString()
  currentPassword?: string;

  @IsString()
  @MinLength(8)
  newPassword!: string;
}
