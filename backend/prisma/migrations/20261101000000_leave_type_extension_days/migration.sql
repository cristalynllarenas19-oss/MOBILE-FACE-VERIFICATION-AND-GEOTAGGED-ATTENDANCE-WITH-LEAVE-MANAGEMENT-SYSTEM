-- How many calendar days (without pay) a Maternity-kind leave may be
-- extended by; 0 = no extension. Existing Maternity types keep the 30 days
-- that used to be hard-coded.
ALTER TABLE "leave_types"
  ADD COLUMN IF NOT EXISTS "extension_days" INTEGER NOT NULL DEFAULT 0;

UPDATE "leave_types"
  SET "extension_days" = 30
  WHERE "kind" = 'MATERNITY';
