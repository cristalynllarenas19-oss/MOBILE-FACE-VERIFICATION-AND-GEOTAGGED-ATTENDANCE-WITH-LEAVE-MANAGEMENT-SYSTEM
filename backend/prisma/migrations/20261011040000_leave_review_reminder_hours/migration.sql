-- How long after a leave request is filed its reviewers are reminded that it
-- is still awaiting a decision. One system-wide default, with an optional
-- shorter (or longer) override per leave type.
ALTER TABLE "leave_settings"
  ADD COLUMN IF NOT EXISTS "review_reminder_hours" INTEGER NOT NULL DEFAULT 24;

ALTER TABLE "leave_types"
  ADD COLUMN IF NOT EXISTS "review_reminder_hours" INTEGER;

-- Leaves that are filed without notice (the employee is already out, or
-- about to be) can't wait a full day for the reviewer to be nudged.
UPDATE "leave_types"
SET "review_reminder_hours" = 1
WHERE "review_reminder_hours" IS NULL
  AND lower("name") IN ('emergency leave', 'sick leave', 'leave without pay', 'adverse weather leave');
