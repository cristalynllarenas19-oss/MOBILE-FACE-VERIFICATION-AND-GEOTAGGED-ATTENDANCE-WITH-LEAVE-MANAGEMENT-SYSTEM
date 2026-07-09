-- Adds a soft-delete flag to face_profiles so admins can archive a
-- registered face instead of permanently deleting it.

ALTER TABLE "face_profiles" ADD COLUMN "is_archived" BOOLEAN NOT NULL DEFAULT false;
