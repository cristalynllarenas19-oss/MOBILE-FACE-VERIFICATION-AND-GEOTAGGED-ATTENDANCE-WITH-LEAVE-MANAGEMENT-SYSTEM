-- OFFICIAL_BUSINESS was never reachable from any screen and no record ever
-- used it. Postgres can't drop a single enum value, so the type is rebuilt
-- without it. Skipped entirely if the value is already gone.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'AttendanceStatus' AND e.enumlabel = 'OFFICIAL_BUSINESS'
  ) THEN
    IF EXISTS (SELECT 1 FROM "attendance_records" WHERE "status"::text = 'OFFICIAL_BUSINESS') THEN
      RAISE EXCEPTION 'attendance_records still has OFFICIAL_BUSINESS rows — reassign them before removing the status';
    END IF;

    ALTER TYPE "AttendanceStatus" RENAME TO "AttendanceStatus_old";
    CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'LATE', 'ABSENT', 'ON_LEAVE', 'PENDING_REVIEW', 'FLAGGED');
    ALTER TABLE "attendance_records" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "attendance_records"
      ALTER COLUMN "status" TYPE "AttendanceStatus" USING ("status"::text::"AttendanceStatus");
    ALTER TABLE "attendance_records" ALTER COLUMN "status" SET DEFAULT 'PENDING_REVIEW';
    DROP TYPE "AttendanceStatus_old";
  END IF;
END $$;
