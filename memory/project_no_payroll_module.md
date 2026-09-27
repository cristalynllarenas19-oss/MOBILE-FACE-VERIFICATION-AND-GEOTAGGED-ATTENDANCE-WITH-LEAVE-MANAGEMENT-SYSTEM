---
name: project-no-payroll-module
description: System only records attendance/DTR data, no payroll/disbursement processing exists or is planned
metadata:
  type: project
---

This system computes and stores attendance numbers (totalMinutes, lateMinutes, undertimeMinutes, overtimeMinutes) purely for DTR recording — it does not process payroll, calculate wages, or disburse pay. There is no payroll module anywhere in the codebase.

**Why:** User confirmed this directly when I described a fix as "affecting pay" — corrected that terminology since nothing here pays anyone; the numbers just feed some other process (manual payroll, spreadsheet, etc.) outside this system.

**How to apply:** Don't describe attendance/hours calculations as affecting "pay" or "payroll" — describe them as affecting the recorded/computed DTR numbers instead. Related: [[feedback_out_of_scope_features]] (holiday pay, night differential are out of scope for the same reason — this isn't a payroll-compliance system).
