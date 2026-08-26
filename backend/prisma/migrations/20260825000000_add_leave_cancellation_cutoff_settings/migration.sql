ALTER TABLE "leave_types"
  ADD COLUMN IF NOT EXISTS "cancellation_allowed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "cancellation_cutoff_value" INTEGER,
  ADD COLUMN IF NOT EXISTS "cancellation_cutoff_unit" TEXT;

ALTER TABLE "leave_types"
  ALTER COLUMN "cancellation_allowed" SET DEFAULT false,
  ALTER COLUMN "cancellation_cutoff_unit" DROP DEFAULT;

UPDATE "leave_types"
  SET
    "cancellation_allowed" = false,
    "cancellation_cutoff_value" = NULL,
    "cancellation_cutoff_unit" = NULL;

UPDATE "leave_types"
  SET
    "cancellation_allowed" = false,
    "cancellation_cutoff_value" = NULL,
    "cancellation_cutoff_unit" = NULL
  WHERE "name" IN ('Sick Leave', 'Emergency Leave', 'Maternity Leave', 'Paternity Leave', 'Added Paternity Leave');
