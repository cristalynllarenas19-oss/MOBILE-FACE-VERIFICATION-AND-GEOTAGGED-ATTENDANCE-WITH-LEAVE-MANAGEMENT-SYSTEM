import {
  canContinueOvernightRecord,
  computeAbsenceCutoff,
  computeBreakMinutes,
  computeExpectedTimeOut,
  computeMinutesLate,
  computeMinutesOvertime,
  computeMinutesUndertime,
  computeRenderTimeIn,
  computeShiftSpanMinutes,
  defaultBreakKind,
  defaultBreakStartTime,
  isInsidePreviousDayShift,
  isOnShiftAt,
  resolveBreakKind,
  resolveBreakWindow,
  roundToInterval,
} from "./attendance-shift.util";

// All dates below are constructed in local time (new Date(y, m, d, h, mi)),
// matching how the module itself anchors every calculation to attendanceDate
// via parseTimeOnDate — so these assertions hold regardless of the machine's
// timezone.
const attendanceDate = new Date(2026, 8, 27); // Sep 27, 2026 (a Sunday, but these helpers don't care about day-off rules)

const dayShift = {
  startTime: "08:00",
  endTime: "17:00",
  lateThresholdMinutes: 10,
  undertimeThresholdMinutes: 0,
  lunchBreakMinutes: 60,
};

// Crosses midnight: 22:00 -> 07:00 the next calendar day. This is the exact
// shape of bug that shipped silently until the overtime feature surfaced it —
// see resolveShiftEndOnDate's comment in attendance-shift.util.ts.
const overnightShift = {
  startTime: "22:00",
  endTime: "07:00",
  lateThresholdMinutes: 30,
  undertimeThresholdMinutes: 0,
  lunchBreakMinutes: 60,
};

describe("computeShiftSpanMinutes", () => {
  it("computes a same-day shift's span", () => {
    expect(computeShiftSpanMinutes(dayShift)).toBe(9 * 60);
  });

  it("rolls over midnight for an overnight shift instead of going negative", () => {
    expect(computeShiftSpanMinutes(overnightShift)).toBe(9 * 60);
  });
});

describe("resolveBreakWindow / resolveBreakKind", () => {
  it("puts an 8:00-5:00 shift's break at 12:00 PM - 1:00 PM and calls it lunch", () => {
    const window = resolveBreakWindow(dayShift, attendanceDate);
    expect(window).toEqual({
      start: new Date(2026, 8, 27, 12, 0),
      end: new Date(2026, 8, 27, 13, 0),
      kind: "LUNCH",
    });
    expect(resolveBreakKind(dayShift)).toBe("LUNCH");
  });

  it("always uses the 5th hour, so a 9:00 start breaks at 1:00 PM", () => {
    const window = resolveBreakWindow({ ...dayShift, startTime: "09:00", endTime: "18:00" }, attendanceDate);
    expect(window?.start).toEqual(new Date(2026, 8, 27, 13, 0));
    expect(window?.kind).toBe("LUNCH");
  });

  it("puts an overnight shift's break in its 5th hour and calls it a break, not lunch", () => {
    const window = resolveBreakWindow(overnightShift, attendanceDate);
    expect(window).toEqual({
      start: new Date(2026, 8, 28, 2, 0),
      end: new Date(2026, 8, 28, 3, 0),
      kind: "BREAK",
    });
    expect(resolveBreakKind(overnightShift)).toBe("BREAK");
  });

  it("calls an evening shift's break a break", () => {
    const window = resolveBreakWindow({ ...dayShift, startTime: "14:00", endTime: "22:00" }, attendanceDate);
    expect(window?.start).toEqual(new Date(2026, 8, 27, 18, 0));
    expect(window?.kind).toBe("BREAK");
  });

  it("has no window when the shift has no break configured or is too short", () => {
    expect(resolveBreakWindow({ ...dayShift, lunchBreakMinutes: 0 }, attendanceDate)).toBeNull();
    expect(resolveBreakWindow({ ...dayShift, endTime: "12:30" }, attendanceDate)).toBeNull();
  });

  it("defaults to lunch when there is no shift", () => {
    expect(resolveBreakKind(null)).toBe("LUNCH");
  });

  it("uses the break time and type saved on the shift over the defaults", () => {
    const shift = { ...dayShift, breakStartTime: "11:30", breakKind: "BREAK" };
    expect(resolveBreakWindow(shift, attendanceDate)).toEqual({
      start: new Date(2026, 8, 27, 11, 30),
      end: new Date(2026, 8, 27, 12, 30),
      kind: "BREAK",
    });
  });

  it("places a saved after-midnight break on the next calendar day of an overnight shift", () => {
    const shift = { ...overnightShift, breakStartTime: "01:00", breakKind: "BREAK" };
    expect(resolveBreakWindow(shift, attendanceDate)?.start).toEqual(new Date(2026, 8, 28, 1, 0));
  });

  it("has no window when the saved break falls outside the shift", () => {
    expect(resolveBreakWindow({ ...dayShift, breakStartTime: "18:00" }, attendanceDate)).toBeNull();
  });

  it("derives the default break from the shift start", () => {
    expect(defaultBreakStartTime("08:00")).toBe("12:00");
    expect(defaultBreakStartTime("22:00")).toBe("02:00");
    expect(defaultBreakKind("12:00")).toBe("LUNCH");
    expect(defaultBreakKind("02:00")).toBe("BREAK");
  });
});

