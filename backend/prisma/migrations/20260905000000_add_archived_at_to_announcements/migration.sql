ALTER TABLE "announcements"
  ADD COLUMN IF NOT EXISTS "archived_at" TIMESTAMP(3);
