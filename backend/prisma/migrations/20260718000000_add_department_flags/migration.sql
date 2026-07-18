-- Department management (commit 5f01bdf) added these to the schema but the
-- migration was never created: a soft-delete flag and a per-department
-- restriction on which attendance mode new hires can be given (BOTH = none).

CREATE TYPE "DepartmentAttendanceMode" AS ENUM ('FIXED', 'FIELD', 'BOTH');

ALTER TABLE "departments" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "departments" ADD COLUMN "attendance_mode" "DepartmentAttendanceMode" NOT NULL DEFAULT 'BOTH';
