-- Optional middle name (null when the employee has none). Added to the schema
-- with the batch-file employee import but never migrated.
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "middle_name" TEXT;
