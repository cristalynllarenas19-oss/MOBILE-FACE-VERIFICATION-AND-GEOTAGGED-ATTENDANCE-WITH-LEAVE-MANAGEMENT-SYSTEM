import { decideLapse } from "./leave-lapse.util";

// Mon Sep 28 2026 is the reference Monday.
const day = (date: number, hours = 0) => new Date(2026, 8, date, hours);
const oct = (date: number, hours = 0) => new Date(2026, 9, date, hours);

const base = { startDate: day(29), endDate: day(29), graceDays: 7, attendedDates: [] as Date[] };

describe("decideLapse", () => {
  it("never lapses a request on or before its last leave day", () => {
    expect(decideLapse({ ...base, now: day(28, 9) })).toEqual({ lapse: false });
    expect(decideLapse({ ...base, now: day(29, 23) })).toEqual({ lapse: false });
  });

  it("waits out the grace period when the employee did not work the day", () => {
    expect(decideLapse({ ...base, now: day(30, 9) })).toEqual({ lapse: false });
    // Sep 29 + 7 days = Oct 6 is the last day of grace.
    expect(decideLapse({ ...base, now: oct(6, 9) })).toEqual({ lapse: false });
    expect(decideLapse({ ...base, now: oct(7, 1) })).toEqual({ lapse: true, reason: "NOT_DECIDED" });
  });

  it("lapses straight away once the date has passed if the employee worked it", () => {
    expect(decideLapse({ ...base, now: day(30, 1), attendedDates: [day(29, 8)] })).toEqual({
      lapse: true,
      reason: "REPORTED_FOR_WORK",
    });
  });

  it("only skips the grace period when every requested working day was worked", () => {
    const multiDay = { ...base, startDate: day(28), endDate: day(30) };
    expect(decideLapse({ ...multiDay, now: oct(1, 1), attendedDates: [day(28), day(29)] })).toEqual({ lapse: false });
    expect(decideLapse({ ...multiDay, now: oct(1, 1), attendedDates: [day(28), day(29), day(30)] })).toEqual({
      lapse: true,
      reason: "REPORTED_FOR_WORK",
    });
  });

  it("ignores Sundays inside the range when checking attendance", () => {
    // Sat Oct 3 – Mon Oct 5: Sunday the 4th is never a working day.
    const range = { ...base, startDate: oct(3), endDate: oct(5) };
    expect(decideLapse({ ...range, now: oct(6, 1), attendedDates: [oct(3), oct(5)] })).toEqual({
      lapse: true,
      reason: "REPORTED_FOR_WORK",
    });
  });

  it("counts the grace period from the filing day for a leave filed after its dates", () => {
    // Sick Leave for a Sep 29 absence, filed Oct 10 — long past Sep 29's grace.
    const backfiled = { ...base, filedAt: oct(10, 9) };
    expect(decideLapse({ ...backfiled, now: oct(10, 10) })).toEqual({ lapse: false });
    expect(decideLapse({ ...backfiled, now: oct(17, 9) })).toEqual({ lapse: false });
    expect(decideLapse({ ...backfiled, now: oct(18, 1) })).toEqual({ lapse: true, reason: "NOT_DECIDED" });
  });

  it("honours a zero-day grace period", () => {
    expect(decideLapse({ ...base, graceDays: 0, now: day(30, 1) })).toEqual({ lapse: true, reason: "NOT_DECIDED" });
  });
});
