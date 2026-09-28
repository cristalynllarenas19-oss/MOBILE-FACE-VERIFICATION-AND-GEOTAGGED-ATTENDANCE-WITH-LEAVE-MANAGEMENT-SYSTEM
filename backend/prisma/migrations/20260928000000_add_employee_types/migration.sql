-- Employee Types become admin-managed data (Utilities → Employee Types)
-- instead of a hardcoded frontend list. Each type maps to one existing
-- EmploymentStatus classification, which keeps driving every business rule
-- (probation, leave eligibility, seasonal accrual); employment_status itself
-- is untouched and stays the rule field. Idempotent so it's safe to re-run.

CREATE TABLE IF NOT EXISTS "employee_types" (
  "id"             TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "description"    TEXT,
  "classification" "EmploymentStatus" NOT NULL,
  "is_active"      BOOLEAN NOT NULL DEFAULT true,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archived_at"    TIMESTAMP(3),
  CONSTRAINT "employee_types_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "employee_types_name_key" ON "employee_types"("name");

-- The four initial types — exactly the options the old hardcoded dropdown offered.
INSERT INTO "employee_types" ("id", "name", "classification") VALUES
  (gen_random_uuid()::text, 'Regular Employee',               'REGULAR'),
  (gen_random_uuid()::text, 'Probationary Employee',          'PROBATIONARY'),
  (gen_random_uuid()::text, 'Permanent Seasonal Employee',    'PERMANENT_SEASONAL'),
  (gen_random_uuid()::text, 'Probationary Seasonal Employee', 'PROBATIONARY_SEASONAL')
ON CONFLICT ("name") DO NOTHING;

ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "employee_type_id" TEXT;

-- Active employees: the type matching their current classification.
UPDATE "employees" e
SET "employee_type_id" = t."id"
FROM "employee_types" t
WHERE e."employee_type_id" IS NULL
  AND e."employment_status" <> 'SEPARATED'
  AND t."classification" = e."employment_status"
  AND t."name" IN ('Regular Employee', 'Probationary Employee', 'Permanent Seasonal Employee', 'Probationary Seasonal Employee');

-- Archived (SEPARATED) employees: recover what they were right before
-- archiving from their latest ARCHIVE_EMPLOYEE audit entry.
UPDATE "employees" e
SET "employee_type_id" = t."id"
FROM (
  SELECT DISTINCT ON ("entity_id") "entity_id", "old_values"->>'employmentStatus' AS "previous_status"
  FROM "audit_logs"
  WHERE "action" = 'ARCHIVE_EMPLOYEE' AND "entity_type" = 'Employee'
  ORDER BY "entity_id", "created_at" DESC
) a
JOIN "employee_types" t ON t."classification"::text = a."previous_status"
WHERE e."employee_type_id" IS NULL
  AND e."id" = a."entity_id"
  AND t."name" IN ('Regular Employee', 'Probationary Employee', 'Permanent Seasonal Employee', 'Probationary Seasonal Employee');

-- Anything still unresolved (archived with no usable audit trail) falls back
-- to Regular Employee — the same thing Restore Employee has always reset them to.
UPDATE "employees"
SET "employee_type_id" = (SELECT "id" FROM "employee_types" WHERE "name" = 'Regular Employee')
WHERE "employee_type_id" IS NULL;

ALTER TABLE "employees" ALTER COLUMN "employee_type_id" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employees_employee_type_id_fkey') THEN
    ALTER TABLE "employees"
      ADD CONSTRAINT "employees_employee_type_id_fkey"
      FOREIGN KEY ("employee_type_id") REFERENCES "employee_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "employees_employee_type_id_idx" ON "employees"("employee_type_id");

-- Admin-only write permission for Utilities → Employee Types.
INSERT INTO "permissions" ("id", "code", "module")
VALUES (gen_random_uuid()::text, 'employee-types:write', 'Employee Types')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r, "permissions" p
WHERE r."code" = 'ADMIN' AND p."code" = 'employee-types:write'
ON CONFLICT DO NOTHING;
