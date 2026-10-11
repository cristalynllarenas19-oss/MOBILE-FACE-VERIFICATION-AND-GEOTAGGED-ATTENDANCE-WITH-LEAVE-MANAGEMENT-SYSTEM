-- A leave request that is never decided no longer stays pending forever: it
-- becomes LAPSED once its dates have passed (see LeaveLapseService).
ALTER TYPE "LeaveStatus" ADD VALUE IF NOT EXISTS 'LAPSED';

-- When the "decision overdue" reminder was sent for a request, so the
-- recurring check sends it only once.
ALTER TABLE "leave_requests"
  ADD COLUMN IF NOT EXISTS "overdue_notified_at" TIMESTAMP(3);

-- Single-row config (id is always 'singleton'), same pattern as
-- undertime_settings: how many days after a leave's end date an undecided
-- request is given before it lapses.
CREATE TABLE IF NOT EXISTS "leave_settings" (
  "id" TEXT NOT NULL DEFAULT 'singleton',
  "lapse_grace_days" INTEGER NOT NULL DEFAULT 7,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_by" TEXT,
  CONSTRAINT "leave_settings_pkey" PRIMARY KEY ("id")
);
