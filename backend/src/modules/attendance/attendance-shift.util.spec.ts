import {
  computeAbsenceCutoff,
  computeExpectedTimeOut,
  computeMinutesLate,
  computeMinutesOvertime,
  computeMinutesUndertime,
  computeRenderTimeIn,
  computeShiftSpanMinutes,
  computeTotalBreakMinutes,
  findBestMatchingShift,
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
  morningBreakMinutes: 15,
  afternoonBreakMinutes: 15,
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
  morningBreakMinutes: 15,
  afternoonBreakMinutes: 15,
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

describe("computeTotalBreakMinutes", () => {
  it("falls back to the shift's flat lunch minutes when no lunch punch exists", () => {
    expect(computeTotalBreakMinutes(dayShift)).toBe(15 + 15 + 60);
  });

  it("falls back to flat lunch minutes when the lunch punch is incomplete (no Lunch In)", () => {
    const result = computeTotalBreakMinutes(dayShift, {
      lunchOutAt: new Date(2026, 8, 27, 12, 0),
      lunchInAt: null,
    });
    expect(result).toBe(15 + 15 + 60);
  });

  it("credits a shorter-than-scheduled measured lunch", () => {
    const result = computeTotalBreakMinutes(dayShift, {
      lunchOutAt: new Date(2026, 8, 27, 12, 0),
      lunchInAt: new Date(2026, 8, 27, 12, 30), // 30 real minutes, not the flat 60
    });
    expect(result).toBe(15 + 15 + 30);
  });

  it("charges a longer-than-scheduled measured lunch, uncapped", () => {
    const result = computeTotalBreakMinutes(dayShift, {
      lunchOutAt: new Date(2026, 8, 27, 12, 0),
      lunchInAt: new Date(2026, 8, 27, 15, 0), // 3 real hours, not the flat 60 min
    });
    expect(result).toBe(15 + 15 + 180);
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

describe("findBestMatchingShift", () => {
  const shiftA = { id: "a", startTime: "08:00", endTime: "17:00", lateThresholdMinutes: 10 };
  const shiftB = { id: "b", startTime: "09:00", endTime: "18:00", lateThresholdMinutes: 10 };

  it("returns null when no candidate's window covers the arrival", () => {
    const arrival = new Date(2026, 8, 27, 20, 0);
    expect(findBestMatchingShift([shiftA, shiftB], arrival, attendanceDate)).toBeNull();
  });

  it("picks the candidate whose start is closest to (but not after) the arrival", () => {
    // 09:05 falls within both A's (08:00-08:10 grace... no, past it) and B's window.
    // A's cutoff is 08:10, so only B's 09:00-09:10 window actually covers 09:05.
    const arrival = new Date(2026, 8, 27, 9, 5);
    const best = findBestMatchingShift([shiftA, shiftB], arrival, attendanceDate);
    expect(best?.id).toBe("b");
  });

  it("prefers the later-starting shift when both windows cover the arrival", () => {
    const shiftC = { id: "c", startTime: "08:50", endTime: "17:50", lateThresholdMinutes: 20 };
    // 09:05 is within A's 08:00+20=08:20 grace? No — still only C (08:50-09:10) and B (09:00-09:10) cover it.
    const arrival = new Date(2026, 8, 27, 9, 5);
    const best = findBestMatchingShift([shiftC, shiftB], arrival, attendanceDate);
    expect(best?.id).toBe("b"); // B starts later (09:00) than C (08:50)
  });
});