describe("isOnShiftAt", () => {
  const weekdays = [1, 2, 3, 4, 5];
  // Mon Sep 28 2026 … Sat Oct 3 2026.
  const at = (date: number, hours: number, minutes = 0) => new Date(2026, 8, date, hours, minutes);

  it("is on shift between a day shift's start and end on a working day", () => {
    expect(isOnShiftAt(dayShift, weekdays, at(28, 8, 0))).toBe(true);
    expect(isOnShiftAt(dayShift, weekdays, at(28, 16, 59))).toBe(true);
  });

  it("is off shift before start, at/after end, and on a non-working day", () => {
    expect(isOnShiftAt(dayShift, weekdays, at(28, 7, 59))).toBe(false);
    expect(isOnShiftAt(dayShift, weekdays, at(28, 17, 0))).toBe(false);
    expect(isOnShiftAt(dayShift, weekdays, at(28, 23, 0))).toBe(false);
    expect(isOnShiftAt(dayShift, weekdays, new Date(2026, 9, 3, 10, 0))).toBe(false); // Saturday
  });

  it("counts the after-midnight half of an overnight shift that began on a working day", () => {
    expect(isOnShiftAt(overnightShift, weekdays, at(28, 23, 0))).toBe(true);
    expect(isOnShiftAt(overnightShift, weekdays, at(29, 2, 0))).toBe(true);
    expect(isOnShiftAt(overnightShift, weekdays, at(29, 7, 0))).toBe(false);
    // Friday night's shift runs into Saturday morning even though Saturday isn't a working day…
    expect(isOnShiftAt(overnightShift, weekdays, new Date(2026, 9, 3, 2, 0))).toBe(true);
    // …but Saturday night has no shift.
    expect(isOnShiftAt(overnightShift, weekdays, new Date(2026, 9, 3, 23, 0))).toBe(false);
  });
});

describe("overnight shift day resolution", () => {
  it("treats the after-midnight part of an overnight shift as the previous day's shift", () => {
    expect(isInsidePreviousDayShift(overnightShift, new Date(2026, 8, 28, 2, 0))).toBe(true);
    expect(isInsidePreviousDayShift(overnightShift, new Date(2026, 8, 28, 6, 59))).toBe(true);
  });

  it("stops once that shift has ended, and never applies before midnight", () => {
    expect(isInsidePreviousDayShift(overnightShift, new Date(2026, 8, 28, 7, 0))).toBe(false);
    expect(isInsidePreviousDayShift(overnightShift, new Date(2026, 8, 28, 22, 30))).toBe(false);
  });

  it("never applies to a daytime shift", () => {
    expect(isInsidePreviousDayShift(dayShift, new Date(2026, 8, 28, 2, 0))).toBe(false);
    expect(canContinueOvernightRecord(dayShift, attendanceDate, new Date(2026, 8, 28, 2, 0))).toBe(false);
  });

  it("keeps an open overnight record closable through the shift and a late time out", () => {
    expect(canContinueOvernightRecord(overnightShift, attendanceDate, new Date(2026, 8, 28, 2, 0))).toBe(true);
    expect(canContinueOvernightRecord(overnightShift, attendanceDate, new Date(2026, 8, 28, 9, 0))).toBe(true);
  });

  it("hands over to the next shift's Time In once that is the closer one", () => {
    // 22:00-07:00: halfway between 07:00 end and the next 22:00 start is 14:30.
    expect(canContinueOvernightRecord(overnightShift, attendanceDate, new Date(2026, 8, 28, 14, 29))).toBe(true);
    expect(canContinueOvernightRecord(overnightShift, attendanceDate, new Date(2026, 8, 28, 14, 30))).toBe(false);
    expect(canContinueOvernightRecord(overnightShift, attendanceDate, new Date(2026, 8, 28, 21, 50))).toBe(false);
  });
});

