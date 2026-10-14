import { AttendanceService } from "./attendance.service";

// Covers which calendar day an OFFICE scan is filed under — the piece that
// lets an overnight shift's break punches and Time Out land on the record
// its Time In opened the evening before.
describe("AttendanceService.resolveOfficeAttendanceDate", () => {
  const overnightShift = { startTime: "22:00", endTime: "07:00", lateThresholdMinutes: 0 };
  const dayShift = { startTime: "08:00", endTime: "17:00", lateThresholdMinutes: 0 };
  const everyDay = [1, 2, 3, 4, 5, 6];

  // Mon Sep 28 2026 is the shift's start day; Tue Sep 29 is "the morning after".
  const monday = new Date(2026, 8, 28);
  const tuesday = new Date(2026, 8, 29);

  let prisma: any;
  let service: any;

  beforeEach(() => {
    prisma = {
      attendanceRecord: { findFirst: jest.fn().mockResolvedValue(null) },
      employeeSchedule: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    service = new AttendanceService(prisma, {} as any, {} as any, {} as any, {} as any);
  });

  const resolve = (now: Date) => service.resolveOfficeAttendanceDate("EMP-1", now) as Promise<Date>;

  it("files a scan before midnight under today", async () => {
    prisma.employeeSchedule.findFirst.mockResolvedValue({ shift: overnightShift, workingDays: everyDay });
    expect(await resolve(new Date(2026, 8, 28, 22, 5))).toEqual(monday);
  });

  it("files an after-midnight break or Time Out under the day the shift started", async () => {
    prisma.attendanceRecord.findFirst.mockResolvedValue({
      timeInAt: new Date(2026, 8, 28, 22, 0),
      timeOutAt: null,
      shift: overnightShift,
    });
    prisma.employeeSchedule.findFirst.mockResolvedValue({ shift: overnightShift, workingDays: everyDay });

    expect(await resolve(new Date(2026, 8, 29, 2, 0))).toEqual(monday);
    expect(await resolve(new Date(2026, 8, 29, 7, 0))).toEqual(monday);
  });

  it("still closes last night's record on a late Time Out after the shift ended", async () => {
    prisma.attendanceRecord.findFirst.mockResolvedValue({
      timeInAt: new Date(2026, 8, 28, 22, 0),
      timeOutAt: null,
      shift: overnightShift,
    });
    prisma.employeeSchedule.findFirst.mockResolvedValue({ shift: overnightShift, workingDays: everyDay });
    expect(await resolve(new Date(2026, 8, 29, 9, 30))).toEqual(monday);
  });

  it("treats a scan near the next shift as tonight's Time In even if last night was never timed out", async () => {
    prisma.attendanceRecord.findFirst.mockResolvedValue({
      timeInAt: new Date(2026, 8, 28, 22, 0),
      timeOutAt: null,
      shift: overnightShift,
    });
    prisma.employeeSchedule.findFirst.mockResolvedValue({ shift: overnightShift, workingDays: everyDay });
    expect(await resolve(new Date(2026, 8, 29, 21, 50))).toEqual(tuesday);
  });

  it("files a first scan made after midnight as a late Time In for last night's shift", async () => {
    prisma.employeeSchedule.findFirst.mockResolvedValue({ shift: overnightShift, workingDays: everyDay });
    expect(await resolve(new Date(2026, 8, 29, 0, 30))).toEqual(monday);
  });

  it("does not reach back to a day the employee wasn't scheduled to work", async () => {
    // Tue-Sat only: Monday night isn't theirs, so 12:30 AM Tuesday is just Tuesday.
    prisma.employeeSchedule.findFirst.mockResolvedValue({ shift: overnightShift, workingDays: [2, 3, 4, 5, 6] });
    expect(await resolve(new Date(2026, 8, 29, 0, 30))).toEqual(tuesday);
  });

  it("starts a new day once last night's shift is finished and timed out", async () => {
    prisma.attendanceRecord.findFirst.mockResolvedValue({
      timeInAt: new Date(2026, 8, 28, 22, 0),
      timeOutAt: new Date(2026, 8, 29, 7, 0),
      shift: overnightShift,
    });
    prisma.employeeSchedule.findFirst.mockResolvedValue({ shift: overnightShift, workingDays: everyDay });
    expect(await resolve(new Date(2026, 8, 29, 8, 0))).toEqual(tuesday);
  });

  it("never carries a daytime shift's forgotten Time Out into the next morning", async () => {
    prisma.attendanceRecord.findFirst.mockResolvedValue({
      timeInAt: new Date(2026, 8, 28, 8, 0),
      timeOutAt: null,
      shift: dayShift,
    });
    prisma.employeeSchedule.findFirst.mockResolvedValue({ shift: dayShift, workingDays: everyDay });
    expect(await resolve(new Date(2026, 8, 29, 7, 50))).toEqual(tuesday);
  });
});
