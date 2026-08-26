ALTER TYPE "LeaveStatus" ADD VALUE IF NOT EXISTS 'CANCELLATION_PENDING';

ALTER TABLE "leave_requests"
  ADD COLUMN IF NOT EXISTS "pre_cancellation_status" "LeaveStatus";
