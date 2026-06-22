---
name: seed-script-overwrite-risk
description: backend/prisma/seed.ts upsert overwrites manually-edited employee names for UL-001/002/003 on every run
metadata:
  type: feedback
---

Never re-run `backend/prisma/seed.ts` against the real dev/demo Neon DB without checking first whether the seeded employees (UL-001, UL-002, UL-003) have been manually renamed since seeding.

**Why:** `upsertUser()` in `seed.ts` does `prisma.employee.upsert({ where: { employeeNo }, update: { ...employee, userId }, create: { ... } })`. The `update` clause unconditionally overwrites `firstName`/`lastName`/`departmentId`/`positionId`/`hireDate` back to the hardcoded seed values, even on an existing row. The user had renamed UL-003's employee from the seed default "Ana Reyes" to the real name "Zean Marquez"; re-running the seed script (done to apply a new role permission) silently reverted it back to "Ana Reyes" with no warning. Other employees created through the actual app (with auto-generated employeeNo values, e.g. UL-400071, UL-528632) are unaffected since they don't match the seed's upsert keys.

**How to apply:** If a permission/role/leave-type change requires re-running `seed.ts`, first capture the current `firstName`/`lastName` for UL-001/UL-002/UL-003 (or just the whole row) so they can be restored afterward, or apply the narrower change directly via Prisma/SQL instead of re-running the whole seed script.
