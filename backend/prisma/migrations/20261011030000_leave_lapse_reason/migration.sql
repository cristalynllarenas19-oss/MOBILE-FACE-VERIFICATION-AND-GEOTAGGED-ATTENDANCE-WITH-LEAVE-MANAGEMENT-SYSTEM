-- Why a LAPSED leave request lapsed: 'REPORTED_FOR_WORK' (the employee
-- worked every requested day) or 'NOT_DECIDED' (nobody decided in time, so
-- the days stand as absences). Null for every other status.
ALTER TABLE "leave_requests"
  ADD COLUMN IF NOT EXISTS "lapse_reason" TEXT;
