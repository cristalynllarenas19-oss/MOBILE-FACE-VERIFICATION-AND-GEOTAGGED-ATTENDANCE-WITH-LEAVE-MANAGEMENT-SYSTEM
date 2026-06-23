import { IsArray, IsString } from "class-validator";

export class UpsertFaceProfileDto {
  @IsString()
  employeeId!: string;

  @IsString()
  referenceImageData!: string;

  @IsArray()
  descriptors!: number[][];
}
