-- e-TALA: id sequences and helper functions for a BRAND-NEW, empty database.
--
-- schema.prisma's id defaults (EMP-1001, LR-1001, ROLE-001, ...) refer to
-- these sequences and functions, and `prisma db push` cannot create them
-- itself — so on a fresh database run this first:
--   npm run prisma:setup-ids     (then)     npm run prisma:migrate
--
-- NOT for a database that already has data: use readable_ids_migrate.sql
-- there, which creates the same objects and re-keys the existing rows.
-- Safe to re-run (everything is IF NOT EXISTS / OR REPLACE).

CREATE OR REPLACE FUNCTION public.etala_format_id(prefix text, n bigint, pad int)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT prefix || CASE WHEN length(n::text) >= pad THEN n::text ELSE lpad(n::text, pad, '0') END
$$;

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

CREATE TABLE IF NOT EXISTS public.leave_type_id_sequences (
  code        text PRIMARY KEY,
  last_number integer NOT NULL DEFAULT 0
);

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

-- Records are numbered from 1001; small lookup tables from 001.
CREATE SEQUENCE IF NOT EXISTS public.users_id_seq                    START WITH 1001;
CREATE SEQUENCE IF NOT EXISTS public.password_reset_otps_id_seq      START WITH 1001;
CREATE SEQUENCE IF NOT EXISTS public.roles_id_seq                    START WITH 1;
CREATE SEQUENCE IF NOT EXISTS public.permissions_id_seq              START WITH 1;
CREATE SEQUENCE IF NOT EXISTS public.departments_id_seq              START WITH 1001;
CREATE SEQUENCE IF NOT EXISTS public.divisions_id_seq                START WITH 1001;
CREATE SEQUENCE IF NOT EXISTS public.sections_id_seq                 START WITH 1001;
CREATE SEQUENCE IF NOT EXISTS public.positions_id_seq                START WITH 1001;
CREATE SEQUENCE IF NOT EXISTS public.employees_id_seq                START WITH 1001;
CREATE SEQUENCE IF NOT EXISTS public.employee_archives_id_seq        START WITH 1001;
CREATE SEQUENCE IF NOT EXISTS public.employee_types_id_seq           START WITH 1;
CREATE SEQUENCE IF NOT EXISTS public.attendance_modes_id_seq         START WITH 1;
CREATE SEQUENCE IF NOT EXISTS public.work_locations_id_seq           START WITH 1001;
CREATE SEQUENCE IF NOT EXISTS public.work_location_employees_id_seq  START WITH 1001;
CREATE SEQUENCE IF NOT EXISTS public.attendance_records_id_seq       START WITH 1001;
CREATE SEQUENCE IF NOT EXISTS public.attendance_logs_id_seq          START WITH 1001;
CREATE SEQUENCE IF NOT EXISTS public.face_profiles_id_seq            START WITH 1001;
CREATE SEQUENCE IF NOT EXISTS public.leave_requests_id_seq           START WITH 1001;
CREATE SEQUENCE IF NOT EXISTS public.leave_request_notes_id_seq      START WITH 1001;
CREATE SEQUENCE IF NOT EXISTS public.leave_balances_id_seq           START WITH 1001;
CREATE SEQUENCE IF NOT EXISTS public.leave_accrual_records_id_seq    START WITH 1001;
CREATE SEQUENCE IF NOT EXISTS public.undertime_filings_id_seq        START WITH 1001;
CREATE SEQUENCE IF NOT EXISTS public.shifts_id_seq                   START WITH 1;
CREATE SEQUENCE IF NOT EXISTS public.employee_schedules_id_seq       START WITH 1001;
CREATE SEQUENCE IF NOT EXISTS public.notifications_id_seq            START WITH 1001;
CREATE SEQUENCE IF NOT EXISTS public.probationary_evaluations_id_seq START WITH 1001;
CREATE SEQUENCE IF NOT EXISTS public.announcements_id_seq            START WITH 1001;
CREATE SEQUENCE IF NOT EXISTS public.audit_logs_id_seq               START WITH 1001;
