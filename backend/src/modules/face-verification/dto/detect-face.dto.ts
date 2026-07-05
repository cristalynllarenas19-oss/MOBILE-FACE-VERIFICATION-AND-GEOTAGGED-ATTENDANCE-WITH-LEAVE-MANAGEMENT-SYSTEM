import { IsBoolean, IsOptional, IsString } from "class-validator";

export class DetectFaceDto {
  @IsString()
  imageBase64!: string;

  // Requests a larger detector input size and the full (non-tiny) landmark
  // model for sharper eye landmarks, at the cost of extra latency — the
  // client only sets this while actively sampling for a blink, not during
  // the cheaper face-tracking poll.
  @IsOptional()
  @IsBoolean()
  precise?: boolean;
}
