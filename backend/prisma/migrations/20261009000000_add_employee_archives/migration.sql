-- One row per time an employee is archived (Employee Management → Archive).
-- The employee's own row never leaves `employees` — only EmployeeArchive
-- records the archive/restore history. Safe to re-run.
CREATE TABLE IF NOT EXISTS "employee_archives" (
  "id"                 TEXT NOT NULL,
  "employee_id"        TEXT NOT NULL,
  "archive_type"       TEXT NOT NULL,
  "reason"             TEXT,
  "effective_date"     TIMESTAMP(3),
  "archived_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archived_by_user_id" TEXT,
  "restored_at"        TIMESTAMP(3),
  "restored_by_user_id" TEXT,
  CONSTRAINT "employee_archives_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "employee_archives_employee_id_idx" ON "employee_archives"("employee_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employee_archives_employee_id_fkey') THEN
    ALTER TABLE "employee_archives"
      ADD CONSTRAINT "employee_archives_employee_id_fkey"
      FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
