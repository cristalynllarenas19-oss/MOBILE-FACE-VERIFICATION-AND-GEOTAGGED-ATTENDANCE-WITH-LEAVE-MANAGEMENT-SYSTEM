ALTER TABLE "leave_requests"
  ADD COLUMN IF NOT EXISTS "split_from_id" TEXT,
  ADD COLUMN IF NOT EXISTS "split_at" TIMESTAMP(3);
