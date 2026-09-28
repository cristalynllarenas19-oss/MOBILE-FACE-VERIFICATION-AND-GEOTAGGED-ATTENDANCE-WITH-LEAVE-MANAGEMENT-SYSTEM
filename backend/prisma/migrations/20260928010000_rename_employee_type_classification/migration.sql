-- Employee Types have no separate "classification" concept: the column just
-- stores the existing Employment Status each type's employees get. Rename it
-- to say so. Data is unchanged. Safe to re-run.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'employee_types' AND column_name = 'classification'
  ) THEN
    ALTER TABLE "employee_types" RENAME COLUMN "classification" TO "employment_status";
  END IF;
END $$;
