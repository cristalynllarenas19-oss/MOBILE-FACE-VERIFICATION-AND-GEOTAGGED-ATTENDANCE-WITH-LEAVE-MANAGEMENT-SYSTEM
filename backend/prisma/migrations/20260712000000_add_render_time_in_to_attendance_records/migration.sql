-- OFFICE totalMinutes now derives from the rounded/render time-in
-- (computeRenderTimeIn) instead of the raw capture instant, so it needs a
-- column of its own alongside time_in_at rather than reusing it.
ALTER TABLE "attendance_records"
  ADD COLUMN IF NOT EXISTS "render_time_in_at" TIMESTAMP(3);
