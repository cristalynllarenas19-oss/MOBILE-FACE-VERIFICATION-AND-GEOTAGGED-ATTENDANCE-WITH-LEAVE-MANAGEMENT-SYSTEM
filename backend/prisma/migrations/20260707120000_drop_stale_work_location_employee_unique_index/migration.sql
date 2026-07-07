-- The original join-table migration (20260619160000) carried over a
-- single-employee-per-location unique index from the pre-join-table design.
-- It was never declared in schema.prisma and silently blocked assigning a
-- FIELD employee to more than one work location at the database layer.
DROP INDEX IF EXISTS "work_location_employees_employee_id_key";
