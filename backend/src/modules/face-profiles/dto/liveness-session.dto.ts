import { IsIn, IsString } from "class-validator";

export class CreateLivenessSessionDto {
  @IsString()
  employeeId!: string;
}

export class SubmitLivenessFrameDto {
  @IsIn(["straight", "closed", "open", "left", "right", "final"])
  kind!: string;

  @IsString()
  image!: string;
}
