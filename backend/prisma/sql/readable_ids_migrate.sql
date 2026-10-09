-- e-TALA: replace UUID primary keys with readable, sequence-generated ids
-- (EMP-1001, LR-1001, ROLE-001, LT-VL-001, ...).
--
-- Run once per database, with the backend stopped, AFTER taking a backup:
--   psql -v ON_ERROR_STOP=1 -d "<connection url>" -f readable_ids_migrate.sql
--
-- Everything happens in one transaction: any failed check rolls the whole
-- thing back and the database is left exactly as it was. No rows are deleted
-- or recreated — ids are rewritten in place and every foreign key follows
-- through its existing ON UPDATE CASCADE rule.
--
-- The old-id -> new-id mapping is kept in etala_migration.id_map (outside the
-- public schema) so readable_ids_rollback.sql can reverse this.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Permanent helpers
-- ---------------------------------------------------------------------------

-- 'ROLE-' + 7 padded to 3 digits -> ROLE-007. Never truncates: once the number
-- outgrows the padding it is written in full (ROLE-1000), so ids stay unique.
CREATE OR REPLACE FUNCTION public.etala_format_id(prefix text, n bigint, pad int)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT prefix || CASE WHEN length(n::text) >= pad THEN n::text ELSE lpad(n::text, pad, '0') END
$$;