describe("computeBreakMinutes", () => {
  const at = (hours: number, minutes = 0) => new Date(2026, 8, 27, hours, minutes);

  it("deducts the full scheduled lunch for a full day with no punches", () => {
    expect(computeBreakMinutes(dayShift, attendanceDate, at(8), at(17))).toBe(60);
  });

  it("deducts nothing when timing out before lunch starts", () => {
    expect(computeBreakMinutes(dayShift, attendanceDate, at(8), at(10))).toBe(0);
  });

  it("deducts only the part of lunch already reached when timing out mid-lunch", () => {
    expect(computeBreakMinutes(dayShift, attendanceDate, at(8), at(12, 20))).toBe(20);
  });

  it("deducts nothing when timing in after lunch has ended", () => {
    expect(computeBreakMinutes(dayShift, attendanceDate, at(13, 30), at(17))).toBe(0);
  });

  it("uses the measured duration when both punches exist, shorter or longer", () => {
    expect(
      computeBreakMinutes(dayShift, attendanceDate, at(8), at(17), { lunchOutAt: at(12), lunchInAt: at(12, 30) }),
    ).toBe(30);
    expect(
      computeBreakMinutes(dayShift, attendanceDate, at(8), at(17), { lunchOutAt: at(12), lunchInAt: at(15) }),
    ).toBe(180);
  });

  it("deducts the scheduled length when the break was started but never ended", () => {
    expect(
      computeBreakMinutes(dayShift, attendanceDate, at(8), at(17), { lunchOutAt: at(12), lunchInAt: null }),
    ).toBe(60);
  });

  it("never deducts more than the time between an unended Start punch and Time Out", () => {
    expect(
      computeBreakMinutes(dayShift, attendanceDate, at(8), at(12, 15), { lunchOutAt: at(12), lunchInAt: null }),
    ).toBe(15);
  });

  it("deducts an overnight shift's 5th-hour break", () => {
    const timeIn = new Date(2026, 8, 27, 22, 0);
    const timeOut = new Date(2026, 8, 28, 7, 0);
    expect(computeBreakMinutes(overnightShift, attendanceDate, timeIn, timeOut)).toBe(60);
  });
});

describe("computeAbsenceCutoff / computeMinutesLate", () => {
  it("is not late when arriving within the grace period", () => {
    const arrival = new Date(2026, 8, 27, 8, 10); // exactly at the 10-min threshold
    expect(computeMinutesLate(dayShift, arrival, attendanceDate)).toBe(0);
  });

  it("counts minutes late past the grace period", () => {
    const arrival = new Date(2026, 8, 27, 8, 25);
    expect(computeMinutesLate(dayShift, arrival, attendanceDate)).toBe(15);
  });

  it("cutoff is shift start plus the late threshold", () => {
    const cutoff = computeAbsenceCutoff(dayShift, attendanceDate);
    expect(cutoff.getHours()).toBe(8);
    expect(cutoff.getMinutes()).toBe(10);
  });
});

describe("computeRenderTimeIn", () => {
  it("renders an on-time or early arrival as exact shift start", () => {
    const early = new Date(2026, 8, 27, 7, 45);
    expect(computeRenderTimeIn(dayShift, early, attendanceDate)).toEqual(new Date(2026, 8, 27, 8, 0));
  });

  it("bumps a late arrival up to the next 30-minute mark", () => {
    const arrival = new Date(2026, 8, 27, 8, 1);
    expect(computeRenderTimeIn(dayShift, arrival, attendanceDate)).toEqual(new Date(2026, 8, 27, 8, 30));
  });

  it("ignores capture seconds so an on-the-dot arrival doesn't get bumped", () => {
    const arrival = new Date(2026, 8, 27, 8, 0, 5); // 08:00:05
    expect(computeRenderTimeIn(dayShift, arrival, attendanceDate)).toEqual(new Date(2026, 8, 27, 8, 0));
  });
});

