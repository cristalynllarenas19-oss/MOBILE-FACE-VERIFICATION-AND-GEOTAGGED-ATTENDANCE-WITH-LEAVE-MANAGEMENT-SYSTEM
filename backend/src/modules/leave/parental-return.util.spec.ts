import {
  MATERNITY_ENDING_NOTICE_DAYS,
  PATERNITY_ENDING_NOTICE_DAYS,
  employeeEndingNoticeDue,
  extensionReminderDue,
  findReturnDay,
  lastParentalLeaveDay,
  parentalNoticeDue,
} from "./parental-return.util";

// Mon Oct 5 2026 is the reference Monday.
const oct = (date: number, hours = 0) => new Date(2026, 9, date, hours);
const nov = (date: number, hours = 0) => new Date(2026, 10, date, hours);
const monToFri = () => [1, 2, 3, 4, 5];
const monToSat = () => [1, 2, 3, 4, 5, 6];

describe("lastParentalLeaveDay", () => {
  it("is the request's own end date unless an extension was approved", () => {
    expect(lastParentalLeaveDay(oct(9, 8), null, 30)).toEqual(oct(9));
    expect(lastParentalLeaveDay(oct(9, 8), false, 30)).toEqual(oct(9));
    expect(lastParentalLeaveDay(oct(9, 8), true, 30)).toEqual(nov(8));
  });
});

describe("findReturnDay", () => {
  it("is the next day when that is a working day", () => {
    expect(findReturnDay(oct(7), monToFri, [])).toEqual({ returnDate: oct(8), continuesAsParental: false });
  });

  it("skips the employee's rest days and the company-wide Sunday", () => {
    // Fri Oct 9 -> Mon Oct 12 on a Mon-Fri schedule.
    expect(findReturnDay(oct(9), monToFri, []).returnDate).toEqual(oct(12));
    // A Mon-Sat schedule still never works Sunday: Sat Oct 10 -> Mon Oct 12.
    expect(findReturnDay(oct(9), monToSat, []).returnDate).toEqual(oct(10));
    expect(findReturnDay(oct(10), monToSat, []).returnDate).toEqual(oct(12));
  });

  it("treats an employee with no schedule as working every day but Sunday", () => {
    expect(findReturnDay(oct(9), () => undefined, []).returnDate).toEqual(oct(10));
  });

  it("skips other approved leave that follows straight on", () => {
    const vacation = { startDate: oct(12), endDate: oct(14), isParental: false };
    expect(findReturnDay(oct(9), monToFri, [vacation])).toEqual({ returnDate: oct(15), continuesAsParental: false });
  });

  it("flags a leave that continues as another parental leave request", () => {
    // e.g. Added Paternity Leave starting the Monday after Paternity Leave.
    const addedPaternity = { startDate: oct(12), endDate: oct(16), isParental: true };
    expect(findReturnDay(oct(9), monToFri, [addedPaternity]).continuesAsParental).toBe(true);
  });

  it("does not flag a later parental leave with working days in between", () => {
    const later = { startDate: oct(13), endDate: oct(20), isParental: true };
    expect(findReturnDay(oct(7), monToFri, [later])).toEqual({ returnDate: oct(8), continuesAsParental: false });
  });
});

