// One-off maintenance script: recomputes totalMinutes for every completed
// OFFICE attendance record using the current break rule (see
// computeBreakMinutes), for records saved back when a flat 90 minutes of
// breaks was deducted regardless of when the employee actually left.
//
//   npx tsx scripts/recalculate-attendance-totals.ts          (dry run)
//   npx tsx scripts/recalculate-attendance-totals.ts --apply  (writes)
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { computeBreakMinutes } from "../src/modules/attendance/attendance-shift.util";

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");

async function main() {
  const records = await prisma.attendanceRecord.findMany({
    where: { recordType: "OFFICE", timeInAt: { not: null }, timeOutAt: { not: null }, shiftId: { not: null } },
    include: { shift: true },
    orderBy: { attendanceDate: "asc" },
  });

  let changed = 0;
  for (const record of records) {
    if (!record.shift || !record.timeInAt || !record.timeOutAt) continue;
    const workStart = record.renderTimeInAt ?? record.timeInAt;
    const breakMinutes = computeBreakMinutes(record.shift, record.attendanceDate, workStart, record.timeOutAt, {
      lunchOutAt: record.lunchOutAt,
      lunchInAt: record.lunchInAt,
    });
    const totalMinutes = Math.max(
      0,
      Math.round((record.timeOutAt.getTime() - workStart.getTime()) / 60000) - breakMinutes,
    );
    if (totalMinutes === record.totalMinutes) continue;

    changed += 1;
    console.log(
      `${record.id}  ${record.attendanceDate.toDateString()}  ${record.employeeId}  ` +
        `${record.totalMinutes} -> ${totalMinutes} min (break deducted: ${breakMinutes})`,
    );
    if (apply) {
      await prisma.attendanceRecord.update({ where: { id: record.id }, data: { totalMinutes } });
    }
  }

  console.log(
    `${records.length} completed record(s) checked, ${changed} ${apply ? "updated" : "would change (dry run — pass --apply to write)"}.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
