// Demo-data script: gives two seasonal employees a few months of leave
// accrual history so the Leave page's Accrual History tab / Accrual Details
// modal has something to show. It seeds PRESENT attendance for every working
// day except the planned absences, makes both employees Permanent Seasonal
// from their probation-end date, then runs the real
// LeaveAccrualService.processAccruals() — so the accrual records and SL/VL
// credits come out exactly as the daily cron would have produced them.
//
//   npx tsx scripts/seed-accrual-demo.ts           (dry run)
//   npx tsx scripts/seed-accrual-demo.ts --apply   (writes)
//   npx tsx scripts/seed-accrual-demo.ts --remove  (undoes --apply)
//
// Refuses to run against anything but a localhost database unless --force.
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { LeaveAccrualService } from "../src/modules/leave/leave-accrual.service";

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");
const remove = process.argv.includes("--remove");
const force = process.argv.includes("--force");

const WORK_LOCATION_ID = "LOC-1008";
const SHIFT_ID = "SHIFT-002";
const PERMANENT_SEASONAL_TYPE_ID = "ETYPE-001";
// Last day attendance is seeded for (inclusive) — fixed rather than
// "yesterday" so --remove deletes exactly what --apply created.
const SEED_UNTIL = new Date(2026, 9, 28);

type DemoEmployee = {
  id: string;
  name: string;
  permanentSeasonalSince: Date;
  absences: Date[];
  // What --remove puts back.
  original: { employmentStatus: "PERMANENT_SEASONAL" | "PROBATIONARY_SEASONAL"; employeeTypeId: string; permanentSeasonalSince: Date | null };
};

// Resulting periods (as of 10/29/2026):
//   Joanna Dane Cooper  9/11–10/11 No Absence (+1.25/+1.25), 10/11–10/28 Has Absence
//   Trial Lang          8/11–9/11 No Absence, 9/11–9/28 Has Absence, 9/29–10/29 No Absence
const DEMO_EMPLOYEES: DemoEmployee[] = [
  {
    id: "EMP-1016",
    name: "Joanna Dane Cooper",
    permanentSeasonalSince: new Date(2026, 8, 11),
    absences: [new Date(2026, 9, 28)],
    original: {
      employmentStatus: "PERMANENT_SEASONAL",
      employeeTypeId: PERMANENT_SEASONAL_TYPE_ID,
      permanentSeasonalSince: new Date("2026-10-20T08:32:09.089Z"),
    },
  },
  {
    id: "EMP-1017",
    name: "Trial Lang",
    permanentSeasonalSince: new Date(2026, 7, 11),
    absences: [new Date(2026, 8, 28)],
    original: { employmentStatus: "PROBATIONARY_SEASONAL", employeeTypeId: "ETYPE-003", permanentSeasonalSince: null },
  },
];

function at(date: Date, hours: number, minutes: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours, minutes);
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Mon–Sat, matching both employees' EmployeeSchedule.workingDays.
function presentDays(employee: DemoEmployee): Date[] {
  const days: Date[] = [];
  for (let day = new Date(employee.permanentSeasonalSince); day <= SEED_UNTIL; day.setDate(day.getDate() + 1)) {
    if (day.getDay() === 0) continue;
    if (employee.absences.some((absence) => sameDay(absence, day))) continue;
    days.push(new Date(day));
  }
  return days;
}

async function seed() {
  for (const employee of DEMO_EMPLOYEES) {
    const days = presentDays(employee);
    console.log(
      `${employee.name}: Permanent Seasonal since ${employee.permanentSeasonalSince.toDateString()}, ` +
        `${days.length} present day(s), absent on ${employee.absences.map((d) => d.toDateString()).join(", ")}`,
    );
    if (!apply) continue;

    await prisma.employee.update({
      where: { id: employee.id },
      data: {
        employmentStatus: "PERMANENT_SEASONAL",
        employeeTypeId: PERMANENT_SEASONAL_TYPE_ID,
        permanentSeasonalSince: employee.permanentSeasonalSince,
      },
    });

    // Small deterministic spread so the DTR doesn't look copy-pasted.
    await prisma.attendanceRecord.createMany({
      data: days.map((day) => {
        const jitter = day.getDate() % 12;
        return {
          employeeId: employee.id,
          attendanceDate: day,
          recordType: "OFFICE" as const,
          visitNumber: 1,
          workLocationId: WORK_LOCATION_ID,
          shiftId: SHIFT_ID,
          timeInAt: at(day, 7, 45 + jitter),
          renderTimeInAt: at(day, 8, 0),
          lunchOutAt: at(day, 12, 0 + jitter),
          lunchInAt: at(day, 13, jitter % 5),
          timeOutAt: at(day, 17, jitter),
          status: "PRESENT" as const,
          totalMinutes: 480,
        };
      }),
      skipDuplicates: true,
    });
  }

  if (!apply) {
    console.log("\nDry run — nothing written. Re-run with --apply.");
    return;
  }

  await new LeaveAccrualService(prisma as never).processAccruals();

  const records = await prisma.leaveAccrualRecord.findMany({
    where: { employeeId: { in: DEMO_EMPLOYEES.map((e) => e.id) } },
    orderBy: [{ employeeId: "asc" }, { cycleStart: "asc" }],
  });
  console.log("\nAccrual records:");
  for (const r of records) {
    console.log(
      `  ${r.employeeId}  ${r.cycleStart.toDateString()} – ${r.cycleEnd.toDateString()}  ${r.outcome}  ` +
        `+${r.sickLeaveEarned} SL, +${r.vacationLeaveEarned} VL`,
    );
  }
}

async function unseed() {
  for (const employee of DEMO_EMPLOYEES) {
    const records = await prisma.leaveAccrualRecord.findMany({ where: { employeeId: employee.id } });
    const days = presentDays(employee);
    console.log(`${employee.name}: ${records.length} accrual record(s), up to ${days.length} seeded attendance day(s)`);

    const creditByYear = new Map<number, { sick: number; vacation: number }>();
    for (const record of records) {
      if (record.outcome !== "PERFECT") continue;
      const year = record.cycleEnd.getFullYear();
      const credit = creditByYear.get(year) ?? { sick: 0, vacation: 0 };
      credit.sick += Number(record.sickLeaveEarned);
      credit.vacation += Number(record.vacationLeaveEarned);
      creditByYear.set(year, credit);
    }

    await prisma.$transaction(async (tx) => {
      for (const [year, credit] of creditByYear) {
        await tx.leaveBalance.updateMany({
          where: { employeeId: employee.id, leaveTypeId: "LT-SL-001", year },
          data: { earnedDays: { decrement: credit.sick } },
        });
        await tx.leaveBalance.updateMany({
          where: { employeeId: employee.id, leaveTypeId: "LT-VL-001", year },
          data: { earnedDays: { decrement: credit.vacation } },
        });
      }
      await tx.leaveAccrualRecord.deleteMany({ where: { employeeId: employee.id } });
      await tx.attendanceRecord.deleteMany({
        where: { employeeId: employee.id, recordType: "OFFICE", visitNumber: 1, attendanceDate: { in: days } },
      });
      await tx.employee.update({ where: { id: employee.id }, data: employee.original });
    });
  }
  console.log("\nDemo accrual data removed and employees restored.");
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url) && !force) {
    throw new Error("DATABASE_URL is not a localhost database — re-run with --force if this is intentional.");
  }
  if (remove) await unseed();
  else await seed();
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
