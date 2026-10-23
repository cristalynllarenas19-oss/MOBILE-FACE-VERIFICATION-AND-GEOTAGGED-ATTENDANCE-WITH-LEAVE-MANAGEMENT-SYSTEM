import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString, MaxLength, Min, ValidateNested } from "class-validator";

// Whole file, checked at once by POST /employees/import/validate.
export const MAX_IMPORT_ROWS = 500;
// One POST /employees/import call — admin-web sends the validated rows in
// chunks this size so no single request runs long enough to time out, and
// the admin sees progress between chunks.
export const MAX_IMPORT_ROWS_PER_REQUEST = 25;

// One spreadsheet row exactly as typed — names (department, position,
// employee type) and employee numbers rather than ids. EmployeeImportService
// resolves and validates every field against the database.
export class ImportEmployeeRowDto {
  // The employee's number in the file (1 = first employee; the heading row
  // and blank rows aren't counted), so every error names the employee to fix.
  @IsInt()
  @Min(1)
  rowNumber!: number;

  @IsOptional() @IsString() @MaxLength(100) firstName?: string;
  @IsOptional() @IsString() @MaxLength(100) middleName?: string;
  @IsOptional() @IsString() @MaxLength(100) lastName?: string;
  @IsOptional() @IsString() @MaxLength(254) email?: string;
  @IsOptional() @IsString() @MaxLength(20) sex?: string;
  @IsOptional() @IsString() @MaxLength(150) department?: string;
  @IsOptional() @IsString() @MaxLength(150) position?: string;
  @IsOptional() @IsString() @MaxLength(150) employeeType?: string;
  @IsOptional() @IsString() @MaxLength(30) hireDate?: string;
  @IsOptional() @IsString() @MaxLength(50) supervisorEmployeeNo?: string;
  @IsOptional() @IsString() @MaxLength(30) civilStatus?: string;
  @IsOptional() @IsString() @MaxLength(30) spouseEmployment?: string;
  @IsOptional() @IsString() @MaxLength(200) spouseCompany?: string;
  @IsOptional() @IsString() @MaxLength(50) spouseEmployeeNo?: string;
}

export class ValidateEmployeeImportDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_IMPORT_ROWS)
  @ValidateNested({ each: true })
  @Type(() => ImportEmployeeRowDto)
  rows!: ImportEmployeeRowDto[];
}

export class RunEmployeeImportDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_IMPORT_ROWS_PER_REQUEST)
  @ValidateNested({ each: true })
  @Type(() => ImportEmployeeRowDto)
  rows!: ImportEmployeeRowDto[];
}
