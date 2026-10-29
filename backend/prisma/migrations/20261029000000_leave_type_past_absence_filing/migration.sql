ALTER TABLE "leave_types"
  ADD COLUMN IF NOT EXISTS "past_absence_filing_allowed" BOOLEAN NOT NULL DEFAULT false;

-- Sick Leave may be filed for a past day the employee was absent, not just
-- for today.
UPDATE "leave_types"
  SET "past_absence_filing_allowed" = true
  WHERE "name" = 'Sick Leave';
