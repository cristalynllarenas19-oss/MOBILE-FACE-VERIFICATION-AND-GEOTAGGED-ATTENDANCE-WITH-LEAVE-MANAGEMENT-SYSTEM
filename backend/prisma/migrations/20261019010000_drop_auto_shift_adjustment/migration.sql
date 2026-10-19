-- Auto Shift Adjustment was removed: a late Time In is now always graded
-- against the employee's assigned shift, never re-matched to another one.
ALTER TABLE "shifts" DROP COLUMN IF EXISTS "auto_shift_adjustment";