-- Category code inside a leave type id (LT-<code>-001): a fixed code for the
-- standard leave types, otherwise the initials of the name.
CREATE OR REPLACE FUNCTION public.etala_leave_type_code(leave_type_name text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE lower(btrim(leave_type_name))
    WHEN 'vacation leave'        THEN 'VL'
    WHEN 'sick leave'            THEN 'SL'
    WHEN 'emergency leave'       THEN 'EL'
    WHEN 'maternity leave'       THEN 'ML'
    WHEN 'paternity leave'       THEN 'PL'
    WHEN 'added paternity leave' THEN 'APL'
    WHEN 'bereavement leave'     THEN 'BL'
    WHEN 'compassionate leave'   THEN 'CL'
    WHEN 'special leave'         THEN 'SP'
    WHEN 'solo parent leave'     THEN 'SPL'
    WHEN 'study leave'           THEN 'STL'
    WHEN 'adverse weather leave' THEN 'AWL'
    WHEN 'leave without pay'     THEN 'LWOP'
    ELSE coalesce(
      nullif(
        (SELECT upper(string_agg(left(w.word, 1), '' ORDER BY w.ord))
           FROM regexp_split_to_table(regexp_replace(leave_type_name, '[^A-Za-z ]', '', 'g'), '\s+')
                WITH ORDINALITY AS w(word, ord)
          WHERE w.word <> ''),
        ''),
      'X')
  END
$$;

-- One counter per leave type code — same idea as id_sequences (employee_no).
CREATE TABLE IF NOT EXISTS public.leave_type_id_sequences (
  code        text PRIMARY KEY,
  last_number integer NOT NULL DEFAULT 0
);

-- Next id for a new leave type. The upsert takes a row lock, so two leave
-- types created at the same moment can never receive the same number, and a
-- number is never handed out twice even if a leave type is later deleted.
CREATE OR REPLACE FUNCTION public.next_leave_type_id(leave_type_name text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_code text := public.etala_leave_type_code(leave_type_name);
  v_number integer;
BEGIN
  INSERT INTO public.leave_type_id_sequences AS s (code, last_number)
  VALUES (v_code, 1)
  ON CONFLICT (code) DO UPDATE SET last_number = s.last_number + 1
  RETURNING s.last_number INTO v_number;
  RETURN public.etala_format_id('LT-' || v_code || '-', v_number, 3);
END
$$;

-- Moves every <table>_id_seq (and the leave type counters) past the highest
-- id currently stored. Only ever moves forward. Called at the end of this
-- migration and after every backup restore (BackupService), because a restore
-- reloads rows with their ids but does not carry sequence positions.
CREATE OR REPLACE FUNCTION public.etala_sync_id_sequences()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  r record;
  v_max bigint;
  v_last bigint;
  v_called boolean;
BEGIN
  FOR r IN
    SELECT t.relname AS tbl, s.relname AS seq
      FROM pg_class s
      JOIN pg_class t
        ON t.relnamespace = s.relnamespace AND t.relkind = 'r' AND s.relname = t.relname || '_id_seq'
     WHERE s.relkind = 'S' AND s.relnamespace = 'public'::regnamespace
  LOOP
    EXECUTE format(
      'SELECT max(substring(id from ''([0-9]+)$'')::bigint) FROM public.%I WHERE id ~ ''^[A-Z]+-[0-9]+$''', r.tbl)
      INTO v_max;
    EXECUTE format('SELECT last_value, is_called FROM public.%I', r.seq) INTO v_last, v_called;
    IF v_max IS NOT NULL AND (v_max > v_last OR (v_max = v_last AND NOT v_called)) THEN
      PERFORM setval(format('public.%I', r.seq)::regclass, v_max, true);
    END IF;
  END LOOP;

  INSERT INTO public.leave_type_id_sequences AS s (code, last_number)
  SELECT m[1], max(m[2]::integer)
    FROM public.leave_types lt, regexp_match(lt.id, '^LT-([A-Z]+)-([0-9]+)$') AS m
   WHERE m IS NOT NULL
   GROUP BY m[1]
  ON CONFLICT (code) DO UPDATE SET last_number = greatest(s.last_number, EXCLUDED.last_number);
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Which table gets which id
-- ---------------------------------------------------------------------------
-- pad = minimum digits (0 = none); start_at = number given to the first row;
-- order_by decides which existing row becomes number 1, 2, 3...
-- Composite-key join tables (user_roles, role_permissions,
-- position_departments) have no id of their own — they simply follow.
-- leave_types is handled separately (LT-<code>-NNN). undertime_settings keeps
-- its fixed "singleton" id. _prisma_migrations and id_sequences are untouched.
CREATE TEMP TABLE _id_cfg (tbl text PRIMARY KEY, prefix text, pad int, start_at int, order_by text) ON COMMIT DROP;
INSERT INTO _id_cfg VALUES
  ('users',                    'USR-',   0, 1001, 't.created_at'),
  ('password_reset_otps',      'OTP-',   0, 1001, 't.created_at'),
  ('roles',                    'ROLE-',  3, 1,    $o$array_position(ARRAY['ADMIN','SUPERVISOR','EMPLOYEE'], t.code::text)$o$),
  ('permissions',              'PERM-',  3, 1,    't.module, t.code'),
  ('departments',              'DEPT-',  0, 1001, 't.name'),
  ('divisions',                'DIV-',   0, 1001, 't.name'),
  ('sections',                 'SEC-',   0, 1001, 't.name'),
  ('positions',                'POS-',   0, 1001, 't.created_at, t.title'),
  ('employees',                'EMP-',   0, 1001, 't.created_at, t.employee_no'),
  ('employee_archives',        'ARCH-',  0, 1001, 't.archived_at'),
  ('employee_types',           'ETYPE-', 3, 1,    't.created_at, t.name'),
  ('attendance_modes',         'AMODE-', 3, 1,    't.sort_order, t.code'),
  ('attendance_mode_options',  'AMOPT-', 3, 1,    't.sort_order, t.code'),
  ('work_locations',           'LOC-',   0, 1001, 't.name'),
  ('work_location_employees',  'WLA-',   0, 1001, 't.assigned_at'),
  ('attendance_records',       'ATT-',   0, 1001, 't.attendance_date, t.time_in_at NULLS LAST'),
  ('attendance_logs',          'ALOG-',  0, 1001, 't.captured_at'),
  ('face_profiles',            'FACE-',  0, 1001, 't.enrolled_at NULLS LAST, (SELECT e.employee_no FROM public.employees e WHERE e.id = t.employee_id)'),
  ('leave_requests',           'LR-',    0, 1001, 't.created_at'),
  ('leave_request_notes',      'LRN-',   0, 1001, 't.created_at'),
  ('leave_balances',           'LB-',    0, 1001, 't.year, (SELECT e.employee_no FROM public.employees e WHERE e.id = t.employee_id), (SELECT l.name FROM public.leave_types l WHERE l.id = t.leave_type_id)'),
  ('leave_accrual_records',    'LAC-',   0, 1001, 't.credited_at, t.cycle_start'),
  ('undertime_filings',        'UT-',    0, 1001, 't.created_at'),
  ('shifts',                   'SHIFT-', 3, 1,    't.created_at, t.name'),
  ('employee_schedules',       'SCHED-', 0, 1001, 't.starts_on, (SELECT e.employee_no FROM public.employees e WHERE e.id = t.employee_id)'),
  ('notifications',            'NOTIF-', 0, 1001, 't.created_at'),
  ('probationary_evaluations', 'EVAL-',  0, 1001, 't.created_at'),
  ('announcements',            'ANN-',   0, 1001, 't.created_at'),
  ('audit_logs',               'AUD-',   0, 1001, 't.created_at');

-- ---------------------------------------------------------------------------
-- 3. Safety checks — nothing has been changed yet if any of these fail
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_list text;
BEGIN
  IF to_regclass('etala_migration.id_map') IS NOT NULL THEN
    RAISE EXCEPTION 'This database has already been migrated (etala_migration.id_map exists).';
  END IF;

  -- A table with a text "id" this script doesn't know about would be left
  -- holding UUIDs — stop and list it rather than migrate only part of the DB.
  SELECT string_agg(c.table_name, ', ') INTO v_list
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
   WHERE c.table_schema = 'public' AND c.column_name = 'id' AND c.data_type = 'text'
     AND c.table_name NOT IN (SELECT tbl FROM _id_cfg)
     AND c.table_name NOT IN ('leave_types', 'undertime_settings', '_prisma_migrations');
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'Tables with an id column that this script does not cover: %', v_list;
  END IF;

  -- Children only follow a rewritten parent id if the foreign key cascades.
  SELECT string_agg(con.conrelid::regclass::text || ' (' || con.conname || ')', ', ') INTO v_list
    FROM pg_constraint con
    JOIN pg_class ref ON ref.oid = con.confrelid
   WHERE con.contype = 'f' AND con.connamespace = 'public'::regnamespace
     AND (ref.relname IN (SELECT tbl FROM _id_cfg) OR ref.relname = 'leave_types')
     AND con.confupdtype <> 'c';
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'Foreign keys without ON UPDATE CASCADE (fix these first): %', v_list;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. Build the old id -> new id map
-- ---------------------------------------------------------------------------
CREATE SCHEMA etala_migration;
CREATE TABLE etala_migration.id_map (
  table_name text NOT NULL,
  old_id     text PRIMARY KEY,
  new_id     text NOT NULL,
  UNIQUE (table_name, new_id)
);
CREATE INDEX id_map_new_id_idx ON etala_migration.id_map (new_id);
CREATE TABLE etala_migration.row_counts_before (table_name text PRIMARY KEY, row_count bigint NOT NULL);

DO $$
DECLARE
  c record;
  r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'leave_type_id_sequences' LOOP
    EXECUTE format('INSERT INTO etala_migration.row_counts_before SELECT %L, count(*) FROM public.%I', r.tablename, r.tablename);
  END LOOP;

  FOR c IN SELECT * FROM _id_cfg LOOP
    CONTINUE WHEN to_regclass(format('public.%I', c.tbl)) IS NULL;
    EXECUTE format(
      'INSERT INTO etala_migration.id_map (table_name, old_id, new_id)
       SELECT %L, t.id, public.etala_format_id(%L, %s - 1 + row_number() OVER (ORDER BY %s, t.id), %s)
         FROM public.%I t',
      c.tbl, c.prefix, c.start_at, c.order_by, c.pad, c.tbl);
  END LOOP;
END
$$;

INSERT INTO etala_migration.id_map (table_name, old_id, new_id)
SELECT 'leave_types', s.id,
       public.etala_format_id('LT-' || s.code || '-', row_number() OVER (PARTITION BY s.code ORDER BY s.created_at, s.id), 3)
  FROM (SELECT id, created_at, public.etala_leave_type_code(name) AS code FROM public.leave_types) s;

-- ---------------------------------------------------------------------------
-- 5. Rewrite primary keys — foreign keys follow via ON UPDATE CASCADE
-- ---------------------------------------------------------------------------
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
      FROM (SELECT DISTINCT table_name FROM etala_migration.id_map) d
  LOOP
    IF r.self_referencing THEN
      -- A table that points at itself (employees.supervisor_id) is re-keyed
      -- one row at a time: each row's cascade must finish before a row that
      -- references it is rewritten, which a single bulk UPDATE can't do.
      FOR m IN SELECT old_id, new_id FROM etala_migration.id_map WHERE table_name = r.table_name LOOP
        EXECUTE format('UPDATE public.%I SET id = $1 WHERE id = $2', r.table_name) USING m.new_id, m.old_id;
      END LOOP;
    ELSE
      EXECUTE format(
        'UPDATE public.%I t SET id = m.new_id FROM etala_migration.id_map m WHERE m.table_name = %L AND m.old_id = t.id',
        r.table_name, r.table_name);
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 6. Ids stored outside foreign keys
-- ---------------------------------------------------------------------------
-- audit_logs / notifications can still point at a record that was deleted
-- long ago, so its UUID maps to nothing. Those get a DEL-<n> placeholder
-- (kept in the map like any other id) instead of being left as a raw UUID.
INSERT INTO etala_migration.id_map (table_name, old_id, new_id)
SELECT 'deleted_records', o.entity_id, 'DEL-' || (1000 + row_number() OVER (ORDER BY min(o.created_at), o.entity_id))
  FROM (SELECT entity_id, created_at FROM public.audit_logs
        UNION ALL
        SELECT entity_id, created_at FROM public.notifications) o
 WHERE o.entity_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND NOT EXISTS (SELECT 1 FROM etala_migration.id_map m WHERE m.old_id = o.entity_id)
 GROUP BY o.entity_id;

UPDATE public.notifications n SET entity_id = m.new_id
  FROM etala_migration.id_map m WHERE m.old_id = n.entity_id;

UPDATE public.audit_logs a SET entity_id = m.new_id
  FROM etala_migration.id_map m WHERE m.old_id = a.entity_id;

-- employee_archives records who archived/restored as plain user ids (no FK).
UPDATE public.employee_archives a SET archived_by_user_id = m.new_id
  FROM etala_migration.id_map m WHERE m.old_id = a.archived_by_user_id;
UPDATE public.employee_archives a SET restored_by_user_id = m.new_id
  FROM etala_migration.id_map m WHERE m.old_id = a.restored_by_user_id;

UPDATE public.announcements a
   SET target_employee_ids = ARRAY(
         SELECT coalesce(m.new_id, x.v)
           FROM unnest(a.target_employee_ids) WITH ORDINALITY AS x(v, ord)
           LEFT JOIN etala_migration.id_map m ON m.old_id = x.v
          ORDER BY x.ord),
       target_department_ids = ARRAY(
         SELECT coalesce(m.new_id, x.v)
           FROM unnest(a.target_department_ids) WITH ORDINALITY AS x(v, ord)
           LEFT JOIN etala_migration.id_map m ON m.old_id = x.v
          ORDER BY x.ord)
 WHERE cardinality(a.target_employee_ids) > 0 OR cardinality(a.target_department_ids) > 0;

-- Audit log before/after snapshots are JSON that mention ids (employeeId,
-- workLocationId, employeeIds, ...). An id that no longer maps to a row (the
-- record was deleted long ago) is left as it was recorded.
CREATE FUNCTION pg_temp.remap_ids(src text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  r record;
  v_out text := src;
BEGIN
  FOR r IN
    SELECT DISTINCT m.old_id, m.new_id
      FROM regexp_matches(src, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'g') AS g(hit)
      JOIN etala_migration.id_map m ON m.old_id = g.hit[1]
  LOOP
    v_out := replace(v_out, r.old_id, r.new_id);
  END LOOP;
  RETURN v_out;
END
$$;

UPDATE public.audit_logs SET old_values = pg_temp.remap_ids(old_values::text)::jsonb
 WHERE old_values::text ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
UPDATE public.audit_logs SET new_values = pg_temp.remap_ids(new_values::text)::jsonb
 WHERE new_values::text ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

-- ---------------------------------------------------------------------------
-- 7. Automatic id generation for new rows
-- ---------------------------------------------------------------------------
-- One sequence per table, used as the id column's DEFAULT. nextval() is
-- atomic (safe under concurrent inserts) and never goes backwards (a deleted
-- row's number is never reused). New leave types get theirs from
-- next_leave_type_id() instead — see LeaveTypesService.create.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN SELECT * FROM _id_cfg LOOP
    CONTINUE WHEN to_regclass(format('public.%I', c.tbl)) IS NULL;
    EXECUTE format('CREATE SEQUENCE public.%I START WITH %s', c.tbl || '_id_seq', c.start_at);
    IF c.pad > 0 THEN
      EXECUTE format(
        'ALTER TABLE public.%I ALTER COLUMN id SET DEFAULT public.etala_format_id(%L, nextval(%L), %s)',
        c.tbl, c.prefix, 'public.' || c.tbl || '_id_seq', c.pad);
    ELSE
      EXECUTE format(
        'ALTER TABLE public.%I ALTER COLUMN id SET DEFAULT (%L || nextval(%L))',
        c.tbl, c.prefix, 'public.' || c.tbl || '_id_seq');
    END IF;
    EXECUTE format('ALTER SEQUENCE public.%I OWNED BY public.%I.id', c.tbl || '_id_seq', c.tbl);
  END LOOP;
END
$$;

SELECT public.etala_sync_id_sequences();

-- ---------------------------------------------------------------------------
-- 8. Verification — any failure here rolls the whole migration back
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_n bigint;
  v_bad text := '';
BEGIN
  -- No row was added or lost in any table.
  FOR r IN SELECT table_name, row_count FROM etala_migration.row_counts_before LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', r.table_name) INTO v_n;
    IF v_n <> r.row_count THEN
      v_bad := v_bad || format(' [%s: %s rows before, %s after]', r.table_name, r.row_count, v_n);
    END IF;
  END LOOP;

  -- No primary key or foreign key column still holds a UUID.
  FOR r IN
    SELECT DISTINCT cls.relname AS tbl, att.attname AS col
      FROM pg_constraint con
      JOIN pg_class cls ON cls.oid = con.conrelid
      JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
     WHERE con.contype IN ('p', 'f') AND con.connamespace = 'public'::regnamespace
       AND att.atttypid = 'text'::regtype AND cls.relname <> '_prisma_migrations'
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM public.%I WHERE %I ~ ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''',
      r.tbl, r.col) INTO v_n;
    IF v_n > 0 THEN
      v_bad := v_bad || format(' [%s.%s: %s UUID values left]', r.tbl, r.col, v_n);
    END IF;
  END LOOP;

  -- Every remapped id is unique.
  SELECT count(*) INTO v_n FROM (SELECT new_id FROM etala_migration.id_map GROUP BY new_id HAVING count(*) > 1) d;
  IF v_n > 0 THEN
    v_bad := v_bad || format(' [%s duplicate new ids]', v_n);
  END IF;

  IF v_bad <> '' THEN
    RAISE EXCEPTION 'Verification failed, nothing was changed:%', v_bad;
  END IF;

  -- Not a failure, just a heads-up: any other column still holding something
  -- UUID-shaped (e.g. an id column added to the database outside this script).
  FOR r IN
    SELECT table_name AS tbl, column_name AS col
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'
       AND data_type IN ('text', 'ARRAY', 'jsonb')
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM public.%I WHERE %I::text ~ ''[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}''',
      r.tbl, r.col) INTO v_n;
    IF v_n > 0 THEN
      RAISE WARNING '%.% still contains % UUID-shaped value(s) - review manually.', r.tbl, r.col, v_n;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_n FROM etala_migration.id_map;
  RAISE NOTICE 'Readable ids applied: % rows re-keyed, all row counts unchanged.', v_n;
END
$$;

COMMIT;
