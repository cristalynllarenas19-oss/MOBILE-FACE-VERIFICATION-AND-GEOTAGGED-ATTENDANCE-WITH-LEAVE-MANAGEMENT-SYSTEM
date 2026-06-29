// Field technicians (and the field side of BOTH-mode employees) can have
// several AttendanceRecord rows for the same day (one per site visit), and a
// BOTH employee can additionally have a separate OFFICE-type record on that
// same day. Any metric that counts *employees* (present/late/absent tallies,
// department breakdowns) must first collapse same-day rows down to one
// representative per employee, or a multi-record day gets counted more than
// once for what is really a single employee. The representative is whichever
// row started most recently — comparing by timeInAt rather than visitNumber,
// since visitNumber is scoped per recordType and an OFFICE record and a FIELD
// record sharing the same day can both be visitNumber 1 without being related.
// Row/event-level metrics (raw record counts, hours-rendered totals, per-visit
// displays) must NOT use this — every record should stay visible there.
export function dedupeToLatestVisitPerEmployeeDay<
  T extends { employeeId: string; attendanceDate: Date; timeInAt: Date | null },
>(records: T[]): T[] {
  const latest = new Map<string, T>();
  for (const record of records) {
    const key = `${record.employeeId}_${record.attendanceDate.toDateString()}`;
    const existing = latest.get(key);
    const recordTime = record.timeInAt?.getTime() ?? 0;
    const existingTime = existing?.timeInAt?.getTime() ?? -1;
    if (!existing || recordTime > existingTime) {
      latest.set(key, record);
    }
  }
  return [...latest.values()];
}
