-- Lets the backend instantly invalidate an already-issued JWT (e.g. when an
-- admin is replaced and force-logged-out) instead of waiting for its 15m expiry.

ALTER TABLE "users" ADD COLUMN "token_version" INTEGER NOT NULL DEFAULT 0;
