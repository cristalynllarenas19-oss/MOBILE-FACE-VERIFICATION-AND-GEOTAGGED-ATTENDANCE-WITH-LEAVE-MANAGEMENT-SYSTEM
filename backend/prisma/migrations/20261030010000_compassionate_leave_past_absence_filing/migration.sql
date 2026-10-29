-- Compassionate Leave may also be filed for a past day the employee was
-- absent, like Sick Leave. It keeps advance filing (today/future dates).
UPDATE "leave_types"
  SET "past_absence_filing_allowed" = true
  WHERE "name" = 'Compassionate Leave';
