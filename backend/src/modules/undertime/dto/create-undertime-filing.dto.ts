import { IsNotEmpty, IsString } from "class-validator";

export class CreateUndertimeFilingDto {
  @IsString()
  employeeId!: string;

  @IsString()
  attendanceRecordId!: string;

  @IsString()
  @IsNotEmpty({ message: "A reason is required to file undertime." })
  reason!: string;
}
