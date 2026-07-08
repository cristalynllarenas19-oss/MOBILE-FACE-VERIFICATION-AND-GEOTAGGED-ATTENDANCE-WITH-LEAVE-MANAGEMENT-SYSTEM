-- Adds optional lunch break time in/out tracking to attendance_records, and
-- the matching AttendanceLogType values for the per-scan verification log.

ALTER TABLE "attendance_records" ADD COLUMN "lunch_out_at" TIMESTAMP(3);
ALTER TABLE "attendance_records" ADD COLUMN "lunch_in_at" TIMESTAMP(3);

ALTER TYPE "AttendanceLogType" ADD VALUE 'LUNCH_OUT';
ALTER TYPE "AttendanceLogType" ADD VALUE 'LUNCH_IN';