describe("computeExpectedTimeOut", () => {
  it("uses the shift's own span when a shift is given", () => {
    const renderTimeIn = new Date(2026, 8, 27, 8, 0);
    expect(computeExpectedTimeOut(renderTimeIn, dayShift)).toEqual(new Date(2026, 8, 27, 17, 0));
  });

  it("rolls over correctly for an overnight shift's expected time out", () => {
    const renderTimeIn = new Date(2026, 8, 27, 22, 0);
    expect(computeExpectedTimeOut(renderTimeIn, overnightShift)).toEqual(new Date(2026, 8, 28, 7, 0));
  });

  it("falls back to a flat 9h span when no shift is given", () => {
    const renderTimeIn = new Date(2026, 8, 27, 8, 0);
    expect(computeExpectedTimeOut(renderTimeIn)).toEqual(new Date(2026, 8, 27, 17, 0));
  });
});

describe("computeMinutesUndertime", () => {
  it("is zero when leaving exactly at shift end", () => {
    const departure = new Date(2026, 8, 27, 17, 0);
    expect(computeMinutesUndertime(dayShift, departure, attendanceDate)).toBe(0);
  });

  it("counts minutes short of shift end", () => {
    const departure = new Date(2026, 8, 27, 16, 30);
    expect(computeMinutesUndertime(dayShift, departure, attendanceDate)).toBe(30);
  });

  // Regression guard for the midnight-crossing bug: before resolveShiftEndOnDate,
  // shiftEnd was computed as 07:00 on the SAME day as attendanceDate (in the
  // past relative to a real overnight departure), so undertime silently never
  // fired for any overnight shift.
  it("resolves the overnight shift's end on the correct calendar day", () => {
    const departure = new Date(2026, 8, 28, 6, 0); // left an hour early, next calendar day
    expect(computeMinutesUndertime(overnightShift, departure, attendanceDate)).toBe(60);
  });

  it("is zero for a full overnight shift completed on time", () => {
    const departure = new Date(2026, 8, 28, 7, 0);
    expect(computeMinutesUndertime(overnightShift, departure, attendanceDate)).toBe(0);
  });
});

describe("computeMinutesOvertime", () => {
  it("is zero when leaving exactly at shift end", () => {
    const departure = new Date(2026, 8, 27, 17, 0);
    expect(computeMinutesOvertime(dayShift, departure, attendanceDate)).toBe(0);
  });

  it("counts minutes worked past shift end", () => {
    const departure = new Date(2026, 8, 27, 18, 15);
    expect(computeMinutesOvertime(dayShift, departure, attendanceDate)).toBe(75);
  });

  // Same regression concern as undertime above, but in the direction that
  // would have been far more damaging: without the fix, this would compute
  // against a shiftEnd nearly 24h in the past and report a huge false
  // overtime total every single night for this shift.
  it("resolves the overnight shift's end on the correct calendar day", () => {
    const departure = new Date(2026, 8, 28, 7, 30);
    expect(computeMinutesOvertime(overnightShift, departure, attendanceDate)).toBe(30);
  });

  it("is zero for a full overnight shift completed on time", () => {
    const departure = new Date(2026, 8, 28, 7, 0);
    expect(computeMinutesOvertime(overnightShift, departure, attendanceDate)).toBe(0);
  });
});

describe("roundToInterval", () => {
  it("passes a date through unchanged when interval is 0 or 1", () => {
    const date = new Date(2026, 8, 27, 8, 7);
    expect(roundToInterval(date, 0)).toBe(date);
    expect(roundToInterval(date, 1)).toBe(date);
  });

  it("rounds to the nearest interval", () => {
    const date = new Date(2026, 8, 27, 8, 7); // nearer to 08:00 than 08:15
    expect(roundToInterval(date, 15)).toEqual(new Date(2026, 8, 27, 8, 0));

    const date2 = new Date(2026, 8, 27, 8, 8); // nearer to 08:15 than 08:00
    expect(roundToInterval(date2, 15)).toEqual(new Date(2026, 8, 27, 8, 15));
  });
});
