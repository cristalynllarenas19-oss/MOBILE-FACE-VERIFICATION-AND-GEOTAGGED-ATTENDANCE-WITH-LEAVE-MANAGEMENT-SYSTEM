import { IsEnum, IsOptional, IsString, MaxLength } from "class-validator";

export enum RegularizationDecision {
  APPROVE = "APPROVE",
  REJECT = "REJECT",
}

// The Supervisor's recommendation on a probationary team member.
export class RegularizationDecisionDto {
  @IsEnum(RegularizationDecision)
  decision!: RegularizationDecision;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remarks?: string;
}

// The Admin's Reject — only the optional remark travels with it.
export class RegularizationRemarksDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remarks?: string;
}
