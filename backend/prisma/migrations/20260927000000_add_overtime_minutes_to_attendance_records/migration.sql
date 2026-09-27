-- Overtime was never tracked at all (no column, no calculation). Adds the
-- computed counterpart to undertime_minutes: minutes clocked out past the
-- resolved shift's scheduled end time. No approval workflow, unlike
-- undertime_filings — visibility only, backfilled to 0 for existing rows.
ALTER TABLE "attendance_records"
  ADD COLUMN IF NOT EXISTS "overtime_minutes" INTEGER NOT NULL DEFAULT 0;
