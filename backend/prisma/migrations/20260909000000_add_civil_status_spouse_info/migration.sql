-- Civil status + spouse info, HR reference only (does not gate leave
-- eligibility). Defaults every existing employee to SINGLE.
CREATE TYPE "CivilStatus" AS ENUM ('SINGLE', 'MARRIED', 'WIDOWED', 'SEPARATED', 'ANNULLED');
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "civil_status" "CivilStatus" NOT NULL DEFAULT 'SINGLE';
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "spouse_name" TEXT;
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "spouse_employer_name" TEXT;
