import { IsString } from "class-validator";

export class MatchFaceDto {
  @IsString()
  imageBase64!: string;
}
