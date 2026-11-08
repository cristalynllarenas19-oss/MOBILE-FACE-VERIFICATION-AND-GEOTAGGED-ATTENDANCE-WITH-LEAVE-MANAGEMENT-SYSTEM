import { IsDateString, IsString } from "class-validator";
import { CreateLeaveRequestDto } from "./create-leave-request.dto";

// Maternity Leave filed ahead: startDate is the (expected) delivery date,
// and every working day after lastWorkDate and before it is covered by Sick
// Leave, Vacation Leave or Leave Without Pay (see LeaveService.createMaternityPlan).
export class CreateMaternityPlanDto extends CreateLeaveRequestDto {
  @IsDateString()
  lastWorkDate!: string;
}

// The same plan, only worked out — shown on the form before she submits.
export class PreviewMaternityPlanDto {
  @IsString()
  employeeId!: string;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  lastWorkDate!: string;
}
