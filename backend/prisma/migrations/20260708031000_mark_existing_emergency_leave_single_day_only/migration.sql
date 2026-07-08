-- The previous migration only set is_single_day_only on new inserts of
-- "Emergency Leave", assuming the type didn't already exist. On DBs where an
-- admin had already created an "Emergency Leave" type by hand (via the Leave
-- Types admin screen) before this business rule shipped, that row was left
-- untouched — fix it here regardless of how the row came to exist, without
-- touching its admin-configured day allotment.
UPDATE "leave_types"
  SET "is_single_day_only" = true
  WHERE "name" = 'Emergency Leave';
