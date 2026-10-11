import { resolveMissedDays } from "./attendance-missed-days.util";

// Week of Mon Sep 28 – Sun Oct 4, 2026.
const day = (date: number, hours = 0, minutes = 0) => new Date(2026, 8, date, hours, minutes);

const schedule = {
  startsOn: new Date(2026, 0, 1),
  endsOn: null,
  workingDays: [1, 2, 3, 4, 5],
  shift: { startTime: "08:00", endTime: "17:00", lateThresholdMinutes: 15 },
};

const base = {
  windowStart: day(28),
  now: day(30, 18, 0), // Wednesday evening
  hireDate: new Date(2025, 0, 1),
  recordedDates: [] as Date[],
  leaves: [] as { startDate: Date; endDate: Date; leaveTypeName: string; approved: boolean }[],
  schedules: [schedule],
};

// Drops the scheduled-shift detail each row carries, so the assertions below
// stay about which days come back and why.
const resolve = (params: Parameters<typeof resolveMissedDays>[0]) =>
  resolveMissedDays(params).map(({ shift: _shift, ...row }) => row);

describe("resolveMissedDays", () => {
  it("carries the scheduled shift on each rebuilt day", () => {
    expect(resolveMissedDays({ ...base, windowStart: day(30) })).toEqual([
      { date: day(30), status: "ABSENT", shift: schedule.shift },
    ]);
  });

  it("marks a scheduled working day with no record as absent", () => {
    expect(resolve(base)).toEqual([
      { date: day(28), status: "ABSENT" },
      { date: day(29), status: "ABSENT" },
      { date: day(30), status: "ABSENT" },
    ]);
  });

  it("skips days that already have an attendance record", () => {
    const result = resolve({ ...base, recordedDates: [day(29, 8, 3)] });
    expect(result.map((r) => r.date)).toEqual([day(28), day(30)]);
  });

  it("shows approved leave instead of absent, with the leave type", () => {
    const result = resolve({
      ...base,
      leaves: [{ startDate: day(28), endDate: day(29), leaveTypeName: "Vacation Leave", approved: true }],
    });
    expect(result).toEqual([
      { date: day(28), status: "ON_LEAVE", leaveTypeName: "Vacation Leave" },
      { date: day(29), status: "ON_LEAVE", leaveTypeName: "Vacation Leave" },
      { date: day(30), status: "ABSENT" },
    ]);
  });

  it("shows a leave still awaiting a decision as pending, not absent", () => {
    const result = resolve({
      ...base,
      leaves: [{ startDate: day(29), endDate: day(29), leaveTypeName: "Sick Leave", approved: false }],
    });
    expect(result).toEqual([
      { date: day(28), status: "ABSENT" },
      { date: day(29), status: "LEAVE_PENDING", leaveTypeName: "Sick Leave" },
      { date: day(30), status: "ABSENT" },
    ]);
  });

  it("produces nothing on non-working days, even inside a leave range", () => {
    const result = resolve({
      ...base,
      windowStart: new Date(2026, 9, 2), // Fri Oct 2
      now: new Date(2026, 9, 5, 18, 0), // Mon Oct 5
      leaves: [{ startDate: new Date(2026, 9, 2), endDate: new Date(2026, 9, 5), leaveTypeName: "Sick Leave", approved: true }],
    });
    expect(result.map((r) => r.date)).toEqual([new Date(2026, 9, 2), new Date(2026, 9, 5)]);
  });

  it("does not mark today absent until the shift's absence cutoff has passed", () => {
    const before = resolve({ ...base, windowStart: day(30), now: day(30, 8, 10) });
    expect(before).toEqual([]);
    const after = resolve({ ...base, windowStart: day(30), now: day(30, 8, 15) });
    expect(after).toEqual([{ date: day(30), status: "ABSENT" }]);
  });

  it("never marks a day absent before the hire date or without a schedule", () => {
    expect(resolve({ ...base, hireDate: day(30) }).map((r) => r.date)).toEqual([day(30)]);
    expect(resolve({ ...base, schedules: [] })).toEqual([]);
    expect(
      resolve({ ...base, schedules: [{ ...schedule, startsOn: day(29) }] }).map((r) => r.date),
    ).toEqual([day(29), day(30)]);
  });
});
