-- e-TALA: undo readable_ids_migrate.sql — puts back the original UUID ids
-- recorded in etala_migration.id_map and removes the sequences/functions.
--
--   psql -v ON_ERROR_STOP=1 -d "<connection url>" -f readable_ids_rollback.sql
--
-- The backend code must be rolled back to the UUID version at the same time.
-- Rows created AFTER the migration have no UUID to return to and keep their
-- readable id (still unique, still valid).

BEGIN;

DO $$
BEGIN
  IF to_regclass('etala_migration.id_map') IS NULL THEN
    RAISE EXCEPTION 'Nothing to roll back: etala_migration.id_map does not exist.';
  END IF;
END
$$;

-- Stop generating readable ids for new rows.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT t.relname AS tbl, s.relname AS seq
      FROM pg_class s
      JOIN pg_class t
        ON t.relnamespace = s.relnamespace AND t.relkind = 'r' AND s.relname = t.relname || '_id_seq'
     WHERE s.relkind = 'S' AND s.relnamespace = 'public'::regnamespace
  LOOP
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN id DROP DEFAULT', r.tbl);
    EXECUTE format('DROP SEQUENCE public.%I', r.seq);
  END LOOP;
END
$$;

-- Primary keys back to their original values (foreign keys cascade).
DO $$
DECLARE
  r record;
  m record;
BEGIN
  FOR r IN
    SELECT d.table_name,
           EXISTS (SELECT 1 FROM pg_constraint con
                    WHERE con.contype = 'f' AND con.conrelid = con.confrelid
                      AND con.conrelid = format('public.%I', d.table_name)::regclass) AS self_referencing
      FROM (SELECT DISTINCT table_name FROM etala_migration.id_map
             WHERE to_regclass(format('public.%I', table_name)) IS NOT NULL) d
  LOOP
    IF r.self_referencing THEN
      -- Same one-row-at-a-time rule as the migration (employees.supervisor_id).
      FOR m IN SELECT old_id, new_id FROM etala_migration.id_map WHERE table_name = r.table_name LOOP
        EXECUTE format('UPDATE public.%I SET id = $1 WHERE id = $2', r.table_name) USING m.old_id, m.new_id;
      END LOOP;
    ELSE
      EXECUTE format(
        'UPDATE public.%I t SET id = m.old_id FROM etala_migration.id_map m WHERE m.table_name = %L AND m.new_id = t.id',
        r.table_name, r.table_name);
    END IF;
  END LOOP;
END
$$;

-- Ids stored outside foreign keys.
UPDATE public.notifications n SET entity_id = m.old_id
  FROM etala_migration.id_map m WHERE m.new_id = n.entity_id;

UPDATE public.audit_logs a SET entity_id = m.old_id
  FROM etala_migration.id_map m WHERE m.new_id = a.entity_id;

UPDATE public.employee_archives a SET archived_by_user_id = m.old_id
  FROM etala_migration.id_map m WHERE m.new_id = a.archived_by_user_id;
UPDATE public.employee_archives a SET restored_by_user_id = m.old_id
  FROM etala_migration.id_map m WHERE m.new_id = a.restored_by_user_id;

UPDATE public.announcements a
   SET target_employee_ids = ARRAY(
         SELECT coalesce(m.old_id, x.v)
           FROM unnest(a.target_employee_ids) WITH ORDINALITY AS x(v, ord)
           LEFT JOIN etala_migration.id_map m ON m.new_id = x.v
          ORDER BY x.ord),
       target_department_ids = ARRAY(
         SELECT coalesce(m.old_id, x.v)
           FROM unnest(a.target_department_ids) WITH ORDINALITY AS x(v, ord)
           LEFT JOIN etala_migration.id_map m ON m.new_id = x.v
          ORDER BY x.ord)
 WHERE cardinality(a.target_employee_ids) > 0 OR cardinality(a.target_department_ids) > 0;

-- Audit log JSON: only whole quoted values are swapped back, so ordinary text
-- that merely looks like an id is never touched.
CREATE FUNCTION pg_temp.restore_ids(src text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  r record;
  v_out text := src;
BEGIN
  FOR r IN
    SELECT DISTINCT m.old_id, m.new_id
      FROM regexp_matches(src, '"([A-Z]+(?:-[A-Z]+)?-[0-9]+)"', 'g') AS g(hit)
      JOIN etala_migration.id_map m ON m.new_id = g.hit[1]
  LOOP
    v_out := replace(v_out, '"' || r.new_id || '"', '"' || r.old_id || '"');
  END LOOP;
  RETURN v_out;
END
$$;

UPDATE public.audit_logs SET old_values = pg_temp.restore_ids(old_values::text)::jsonb
 WHERE old_values::text ~ '"[A-Z]+(-[A-Z]+)?-[0-9]+"';
UPDATE public.audit_logs SET new_values = pg_temp.restore_ids(new_values::text)::jsonb
 WHERE new_values::text ~ '"[A-Z]+(-[A-Z]+)?-[0-9]+"';

DROP FUNCTION IF EXISTS public.etala_sync_id_sequences();
DROP FUNCTION IF EXISTS public.next_leave_type_id(text);
DROP FUNCTION IF EXISTS public.etala_leave_type_code(text);
DROP FUNCTION IF EXISTS public.etala_format_id(text, bigint, int);
DROP TABLE IF EXISTS public.leave_type_id_sequences;
DROP SCHEMA etala_migration CASCADE;

COMMIT;
