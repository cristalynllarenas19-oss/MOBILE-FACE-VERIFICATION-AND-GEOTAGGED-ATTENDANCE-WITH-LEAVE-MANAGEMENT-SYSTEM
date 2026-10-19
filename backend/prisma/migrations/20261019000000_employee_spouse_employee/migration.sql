-- The employee's spouse, when the spouse is also a ULPI employee. Nulled out
-- (not cascaded) if that spouse's employee row is ever deleted.
ALTER TABLE "employees"
  ADD COLUMN IF NOT EXISTS "spouse_employee_id" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employees_spouse_employee_id_fkey') THEN
    ALTER TABLE "employees"
      ADD CONSTRAINT "employees_spouse_employee_id_fkey"
      FOREIGN KEY ("spouse_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
