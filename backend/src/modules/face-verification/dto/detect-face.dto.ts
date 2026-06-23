import { IsString } from "class-validator";

export class DetectFaceDto {
  @IsString()
  imageBase64!: string;
}
