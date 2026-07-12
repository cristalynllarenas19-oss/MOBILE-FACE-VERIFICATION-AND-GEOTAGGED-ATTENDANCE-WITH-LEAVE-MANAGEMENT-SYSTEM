-- Set once the overdue-review sweep has escalated this request to HR/Admin
-- (its leave dates started while still PENDING/SUPERVISOR_APPROVED), so the
-- hourly sweep never notifies twice for the same request.

ALTER TABLE "leave_requests" ADD COLUMN "escalated_at" TIMESTAMP(3);
