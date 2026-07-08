-- Classifies a WorkLocation itself as an Office or a Field site, reusing the
-- existing AttendanceRecordType enum. A FIELD employee's visit is now
-- auto-tagged with the visited area's own type instead of always "FIELD" —
-- see attendance.service.ts.
ALTER TABLE "work_locations"
  ADD COLUMN IF NOT EXISTS "type" "AttendanceRecordType" NOT NULL DEFAULT 'OFFICE';
