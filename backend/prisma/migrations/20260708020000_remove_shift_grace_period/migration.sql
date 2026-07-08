UPDATE "shifts"
SET
  "late_threshold_minutes" = COALESCE("late_threshold_minutes", 0),
  "undertime_threshold_minutes" = COALESCE("undertime_threshold_minutes", 0);

ALTER TABLE "shifts"
  ALTER COLUMN "late_threshold_minutes" SET DEFAULT 0,
  ALTER COLUMN "late_threshold_minutes" SET NOT NULL,
  ALTER COLUMN "undertime_threshold_minutes" SET DEFAULT 0,
  ALTER COLUMN "undertime_threshold_minutes" SET NOT NULL,
  DROP COLUMN IF EXISTS "grace_period_minutes";