describe("parentalNoticeDue", () => {
  // Maternity leave Sep 1 - Fri Oct 16, back Mon Oct 19.
  const maternity = {
    startDate: new Date(2026, 8, 1),
    lastLeaveDay: oct(16),
    returnDate: oct(19),
    noticeDays: MATERNITY_ENDING_NOTICE_DAYS,
  };

  it("sends nothing before the notice window", () => {
    expect(parentalNoticeDue({ ...maternity, now: oct(8, 23) })).toBeNull();
  });

  it("sends the ending notice during the window, up to the day before the return", () => {
    expect(parentalNoticeDue({ ...maternity, now: oct(9, 0) })).toEqual({ kind: "ENDING", windowStart: oct(9) });
    expect(parentalNoticeDue({ ...maternity, now: oct(16, 12) })).toEqual({ kind: "ENDING", windowStart: oct(9) });
    // The Saturday between the last leave day and the return day.
    expect(parentalNoticeDue({ ...maternity, now: oct(17, 12) })).toEqual({ kind: "ENDING", windowStart: oct(9) });
  });

  it("sends the return notice the day before the return, then again on the day (late within the catch-up window)", () => {
    expect(parentalNoticeDue({ ...maternity, now: oct(18, 0) })).toEqual({ kind: "RETURN", windowStart: oct(18), daysUntilReturn: 1 });
    // Its own window, so the day-before notice doesn't count as this one.
    expect(parentalNoticeDue({ ...maternity, now: oct(19, 9) })).toEqual({ kind: "RETURN", windowStart: oct(19), daysUntilReturn: 0 });
    expect(parentalNoticeDue({ ...maternity, now: oct(26, 9) })).toEqual({ kind: "RETURN", windowStart: oct(19), daysUntilReturn: -7 });
    expect(parentalNoticeDue({ ...maternity, now: oct(27, 0) })).toBeNull();
  });

  it("gives a week-long paternity leave the shorter notice, not one on its first day", () => {
    // Paternity leave Mon Oct 5 - Sun Oct 11, back Mon Oct 12.
    const paternity = { startDate: oct(5), lastLeaveDay: oct(11), returnDate: oct(12), noticeDays: PATERNITY_ENDING_NOTICE_DAYS };
    expect(parentalNoticeDue({ ...paternity, now: oct(5, 9) })).toBeNull();
    expect(parentalNoticeDue({ ...paternity, now: oct(8, 0) })).toEqual({ kind: "ENDING", windowStart: oct(8) });
    expect(parentalNoticeDue({ ...paternity, now: oct(11, 7) })).toEqual({ kind: "RETURN", windowStart: oct(11), daysUntilReturn: 1 });
  });

  it("skips the ending notice for a short leave that hasn't started yet", () => {
    expect(
      parentalNoticeDue({ startDate: oct(14), lastLeaveDay: oct(16), returnDate: oct(19), noticeDays: 7, now: oct(12) }),
    ).toBeNull();
  });
});

describe("extensionReminderDue", () => {
  // Maternity leave ending Thu Dec 31 2026 — the extension must be asked for
  // by Mon Nov 16, 45 days earlier. Early reminder from Mon Nov 9, final one
  // on Nov 16 itself.
  const endDate = new Date(2026, 11, 31, 8);

  it("sends nothing before the week leading up to the deadline", () => {
    expect(extensionReminderDue({ endDate, now: nov(8, 23) })).toBeNull();
  });

  it("is due early from a week before the deadline, up to the day before", () => {
    expect(extensionReminderDue({ endDate, now: nov(9, 0) })).toEqual({ deadline: nov(16), windowStart: nov(9), daysLeft: 7 });
    expect(extensionReminderDue({ endDate, now: nov(15, 23) })).toEqual({ deadline: nov(16), windowStart: nov(9), daysLeft: 1 });
  });

  it("is due again, in its own window, on the deadline itself — 45 days before the leave ends", () => {
    expect(extensionReminderDue({ endDate, now: nov(16, 0) })).toEqual({ deadline: nov(16), windowStart: nov(16), daysLeft: 0 });
    expect(extensionReminderDue({ endDate, now: nov(16, 23) })).toEqual({ deadline: nov(16), windowStart: nov(16), daysLeft: 0 });
  });

  it("is no longer due once the deadline has passed", () => {
    expect(extensionReminderDue({ endDate, now: nov(17, 0) })).toBeNull();
  });
});

describe("employeeEndingNoticeDue", () => {
  // Paternity leave Mon Oct 5 - Sun Oct 11.
  const paternity = { startDate: oct(5), lastLeaveDay: oct(11, 8) };

  it("sends nothing before the day before the last leave day", () => {
    expect(employeeEndingNoticeDue({ ...paternity, now: oct(9, 23) })).toBeNull();
  });

  it("is due the day before the last leave day, or on it if that was missed", () => {
    expect(employeeEndingNoticeDue({ ...paternity, now: oct(10, 0) })).toEqual({ windowStart: oct(10), daysUntilEnd: 1 });
    expect(employeeEndingNoticeDue({ ...paternity, now: oct(11, 20) })).toEqual({ windowStart: oct(10), daysUntilEnd: 0 });
  });

  it("is no longer due once the leave is over, or before it has started", () => {
    expect(employeeEndingNoticeDue({ ...paternity, now: oct(12, 0) })).toBeNull();
    expect(employeeEndingNoticeDue({ startDate: oct(11), lastLeaveDay: oct(11), now: oct(10) })).toBeNull();
  });
});
