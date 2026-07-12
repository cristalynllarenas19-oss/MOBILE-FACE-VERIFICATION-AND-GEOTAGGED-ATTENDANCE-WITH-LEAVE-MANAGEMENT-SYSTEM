import { Transform } from "class-transformer";
import { IsEmail, IsString, Length } from "class-validator";

export class VerifyResetOtpDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim().toLowerCase() : value))
  @IsEmail()
  email!: string;

  @IsString()
  @Length(6, 6)
  otp!: string;
}
