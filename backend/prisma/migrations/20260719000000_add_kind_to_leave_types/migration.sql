-- Leave Types are now fully HR/Admin-managed (created/renamed/deleted via
-- Utilities -> Leave Types) instead of hardcoded in prisma/seed.ts. The
-- sex-eligibility, auto-enrollment-on-hire, and maternity-extension logic
-- that used to string-match on the exact name "Maternity Leave" / "Paternity
-- Leave" now keys off this stable `kind` field instead, so HR can freely
-- rename a leave type without breaking that behavior.

CREATE TYPE "LeaveTypeKind" AS ENUM ('GENERAL', 'MATERNITY', 'PATERNITY');

ALTER TABLE "leave_types" ADD COLUMN "kind" "LeaveTypeKind" NOT NULL DEFAULT 'GENERAL';
