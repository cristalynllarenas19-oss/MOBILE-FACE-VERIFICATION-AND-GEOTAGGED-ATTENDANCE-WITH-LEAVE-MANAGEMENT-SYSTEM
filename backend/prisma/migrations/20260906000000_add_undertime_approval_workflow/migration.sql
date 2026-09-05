-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "UndertimeStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- undertime_filings had 0 rows at the time of this migration, so the new
-- attendance_record_id/cutoff_start/cutoff_end columns can be added as
-- NOT NULL directly with no backfill step.
ALTER TABLE "undertime_filings"
  ADD COLUMN IF NOT EXISTS "attendance_record_id" TEXT NOT NULL,
  ADD COLUMN IF NOT EXISTS "cutoff_start" TIMESTAMP(3) NOT NULL,
  ADD COLUMN IF NOT EXISTS "cutoff_end" TIMESTAMP(3) NOT NULL,
  ADD COLUMN IF NOT EXISTS "status" "UndertimeStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "reviewed_by" TEXT,
  ADD COLUMN IF NOT EXISTS "reviewed_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "remarks" TEXT;

DO $$ BEGIN
  ALTER TABLE "undertime_filings"
    ADD CONSTRAINT "undertime_filings_attendance_record_id_fkey"
    FOREIGN KEY ("attendance_record_id") REFERENCES "attendance_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "undertime_filings"
    ADD CONSTRAINT "undertime_filings_reviewed_by_fkey"
    FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "undertime_filings_employee_id_cutoff_start_key" ON "undertime_filings"("employee_id", "cutoff_start");
CREATE INDEX IF NOT EXISTS "undertime_filings_attendance_record_id_idx" ON "undertime_filings"("attendance_record_id");
