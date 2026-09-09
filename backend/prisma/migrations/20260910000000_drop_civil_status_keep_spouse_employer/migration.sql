-- Scope correction: only "does the spouse work at another company" needs
-- recording, not full civil status tracking. Drops both, keeps
-- spouse_employer_name.
ALTER TABLE "employees" DROP COLUMN IF EXISTS "civil_status";
ALTER TABLE "employees" DROP COLUMN IF EXISTS "spouse_name";
DROP TYPE IF EXISTS "CivilStatus";
