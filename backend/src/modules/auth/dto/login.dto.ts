import { IsEmail, IsOptional, IsString, MinLength } from "class-validator";

export class LoginDto {
  @IsEmail()
  email!: string;

  // Optional: a brand-new employee has no password yet and logs in with just
  // their email (see AuthService.login). Once they set a password, it's
  // required as normal.
  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;
}
