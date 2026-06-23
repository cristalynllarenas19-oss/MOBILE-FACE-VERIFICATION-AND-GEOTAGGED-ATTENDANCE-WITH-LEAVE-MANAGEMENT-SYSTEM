import { IsEmail, IsOptional, IsString } from "class-validator";

export class UpdateMeDto {
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
  contactNumber?: string;

  @IsOptional()
  @IsString()
  profilePhotoData?: string;

  @IsOptional()
  @IsString()
  profilePhotoMimeType?: string;
}
