-- EmploymentStatus is gaining CONTRACTUAL_SEASONAL/PIECE_RATE and dropping
-- PROBATIONARY (folded into REGULAR) and renaming CONTRACTUAL to
-- CONTRACTUAL_SEASONAL. Postgres can't drop/rename enum values that are
-- still referenced by dependent columns in one step, so we create a new
-- type, migrate both dependent columns (employees.employment_status is a
-- scalar, leave_types.applicable_statuses is an array) with an explicit
-- value remap, then swap the type name.
CREATE TYPE "EmploymentStatus_new" AS ENUM ('REGULAR', 'CONTRACTUAL_SEASONAL', 'PIECE_RATE', 'SEPARATED');

ALTER TABLE "employees" ALTER COLUMN "employment_status" DROP DEFAULT;
ALTER TABLE "employees"
  ALTER COLUMN "employment_status" TYPE "EmploymentStatus_new"
  USING (
    CASE "employment_status"::text
      WHEN 'PROBATIONARY' THEN 'REGULAR'
      WHEN 'CONTRACTUAL' THEN 'CONTRACTUAL_SEASONAL'
      ELSE "employment_status"::text
    END
  )::"EmploymentStatus_new";
ALTER TABLE "employees" ALTER COLUMN "employment_status" SET DEFAULT 'REGULAR'::"EmploymentStatus_new";

-- Postgres disallows a subquery inside an ALTER COLUMN ... USING transform
-- expression (unnest()+SELECT would count as one), so the array remap uses
-- array_replace instead — a plain function call, not a subquery.
ALTER TABLE "leave_types" ALTER COLUMN "applicable_statuses" DROP DEFAULT;
ALTER TABLE "leave_types"
  ALTER COLUMN "applicable_statuses" TYPE "EmploymentStatus_new"[]
  USING (
    array_replace(
      array_replace("applicable_statuses"::text[], 'PROBATIONARY', 'REGULAR'),
      'CONTRACTUAL', 'CONTRACTUAL_SEASONAL'
    )
  )::"EmploymentStatus_new"[];
ALTER TABLE "leave_types" ALTER COLUMN "applicable_statuses" SET DEFAULT ARRAY[]::"EmploymentStatus_new"[];

DROP TYPE "EmploymentStatus";
ALTER TYPE "EmploymentStatus_new" RENAME TO "EmploymentStatus";

-- Solo Parent eligibility, HR-set, defaults to Not Applicable for every
-- existing employee.
CREATE TYPE "SoloParentStatus" AS ENUM ('NOT_APPLICABLE', 'ELIGIBLE', 'INELIGIBLE');
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "solo_parent_status" "SoloParentStatus" NOT NULL DEFAULT 'NOT_APPLICABLE';

-- Leave type configuration additions — all nullable/defaulted so existing
-- rows are unaffected.
ALTER TABLE "leave_types"
  ADD COLUMN IF NOT EXISTS "supporting_document_after_days" INTEGER,
  ADD COLUMN IF NOT EXISTS "requires_hr_validation" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "requires_ehs_activation" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "ehs_activated" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "allow_without_pay" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "is_transferable" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "is_auto_credited" BOOLEAN NOT NULL DEFAULT false;

-- Maternity-extension fields are per-request, not per-type.
ALTER TABLE "leave_requests"
  ADD COLUMN IF NOT EXISTS "extension_requested" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "extension_approved" BOOLEAN;

-- Per-shift break configuration and attendance-rule tuning.
ALTER TABLE "shifts"
  ADD COLUMN IF NOT EXISTS "morning_break_minutes" INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS "afternoon_break_minutes" INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS "lunch_break_minutes" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS "enable_rounding" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "rounding_interval_minutes" INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS "late_threshold_minutes" INTEGER,
  ADD COLUMN IF NOT EXISTS "undertime_threshold_minutes" INTEGER,
  ADD COLUMN IF NOT EXISTS "auto_shift_adjustment" BOOLEAN NOT NULL DEFAULT false;

-- Traceability: which shift template actually applied on a given day
-- (relevant when autoShiftAdjustment matched a different shift than assigned).
ALTER TABLE "attendance_records" ADD COLUMN IF NOT EXISTS "shift_id" TEXT;
ALTER TABLE "attendance_records"
  ADD CONSTRAINT "attendance_records_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
