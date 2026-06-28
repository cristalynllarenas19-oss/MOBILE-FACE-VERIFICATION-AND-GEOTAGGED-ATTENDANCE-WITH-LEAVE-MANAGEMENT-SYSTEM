-- Leave types now declare which employment classifications they apply to,
-- so admins can scope a leave type (e.g. Maternity Leave) away from
-- classifications where it doesn't make sense, instead of every leave type
-- always applying to every employee. Existing leave types are backfilled to
-- all four classifications so today's "applies to everyone" behavior is
-- preserved for data that predates this column.
ALTER TABLE "leave_types"
  ADD COLUMN IF NOT EXISTS "applicable_statuses" "EmploymentStatus"[] NOT NULL DEFAULT ARRAY[]::"EmploymentStatus"[];

UPDATE "leave_types"
  SET "applicable_statuses" = ARRAY['REGULAR','PROBATIONARY','CONTRACTUAL','SEPARATED']::"EmploymentStatus"[]
  WHERE "applicable_statuses" = ARRAY[]::"EmploymentStatus"[];
