-- Polygon geotagged areas (drawn on the map or imported from KML). Null keeps
-- an area a circle, so every existing area is unchanged.
ALTER TABLE "work_locations" ADD COLUMN IF NOT EXISTS "boundary" JSONB;
