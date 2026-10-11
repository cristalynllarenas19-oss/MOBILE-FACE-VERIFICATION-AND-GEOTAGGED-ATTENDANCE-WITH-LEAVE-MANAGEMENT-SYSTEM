-- When the current wait for a reviewer's decision began: null means "when
-- the request was filed"; set to the resubmission time each time the
-- employee resubmits, so the "still awaiting a decision" reminder is timed
-- from that point instead.
ALTER TABLE "leave_requests"
  ADD COLUMN IF NOT EXISTS "review_clock_started_at" TIMESTAMP(3);
