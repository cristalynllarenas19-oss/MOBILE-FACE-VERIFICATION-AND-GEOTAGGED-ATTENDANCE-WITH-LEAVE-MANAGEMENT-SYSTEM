-- Business rule changes:
--   * Solo Parent Leave, Study Leave and the new Added Paternity Leave can no
--     longer be self-serve — an employee must ask HR/Admin, who grants a
--     balance for that specific employee (LeaveBalancesService.grant). Until
--     granted, the employee has 0 days of it (see requiresAdminGrant handling
--     in LeaveBalancesService.findForEmployee / LeaveService.create).
--   * Sick Leave and the new Emergency Leave are always exactly 1 day per
--     request (isSingleDayOnly), enforced both client-side and server-side.
--   * Leave Without Pay is retired — archived (is_active = false) rather than
--     deleted so historical leave records referencing it are preserved.

ALTER TABLE "leave_types"
  ADD COLUMN IF NOT EXISTS "requires_admin_grant" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "is_single_day_only" BOOLEAN NOT NULL DEFAULT false;

-- Solo Parent Leave / Study Leave: now admin-grant-only. Study Leave's day
-- allotment was previously "unlimited" — it's now a fixed 15-day pool that
-- HR assigns per employee via the grant endpoint.
UPDATE "leave_types"
  SET "requires_admin_grant" = true
  WHERE "name" IN ('Solo Parent Leave', 'Study Leave');

UPDATE "leave_types"
  SET "default_days" = 15, "is_unlimited_days" = false
  WHERE "name" = 'Study Leave';

-- Sick Leave: single-day-only requests.
UPDATE "leave_types"
  SET "is_single_day_only" = true
  WHERE "name" = 'Sick Leave';

-- Leave Without Pay: retired. Archived, not deleted, so any existing leave
-- requests/balances that reference it stay intact for historical records.
UPDATE "leave_types"
  SET "is_active" = false
  WHERE "name" = 'Leave Without Pay';

-- Strip every current employee's existing Solo Parent / Study Leave balance
-- — access to these now starts at zero and only exists once HR/Admin grants
-- it to that specific employee.
DELETE FROM "leave_balances"
  WHERE "leave_type_id" IN (
    SELECT "id" FROM "leave_types" WHERE "name" IN ('Solo Parent Leave', 'Study Leave')
  );

-- New leave types (only inserted if this DB doesn't already have them).
-- created_at/updated_at are set explicitly rather than relying on a column
-- default, since this table's updated_at has none on at least some
-- environments (it's Prisma-managed via @updatedAt, not a DB default).
INSERT INTO "leave_types" ("id", "name", "default_days", "requires_document", "requires_hr_validation", "is_transferable", "requires_admin_grant", "applicable_statuses", "created_at", "updated_at")
SELECT gen_random_uuid()::text, "name", "default_days", "requires_document", "requires_hr_validation", "is_transferable", true,
  ARRAY['REGULAR','CONTRACTUAL_SEASONAL','PIECE_RATE','SEPARATED']::"EmploymentStatus"[], now(), now()
FROM (VALUES
  -- Added Paternity Leave: the extra days a mother can transfer from her own
  -- Maternity Leave to the father (RA 11210) — the day count is whatever she
  -- chooses to transfer, so it starts at 0 and HR sets it per grant.
  ('Added Paternity Leave', 0::decimal, true, true, true)
) AS t("name", "default_days", "requires_document", "requires_hr_validation", "is_transferable")
WHERE NOT EXISTS (SELECT 1 FROM "leave_types" WHERE "leave_types"."name" = t."name");

INSERT INTO "leave_types" ("id", "name", "default_days", "requires_document", "is_auto_credited", "is_single_day_only", "applicable_statuses", "created_at", "updated_at")
SELECT gen_random_uuid()::text, "name", "default_days", "requires_document", "is_auto_credited", true,
  ARRAY['REGULAR','CONTRACTUAL_SEASONAL','PIECE_RATE','SEPARATED']::"EmploymentStatus"[], now(), now()
FROM (VALUES
  ('Emergency Leave', 5::decimal, false, true)
) AS t("name", "default_days", "requires_document", "is_auto_credited")
WHERE NOT EXISTS (SELECT 1 FROM "leave_types" WHERE "leave_types"."name" = t."name");
