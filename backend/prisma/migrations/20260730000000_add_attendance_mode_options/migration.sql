CREATE TABLE "attendance_mode_options" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "description" TEXT,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "available_for_employees" BOOLEAN NOT NULL DEFAULT true,
  "available_for_departments" BOOLEAN NOT NULL DEFAULT true,

  CONSTRAINT "attendance_mode_options_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "attendance_mode_options_code_key" ON "attendance_mode_options"("code");

INSERT INTO "attendance_mode_options" ("id", "code", "label", "description", "sort_order", "is_active", "available_for_employees", "available_for_departments")
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'FIXED', 'Non-field', 'Regular office-based attendance mode.', 10, true, true, true),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 'FIELD', 'Field', 'Field/site visit attendance mode.', 20, true, true, true),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', 'BOTH', 'Both', 'No department-level restriction.', 30, true, false, true)
ON CONFLICT ("code") DO NOTHING;