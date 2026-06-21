-- Create join table for multiple employees per work location
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS "employees" (
  "id" TEXT NOT NULL,
  CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "work_locations" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "latitude" DECIMAL NOT NULL,
  "longitude" DECIMAL NOT NULL,
  "radius_meters" DECIMAL NOT NULL,
  "allowed_accuracy_meters" DECIMAL NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT TRUE,
  "employee_id" TEXT,

  CONSTRAINT "work_locations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "work_location_employees" (
  "id" TEXT NOT NULL,
  "work_location_id" TEXT NOT NULL,
  "employee_id" TEXT NOT NULL,

  CONSTRAINT "work_location_employees_pkey" PRIMARY KEY ("id")
);

-- Migrate existing single-employee assignments into the join table
INSERT INTO "work_location_employees" ("id", "work_location_id", "employee_id")
SELECT gen_random_uuid()::text, "id", "employee_id"
FROM "work_locations"
WHERE "employee_id" IS NOT NULL;

-- Make sure an employee can only be assigned to one area at a time
CREATE UNIQUE INDEX "work_location_employees_employee_id_key"
  ON "work_location_employees" ("employee_id");

CREATE UNIQUE INDEX "work_location_employees_work_location_id_employee_id_key"
  ON "work_location_employees" ("work_location_id", "employee_id");

CREATE INDEX "work_location_employees_work_location_id_idx"
  ON "work_location_employees" ("work_location_id");

ALTER TABLE "work_location_employees"
  ADD CONSTRAINT "work_location_employees_work_location_id_fkey"
  FOREIGN KEY ("work_location_id") REFERENCES "work_locations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "work_location_employees"
  ADD CONSTRAINT "work_location_employees_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Remove the old single-employee relation
DROP INDEX IF EXISTS "work_locations_employee_id_key";
DROP INDEX IF EXISTS "work_locations_employee_id_idx";

ALTER TABLE "work_locations" DROP CONSTRAINT IF EXISTS "work_locations_employee_id_fkey";
ALTER TABLE "work_locations" DROP COLUMN IF EXISTS "employee_id";
