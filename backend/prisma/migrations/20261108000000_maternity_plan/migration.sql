-- A Sick/Vacation/Without Pay leave filed together with a Maternity Leave to
-- cover the working days before the delivery date points at that Maternity
-- Leave; the package is reviewed as one (see LeaveService.createMaternityPlan).
ALTER TABLE "leave_requests"
  ADD COLUMN IF NOT EXISTS "maternity_plan_of_id" TEXT;

CREATE INDEX IF NOT EXISTS "leave_requests_maternity_plan_of_id_idx"
  ON "leave_requests" ("maternity_plan_of_id");
