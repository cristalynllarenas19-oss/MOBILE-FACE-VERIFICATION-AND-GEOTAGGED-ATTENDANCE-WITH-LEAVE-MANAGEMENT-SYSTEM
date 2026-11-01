import { Type } from "class-transformer";
import { IsIn, IsNumber, IsPositive, IsString, ValidateNested } from "class-validator";

export class CreateLivenessSessionDto {
  @IsString()
  employeeId!: string;
}

export class SubmitLivenessFrameDto {
  @IsIn(["closed", "open", "right", "final"])
  kind!: string;

  @IsString()
  image!: string;
}

class FaceBoxDto {
  @IsNumber()
  x!: number;

  @IsNumber()
  y!: number;

  @IsPositive()
  width!: number;

  @IsPositive()
  height!: number;
}

export class LiveCheckDto {
  @IsString()
  image!: string;

  @ValidateNested()
  @Type(() => FaceBoxDto)
  box!: FaceBoxDto;
}
