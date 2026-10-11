-- The "still awaiting a decision" reminder is now delivered to each reviewer
-- during their own shift, so one request's reviewers can receive it at
-- different times. This records who has already been reminded.
ALTER TABLE "leave_requests"
  ADD COLUMN IF NOT EXISTS "overdue_notified_user_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
