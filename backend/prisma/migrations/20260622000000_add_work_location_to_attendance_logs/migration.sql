-- Record which geotagged work location was checked against for each attendance attempt
ALTER TABLE "attendance_logs"
  ADD COLUMN IF NOT EXISTS "work_location_id" TEXT;

CREATE INDEX IF NOT EXISTS "attendance_logs_work_location_id_idx"
  ON "attendance_logs" ("work_location_id");

ALTER TABLE "attendance_logs"
  DROP CONSTRAINT IF EXISTS "attendance_logs_work_location_id_fkey";

ALTER TABLE "attendance_logs"
  ADD CONSTRAINT "attendance_logs_work_location_id_fkey"
  FOREIGN KEY ("work_location_id") REFERENCES "work_locations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
