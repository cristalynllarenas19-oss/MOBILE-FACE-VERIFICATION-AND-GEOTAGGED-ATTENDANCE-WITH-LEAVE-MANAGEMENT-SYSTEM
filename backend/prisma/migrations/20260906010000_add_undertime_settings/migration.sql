-- CreateTable: single-row config for the admin-editable undertime filing
-- days, lazily upserted on first read/write (no seed row required here).
CREATE TABLE IF NOT EXISTS "undertime_settings" (
  "id" TEXT NOT NULL DEFAULT 'singleton',
  "filing_days_of_month" INTEGER[] NOT NULL DEFAULT ARRAY[8, 23]::INTEGER[],
  "updated_at" TIMESTAMP(3) NOT NULL,
  "updated_by" TEXT,

  CONSTRAINT "undertime_settings_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "undertime_settings"
    ADD CONSTRAINT "undertime_settings_updated_by_fkey"
    FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
