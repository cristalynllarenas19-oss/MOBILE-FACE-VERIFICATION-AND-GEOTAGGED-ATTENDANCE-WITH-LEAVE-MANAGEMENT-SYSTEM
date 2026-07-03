-- Multi-role accounts (e.g. EMPLOYEE + SUPERVISOR) need a saved preference
-- for which portal they land on right after login. Nullable — existing
-- accounts default to null, and the frontend falls back to today's behavior
-- (non-EMPLOYEE roles land on the admin dashboard) until a preference is set.
DO $$ BEGIN
  CREATE TYPE "DefaultView" AS ENUM ('ADMIN', 'EMPLOYEE');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "default_view" "DefaultView";
