-- Leave reset date + VL monetization. Run once on a database that already
-- has data (e.g. the hosted one) BEFORE deploying the code — `prisma db push`
-- can't create the id sequence, and on a drifted database it may also try
-- to drop unrelated columns. Safe to re-run.
CREATE SEQUENCE IF NOT EXISTS public.leave_monetizations_id_seq START WITH 1001;

ALTER TABLE "leave_settings"
  ADD COLUMN IF NOT EXISTS "reset_month" INTEGER NOT NULL DEFAULT 12,
  ADD COLUMN IF NOT EXISTS "reset_day" INTEGER NOT NULL DEFAULT 26;

-- Monetization is a rule per leave type (Edit Leave Type → Rules).
ALTER TABLE "leave_types"
  ADD COLUMN IF NOT EXISTS "is_monetizable" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "max_monetizable_days" DECIMAL(65,30);

-- Vacation Leave starts out monetizable, up to 5 days (only if nobody has
-- set it yet, so re-running never overwrites an HR change).
UPDATE "leave_types"
  SET "is_monetizable" = true, "max_monetizable_days" = 5
  WHERE lower(trim("name")) = 'vacation leave' AND "max_monetizable_days" IS NULL;

CREATE TABLE IF NOT EXISTS "leave_monetizations" (
    "id" TEXT NOT NULL DEFAULT ('LM-'::text || nextval('leave_monetizations_id_seq'::regclass)),
    "employee_id" TEXT NOT NULL REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "leave_type_id" TEXT NOT NULL REFERENCES "leave_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "year" INTEGER NOT NULL,
    "days" DECIMAL(65,30) NOT NULL,
    "monetized_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "monetized_by" TEXT,
    CONSTRAINT "leave_monetizations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "leave_monetizations_year_idx" ON "leave_monetizations"("year");
CREATE UNIQUE INDEX IF NOT EXISTS "leave_monetizations_employee_id_leave_type_id_year_key"
  ON "leave_monetizations"("employee_id", "leave_type_id", "year");
