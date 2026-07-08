-- New employees are created without a password (mustChangePassword = true)
-- and set one on first login, so password_hash can no longer be required
-- at row-creation time.
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;
