-- id_sequences was declared with `year Int @id` in schema.prisma but the
-- live table was created without that constraint (drift from before this
-- migration folder was tracked) — add it so upsert()/ON CONFLICT against
-- `year` (used below and by EmployeesService.generateEmployeeNo) works.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'id_sequences'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE id_sequences ADD CONSTRAINT id_sequences_pkey PRIMARY KEY (year);
  END IF;
END $$;

-- Renumbers every existing employee onto the ULPI-{YY}{NNN} scheme (already
-- in partial use by two rows, e.g. ULPI-26001) instead of the old ad-hoc
-- "UL-<timestamp>" ids. NNN resets per hire year and is assigned in hire_date
-- order (id as a final tiebreak for same-day hires, since created_at was
-- bulk-backfilled to a single instant in an earlier migration and carries no
-- real ordering information).
WITH ranked AS (
  SELECT
    id,
    EXTRACT(YEAR FROM hire_date)::int AS yr,
    ROW_NUMBER() OVER (
      PARTITION BY EXTRACT(YEAR FROM hire_date)
      ORDER BY hire_date ASC, id ASC
    ) AS rn
  FROM employees
)
UPDATE employees e
SET employee_no = 'ULPI-' || RIGHT(ranked.yr::text, 2) || LPAD(ranked.rn::text, 3, '0')
FROM ranked
WHERE e.id = ranked.id;

-- Advance each year's counter to match what was just handed out, so the next
-- hire in that year (via EmployeesService.generateEmployeeNo) continues from
-- here instead of colliding.
INSERT INTO id_sequences (year, last_number)
SELECT EXTRACT(YEAR FROM hire_date)::int, COUNT(*)
FROM employees
GROUP BY EXTRACT(YEAR FROM hire_date)::int
ON CONFLICT (year) DO UPDATE SET last_number = GREATEST(id_sequences.last_number, EXCLUDED.last_number);
