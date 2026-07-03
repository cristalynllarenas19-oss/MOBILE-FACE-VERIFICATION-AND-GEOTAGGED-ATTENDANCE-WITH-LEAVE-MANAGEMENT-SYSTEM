import { IsIn } from "class-validator";

export class UpdateDefaultViewDto {
  @IsIn(["ADMIN", "EMPLOYEE"])
  defaultView!: "ADMIN" | "EMPLOYEE";
}
