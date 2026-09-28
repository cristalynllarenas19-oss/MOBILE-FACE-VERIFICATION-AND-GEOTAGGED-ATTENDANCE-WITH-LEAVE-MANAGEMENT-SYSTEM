-- Positions become admin-managed per department (Utilities → Positions):
-- each position is offered in ALL departments, ALL_EXCEPT the listed ones,
-- or ONLY the listed ones. Employees keep whatever position they have.
-- Safe to re-run.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PositionDepartmentScope') THEN
    CREATE TYPE "PositionDepartmentScope" AS ENUM ('ALL', 'ALL_EXCEPT', 'ONLY');
  END IF;
END $$;

ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "is_active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "department_scope" "PositionDepartmentScope" NOT NULL DEFAULT 'ONLY';
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS "position_departments" (
  "position_id"   TEXT NOT NULL,
  "department_id" TEXT NOT NULL,
  CONSTRAINT "position_departments_pkey" PRIMARY KEY ("position_id", "department_id"),
  CONSTRAINT "position_departments_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "position_departments_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "position_departments_department_id_idx" ON "position_departments"("department_id");

-- The old free-text positions stay on the employees who have them, but are
-- archived so they aren't offered in the new department-based dropdown.
UPDATE "positions" SET "is_active" = false
WHERE "title" NOT IN ('Senior Manager', 'Manager I', 'Manager II', 'Manager Trainee', 'HR Manager I', 'HR Manager II', 'HR Director');

-- The initial positions (one row each, shared across departments).
INSERT INTO "positions" ("id", "title", "department_scope")
SELECT gen_random_uuid()::text, v.title, v.scope::"PositionDepartmentScope"
FROM (VALUES
  ('Senior Manager',  'ALL'),
  ('Manager I',       'ALL_EXCEPT'),
  ('Manager II',      'ALL_EXCEPT'),
  ('Manager Trainee', 'ONLY'),
  ('HR Manager I',    'ONLY'),
  ('HR Manager II',   'ONLY'),
  ('HR Director',     'ONLY')
) AS v(title, scope)
WHERE NOT EXISTS (SELECT 1 FROM "positions" p WHERE p."title" = v.title);

-- Manager I/II: every department except Human Resources.
-- HR-only positions: Human Resources only.
INSERT INTO "position_departments" ("position_id", "department_id")
SELECT p."id", d."id"
FROM "positions" p, "departments" d
WHERE d."name" = 'Human Resources'
  AND p."title" IN ('Manager I', 'Manager II', 'Manager Trainee', 'HR Manager I', 'HR Manager II', 'HR Director')
ON CONFLICT DO NOTHING;
