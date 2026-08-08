import { IsOptional, IsString } from "class-validator";

export class CreateUndertimeFilingDto {
  @IsString()
  employeeId!: string;

  @IsOptional()
  @IsString()
  reason?: string;
}
