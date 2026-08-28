import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from "class-validator";

export enum EvaluationRecommendationDto {
  READY_FOR_CONVERSION = "READY_FOR_CONVERSION",
  NOT_YET_READY = "NOT_YET_READY",
  NOT_RECOMMENDED = "NOT_RECOMMENDED",
}

// Every criterion is optional here — a draft can be saved with only some
// fields filled in. SubmitEvaluationDto below re-declares the same fields as
// required for the one moment they actually all need to be present.
export class SaveEvaluationDraftDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  workQuality?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  productivity?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  jobKnowledge?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  workAttitude?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  communication?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  teamwork?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  adaptability?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  overallRating?: number;

  @IsOptional()
  @IsString()
  comments?: string;

  @IsOptional()
  @IsEnum(EvaluationRecommendationDto)
  recommendation?: EvaluationRecommendationDto;
}

export class SubmitEvaluationDto {
  @IsInt()
  @Min(1)
  @Max(5)
  workQuality!: number;

  @IsInt()
  @Min(1)
  @Max(5)
  productivity!: number;

  @IsInt()
  @Min(1)
  @Max(5)
  jobKnowledge!: number;

  @IsInt()
  @Min(1)
  @Max(5)
  workAttitude!: number;

  @IsInt()
  @Min(1)
  @Max(5)
  communication!: number;

  @IsInt()
  @Min(1)
  @Max(5)
  teamwork!: number;

  @IsInt()
  @Min(1)
  @Max(5)
  adaptability!: number;

  @IsInt()
  @Min(1)
  @Max(5)
  overallRating!: number;

  @IsOptional()
  @IsString()
  comments?: string;

  @IsEnum(EvaluationRecommendationDto)
  recommendation!: EvaluationRecommendationDto;
}
