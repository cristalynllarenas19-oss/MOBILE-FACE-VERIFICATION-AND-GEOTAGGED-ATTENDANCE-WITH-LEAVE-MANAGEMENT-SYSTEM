import { IsString } from "class-validator";

// The photo and face signature are no longer sent by the browser: they come
// from the server-verified liveness session (see registration-liveness.service.ts).
export class UpsertFaceProfileDto {
  @IsString()
  employeeId!: string;

  @IsString()
  livenessSessionId!: string;
}
