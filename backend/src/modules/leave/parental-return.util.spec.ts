import {
  MATERNITY_ENDING_NOTICE_DAYS,
  PATERNITY_ENDING_NOTICE_DAYS,
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
    expect(lastParentalLeaveDay(oct(9, 8), null)).toEqual(oct(9));
    expect(lastParentalLeaveDay(oct(9, 8), false)).toEqual(oct(9));
    expect(lastParentalLeaveDay(oct(9, 8), true)).toEqual(nov(8));
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

  it("sends the ending notice during the window, up to the return day", () => {
    expect(parentalNoticeDue({ ...maternity, now: oct(9, 0) })).toEqual({ kind: "ENDING", windowStart: oct(9) });
    expect(parentalNoticeDue({ ...maternity, now: oct(16, 12) })).toEqual({ kind: "ENDING", windowStart: oct(9) });
    // The weekend between the last leave day and the return day.
    expect(parentalNoticeDue({ ...maternity, now: oct(18, 12) })).toEqual({ kind: "ENDING", windowStart: oct(9) });
  });

  it("sends the return notice from the return day, late within the catch-up window", () => {
    expect(parentalNoticeDue({ ...maternity, now: oct(19, 0) })).toEqual({ kind: "RETURN", windowStart: oct(19), late: false });
    expect(parentalNoticeDue({ ...maternity, now: oct(26, 9) })).toEqual({ kind: "RETURN", windowStart: oct(19), late: true });
    expect(parentalNoticeDue({ ...maternity, now: oct(27, 0) })).toBeNull();
  });

  it("gives a week-long paternity leave the shorter notice, not one on its first day", () => {
    // Paternity leave Mon Oct 5 - Sun Oct 11, back Mon Oct 12.
    const paternity = { startDate: oct(5), lastLeaveDay: oct(11), returnDate: oct(12), noticeDays: PATERNITY_ENDING_NOTICE_DAYS };
    expect(parentalNoticeDue({ ...paternity, now: oct(5, 9) })).toBeNull();
    expect(parentalNoticeDue({ ...paternity, now: oct(8, 0) })).toEqual({ kind: "ENDING", windowStart: oct(8) });
    expect(parentalNoticeDue({ ...paternity, now: oct(12, 7) })).toEqual({ kind: "RETURN", windowStart: oct(12), late: false });
  });

  it("skips the ending notice for a short leave that hasn't started yet", () => {
    expect(
      parentalNoticeDue({ startDate: oct(14), lastLeaveDay: oct(16), returnDate: oct(19), noticeDays: 7, now: oct(12) }),
    ).toBeNull();
  });
});
