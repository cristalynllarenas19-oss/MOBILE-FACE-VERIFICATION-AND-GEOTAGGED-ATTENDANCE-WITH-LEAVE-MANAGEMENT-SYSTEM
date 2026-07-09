-- Employees have never tracked when they were added, so the employee table
-- could only ever be sorted alphabetically. Existing rows are backfilled to
-- this migration's run time since their real hire-entry date can't be
-- recovered; everything added from here on sorts newest-first (LIFO).
ALTER TABLE "employees"
  ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMP(3) NOT NULL DEFAULT now();
