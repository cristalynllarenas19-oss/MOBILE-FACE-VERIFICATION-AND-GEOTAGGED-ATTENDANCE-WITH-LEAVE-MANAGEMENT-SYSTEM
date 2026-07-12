import { Transform } from "class-transformer";
import { IsEmail, IsOptional, IsString, MinLength } from "class-validator";

export class LoginDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim().toLowerCase() : value))
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
