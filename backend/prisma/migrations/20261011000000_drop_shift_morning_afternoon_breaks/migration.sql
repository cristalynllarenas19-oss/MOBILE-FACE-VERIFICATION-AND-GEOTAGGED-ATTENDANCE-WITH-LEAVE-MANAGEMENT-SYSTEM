-- The 15-minute morning/afternoon breaks were never used in practice. A
-- shift now has a single break whose length, start time and name
-- (LUNCH/BREAK) are all stored on the shift itself.
ALTER TABLE "shifts"
  DROP COLUMN IF EXISTS "morning_break_minutes",
  DROP COLUMN IF EXISTS "afternoon_break_minutes",
  ADD COLUMN IF NOT EXISTS "break_start_time" TEXT,
  ADD COLUMN IF NOT EXISTS "break_kind" TEXT NOT NULL DEFAULT 'LUNCH';

-- Existing shifts get the same default a new shift is saved with: the
-- break is the shift's 5th hour, called lunch when it starts around midday.
-- (time + interval wraps past midnight, so 22:00 + 4h = 02:00.)
UPDATE "shifts"
SET
  "break_start_time" = to_char("start_time"::time + interval '4 hours', 'HH24:MI'),
  "break_kind" = CASE
    WHEN EXTRACT(HOUR FROM "start_time"::time + interval '4 hours') BETWEEN 10 AND 14 THEN 'LUNCH'
    ELSE 'BREAK'
  END
WHERE "break_start_time" IS NULL;
