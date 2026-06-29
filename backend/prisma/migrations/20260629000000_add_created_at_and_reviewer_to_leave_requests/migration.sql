-- Leave History needs a "date filed" column, which leave_requests never tracked
-- (only the leave period start/end and the review timestamp). Existing rows get
-- backfilled to this migration's run time since their real filing date can't be
-- recovered; everything filed from here on is tracked accurately.
ALTER TABLE "leave_requests"
  ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMP(3) NOT NULL DEFAULT now();

-- reviewed_by has existed since the original table but was never actually written
-- by the approve/reject flow, so every row's value is NULL today. Adding the FK
-- now (safe because of that) lets the API join through to the reviewer's name.
ALTER TABLE "leave_requests"
  ADD CONSTRAINT "leave_requests_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
