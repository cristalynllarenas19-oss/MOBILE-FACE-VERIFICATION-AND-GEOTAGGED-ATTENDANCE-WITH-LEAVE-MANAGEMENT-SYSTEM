import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { SchedulesService } from "./schedules.service";

describe("SchedulesService", () => {
  let service: SchedulesService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      shift: { findFirst: jest.fn(), findUniqueOrThrow: jest.fn(), create: jest.fn(), update: jest.fn(), findMany: jest.fn() },
      employeeSchedule: {
        findUniqueOrThrow: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
      },
      employee: { findUniqueOrThrow: jest.fn() },
      auditLog: { create: jest.fn() },
    };
    service = new SchedulesService(prisma);
  });

  const validShiftDto = { name: "Standard Shift", startTime: "08:00", endTime: "17:00" };

  describe("createShift", () => {
    it("rejects a duplicate shift name (case-insensitive check delegated to prisma)", async () => {
      prisma.shift.findFirst.mockResolvedValue({ id: "existing" });
      await expect(service.createShift(validShiftDto)).rejects.toThrow(ConflictException);
      expect(prisma.shift.create).not.toHaveBeenCalled();
    });

    it("rejects identical start and end time", async () => {
      prisma.shift.findFirst.mockResolvedValue(null);
      await expect(service.createShift({ ...validShiftDto, endTime: "08:00" })).rejects.toThrow(BadRequestException);
    });

    it("applies the documented defaults when optional fields are omitted", async () => {
      prisma.shift.findFirst.mockResolvedValue(null);
      prisma.shift.create.mockResolvedValue({ id: "shift-1", ...validShiftDto });

      await service.createShift(validShiftDto);

      expect(prisma.shift.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            morningBreakMinutes: 15,
            afternoonBreakMinutes: 15,
            lunchBreakMinutes: 60,
            roundingIntervalMinutes: 15,
            lateThresholdMinutes: 0,
            undertimeThresholdMinutes: 0,
            enableRounding: false,
            autoShiftAdjustment: false,
            workingDays: [1, 2, 3, 4, 5],
          }),
        }),
      );
    });

    it("rejects a non-integer break value", async () => {
      prisma.shift.findFirst.mockResolvedValue(null);
      await expect(service.createShift({ ...validShiftDto, morningBreakMinutes: 15.5 })).rejects.toThrow(
        BadRequestException,
      );
    });

    it("rejects a negative break value", async () => {
      prisma.shift.findFirst.mockResolvedValue(null);
      await expect(service.createShift({ ...validShiftDto, lunchBreakMinutes: -10 })).rejects.toThrow(
        BadRequestException,
      );
    });

    it("rejects an empty working-days list", async () => {
      prisma.shift.findFirst.mockResolvedValue(null);
      await expect(service.createShift({ ...validShiftDto, workingDays: [] })).rejects.toThrow(BadRequestException);
    });

    it("rejects Sunday (0) as a working day — it's always a fixed company-wide rest day", async () => {
      prisma.shift.findFirst.mockResolvedValue(null);
      await expect(service.createShift({ ...validShiftDto, workingDays: [0, 1, 2] })).rejects.toThrow(
        BadRequestException,
      );
    });

    it("rejects a working day outside 1-6", async () => {
      prisma.shift.findFirst.mockResolvedValue(null);
      await expect(service.createShift({ ...validShiftDto, workingDays: [1, 7] })).rejects.toThrow(
        BadRequestException,
      );
    });

    it("creates the shift and writes a CREATE_SHIFT audit log on success", async () => {
      prisma.shift.findFirst.mockResolvedValue(null);
      const created = { id: "shift-1", ...validShiftDto, morningBreakMinutes: 15, afternoonBreakMinutes: 15, lunchBreakMinutes: 60, enableRounding: false, roundingIntervalMinutes: 15, lateThresholdMinutes: 0, undertimeThresholdMinutes: 0, autoShiftAdjustment: false, workingDays: [1, 2, 3, 4, 5] };
      prisma.shift.create.mockResolvedValue(created);

      const result = await service.createShift(validShiftDto, "actor-1");

      expect(result).toBe(created);
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: "CREATE_SHIFT", entityId: "shift-1", actorUserId: "actor-1" }),
        }),
      );
    });

    it("trims the shift name before checking for duplicates and saving", async () => {
      prisma.shift.findFirst.mockResolvedValue(null);
      prisma.shift.create.mockResolvedValue({ id: "shift-1" });

      await service.createShift({ ...validShiftDto, name: "  Standard Shift  " });

      expect(prisma.shift.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ name: "Standard Shift" }) }),
      );
    });
  });

  describe("updateShift", () => {
    const existingShift = {
      id: "shift-1",
      name: "Standard Shift",
      startTime: "08:00",
      endTime: "17:00",
      morningBreakMinutes: 15,
      afternoonBreakMinutes: 15,
      lunchBreakMinutes: 60,
      enableRounding: false,
      roundingIntervalMinutes: 15,
      lateThresholdMinutes: 0,
      undertimeThresholdMinutes: 0,
      autoShiftAdjustment: false,
      workingDays: [1, 2, 3, 4, 5],
    };

    it("skips the duplicate-name check when the name isn't actually changing", async () => {
      prisma.shift.findUniqueOrThrow.mockResolvedValue(existingShift);
      prisma.shift.update.mockResolvedValue(existingShift);

      await service.updateShift("shift-1", { name: "Standard Shift", lateThresholdMinutes: 10 });

      expect(prisma.shift.findFirst).not.toHaveBeenCalled();
    });

    it("checks for duplicates against other shifts when the name does change", async () => {
      prisma.shift.findUniqueOrThrow.mockResolvedValue(existingShift);
      prisma.shift.findFirst.mockResolvedValue({ id: "some-other-shift" });

      await expect(service.updateShift("shift-1", { name: "Night Shift" })).rejects.toThrow(ConflictException);
      expect(prisma.shift.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: { not: "shift-1" } }) }),
      );
    });

    it("validates start/end using the merged (existing + partial update) times", async () => {
      prisma.shift.findUniqueOrThrow.mockResolvedValue(existingShift);
      // Only startTime is being changed to match the existing endTime — this
      // must still be caught even though endTime itself isn't in the DTO.
      await expect(service.updateShift("shift-1", { startTime: "17:00" })).rejects.toThrow(BadRequestException);
    });

    it("updates only the provided fields and writes an UPDATE_SHIFT audit log with before/after values", async () => {
      prisma.shift.findUniqueOrThrow.mockResolvedValue(existingShift);
      const updated = { ...existingShift, lateThresholdMinutes: 30 };
      prisma.shift.update.mockResolvedValue(updated);

      await service.updateShift("shift-1", { lateThresholdMinutes: 30 }, "actor-1");

      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "UPDATE_SHIFT",
            oldValues: expect.objectContaining({ lateThresholdMinutes: 0 }),
            newValues: expect.objectContaining({ lateThresholdMinutes: 30 }),
          }),
        }),
      );
    });
  });

  describe("setShiftStatus", () => {
    it("logs ARCHIVE_SHIFT when deactivating", async () => {
      prisma.shift.update.mockResolvedValue({ id: "shift-1", isActive: false });
      await service.setShiftStatus("shift-1", false, "actor-1");
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: "ARCHIVE_SHIFT" }) }),
      );
    });

    it("logs RESTORE_SHIFT when reactivating", async () => {
      prisma.shift.update.mockResolvedValue({ id: "shift-1", isActive: true });
      await service.setShiftStatus("shift-1", true, "actor-1");
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: "RESTORE_SHIFT" }) }),
      );
    });
  });

  describe("createAssignment", () => {
    it("rejects assigning an employee outside the caller's department scope", async () => {
      prisma.employee.findUniqueOrThrow.mockResolvedValue({ departmentId: "dept-other" });
      await expect(
        service.createAssignment(
          { employeeId: "emp-1", shiftId: "shift-1", startsOn: "2026-01-01" },
          "dept-mine",
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.employeeSchedule.create).not.toHaveBeenCalled();
    });

    it("defaults workingDays to the shift template's own working days when omitted", async () => {
      prisma.shift.findUniqueOrThrow.mockResolvedValue({ workingDays: [1, 2, 3, 4, 5, 6] });
      prisma.employeeSchedule.create.mockResolvedValue({ id: "assignment-1" });

      await service.createAssignment({ employeeId: "emp-1", shiftId: "shift-1", startsOn: "2026-01-01" });

      expect(prisma.employeeSchedule.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ workingDays: [1, 2, 3, 4, 5, 6] }) }),
      );
    });

    it("rejects an explicit but invalid workingDays override", async () => {
      await expect(
        service.createAssignment({
          employeeId: "emp-1",
          shiftId: "shift-1",
          startsOn: "2026-01-01",
          workingDays: [0],
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("setAssignmentStatus", () => {
    it("rejects managing an assignment outside the caller's department scope", async () => {
      prisma.employeeSchedule.findUniqueOrThrow.mockResolvedValue({ employee: { departmentId: "dept-other" } });
      await expect(service.setAssignmentStatus("assignment-1", false, "dept-mine")).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.employeeSchedule.update).not.toHaveBeenCalled();
    });

    it("allows managing an assignment within the caller's own department", async () => {
      prisma.employeeSchedule.findUniqueOrThrow.mockResolvedValue({ employee: { departmentId: "dept-mine" } });
      prisma.employeeSchedule.update.mockResolvedValue({ id: "assignment-1", isActive: false });

      await service.setAssignmentStatus("assignment-1", false, "dept-mine");

      expect(prisma.employeeSchedule.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "assignment-1" }, data: { isActive: false } }),
      );
    });
  });
});
