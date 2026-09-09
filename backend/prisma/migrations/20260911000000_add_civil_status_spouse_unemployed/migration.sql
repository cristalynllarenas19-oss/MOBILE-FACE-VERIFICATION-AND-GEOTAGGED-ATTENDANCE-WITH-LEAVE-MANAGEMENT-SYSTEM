-- Re-adds Civil Status (HR reference only, doesn't gate leave eligibility)
-- and adds an explicit "spouse is unemployed" flag alongside the existing
-- spouse_employer_name field.
CREATE TYPE "CivilStatus" AS ENUM ('SINGLE', 'MARRIED', 'WIDOWED', 'SEPARATED', 'ANNULLED');
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "civil_status" "CivilStatus" NOT NULL DEFAULT 'SINGLE';
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "spouse_unemployed" BOOLEAN NOT NULL DEFAULT false;
