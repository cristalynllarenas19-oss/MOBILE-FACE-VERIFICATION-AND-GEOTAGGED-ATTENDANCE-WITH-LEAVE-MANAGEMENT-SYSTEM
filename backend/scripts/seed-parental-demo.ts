// Demo-data script for the Maternity Leave 30-day extension and the parental
// leave "ending soon" / "back at work" / extension-deadline notifications.
// Inserts three APPROVED leaves, dated relative to today, then runs the real
// ParentalReturnService checks once — so the notifications come out exactly
// as the hourly cron would have sent them, without waiting for it.
//
//   1. Sheena Emperador    Maternity ending 45 days from today — she gets
//                          the "Maternity Leave Extension Deadline" reminder
//                          and can still "Request 30-Day Extension" today.
//                          She has no supervisor, so HR/Admin reviews it.
//   2. Final Test          Maternity ending in 5 days — "Maternity Leave
//                          Ending Soon" to her supervisor and every Admin.
//   3. James Elmar Higoy   Paternity ending tomorrow — he gets "Your
//                          Paternity Leave Ends Tomorrow" today; his
//                          supervisor and every Admin get "Ending Soon"
//                          today, then "Returning from Paternity Leave"
//                          the day before he's back and on the day itself
//                          (sent by the hourly check while the backend runs).
//
//   npx tsx scripts/seed-parental-demo.ts           (dry run)
//   npx tsx scripts/seed-parental-demo.ts --apply   (writes, sends notices)
//   npx tsx scripts/seed-parental-demo.ts --remove  (undoes --apply)
//   npx tsx scripts/seed-parental-demo.ts --apply --only EMP-1001
//                          (seeds just that employee's demo leave)
//   npx tsx scripts/seed-parental-demo.ts --fix-history
//                          (adds the filing date / approval steps to
//                          demo leaves seeded before they were recorded)
//
// Seeded requests are found again by their reason, so --remove also clears
// any extension requested on them and every notification about them.
// Refuses to run against anything but a localhost database unless --force.
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { NotificationsService } from "../src/modules/notifications/notifications.service";
import { ParentalReturnService } from "../src/modules/leave/parental-return.service";

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");
const remove = process.argv.includes("--remove");
const force = process.argv.includes("--force");
const fixHistory = process.argv.includes("--fix-history");
// --only <employeeId>: seed just that employee's demo leave.
const onlyIndex = process.argv.indexOf("--only");
const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : undefined;

const DEMO_REASON = "[Parental demo]";
const MATERNITY_TYPE_ID = "LT-ML-001";
const PATERNITY_TYPE_ID = "LT-PL-001";

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

const today = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());

type DemoLeave = {
  employeeId: string;
  name: string;
  leaveTypeId: string;
  startDate: Date;
  endDate: Date;
  purpose: string;
};

// Ends 45 days from now — today is the extension deadline, the day the
// reminder goes out (and still a day she can request it).
const maternityExtendableEnd = addDays(today, 45);
const maternityEnding = addDays(today, 5);
// Ends tomorrow — so today he's told it ends tomorrow, and the "Returning"
// notices (the day before he's back, and the day itself) follow.
const paternityEnds = addDays(today, 1);
// Sheena has 98 Maternity days, not the usual 105 (7 were transferred as
// Added Paternity Leave) — filing would refuse more than that.
const SHEENA_MATERNITY_DAYS = 98;

const DEMO_LEAVES: DemoLeave[] = [
  {
    employeeId: "EMP-1010",
    name: "Sheena Emperador",
    leaveTypeId: MATERNITY_TYPE_ID,
    startDate: addDays(maternityExtendableEnd, -(SHEENA_MATERNITY_DAYS - 1)),
    endDate: maternityExtendableEnd,
    purpose: `can request the 30-day extension until ${addDays(maternityExtendableEnd, -45).toDateString()}`,
  },
  {
    employeeId: "EMP-1029",
    name: "Final Test",
    leaveTypeId: MATERNITY_TYPE_ID,
    startDate: addDays(maternityEnding, -104),
    endDate: maternityEnding,
    purpose: "\"Maternity Leave Ending Soon\" notice",
  },
  {
    employeeId: "EMP-1001",
    name: "James Elmar Higoy",
    leaveTypeId: PATERNITY_TYPE_ID,
    startDate: addDays(paternityEnds, -6),
    endDate: paternityEnds,
    purpose: "\"Ends Tomorrow\" and \"Returning from Paternity Leave\" notices",
  },
];

function totalDays(leave: DemoLeave) {
  return Math.round((leave.endDate.getTime() - leave.startDate.getTime()) / 86_400_000) + 1;
}

async function seededRequests() {
  return prisma.leaveRequest.findMany({
    where: { reason: { startsWith: DEMO_REASON } },
    select: { id: true, employeeId: true, leaveTypeId: true, startDate: true, totalDays: true, status: true },
  });
}

// Same bookkeeping as LeaveService.adjustLeaveBalance does on a real
// approval (and on a cancellation, with negative days): usedDays on the
// balance for the leave's start year, seeded from the type's default
// allotment if the employee has no row for that year yet.
async function adjustBalance(employeeId: string, leaveTypeId: string, startDate: Date, deltaDays: number) {
  const year = startDate.getFullYear();
  const key = { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } };
  const existing = await prisma.leaveBalance.findUnique({ where: key });
  if (existing) {
    await prisma.leaveBalance.update({ where: key, data: { usedDays: Math.max(0, Number(existing.usedDays) + deltaDays) } });
    return;
  }
  const leaveType = await prisma.leaveType.findUniqueOrThrow({ where: { id: leaveTypeId } });
  await prisma.leaveBalance.create({
    data: { employeeId, leaveTypeId, year, earnedDays: leaveType.defaultDays, usedDays: Math.max(0, deltaDays) },
  });
}

const HR_ADMIN_EMAIL = "hradmin@universal-leaf.com";
const APPROVAL_ACTIONS = ["SUPERVISOR_APPROVE_LEAVE", "APPROVE_LEAVE"];

function at(date: Date, hours: number) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours);
}

// Gives a seeded leave the history a real one would have: filed two weeks
// before it starts, approved by the employee's supervisor (if any) the next
// day, then by HR/Admin the day after — the same audit rows
// LeaveService.updateStatus writes, which the Approval Progress timeline is
// built from. Safe to re-run: replaces the leave's previous approval rows.
async function recordApprovalHistory(requestId: string, employeeId: string, startDate: Date) {
  const [employee, hrAdmin] = await Promise.all([
    prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { supervisor: { select: { userId: true } } } }),
    prisma.user.findUniqueOrThrow({ where: { email: HR_ADMIN_EMAIL }, select: { id: true } }),
  ]);
  const filedAt = at(addDays(startDate, -14), 9);
  const supervisorUserId = employee.supervisor?.userId;
  const hrApprovedAt = at(addDays(filedAt, supervisorUserId ? 2 : 1), 14);

  await prisma.$transaction(async (tx) => {
    await tx.auditLog.deleteMany({ where: { entityType: "LeaveRequest", entityId: requestId, action: { in: APPROVAL_ACTIONS } } });
    await tx.leaveRequest.update({
      where: { id: requestId },
      data: { createdAt: filedAt, reviewedBy: hrAdmin.id, reviewedAt: hrApprovedAt },
    });
    if (supervisorUserId) {
      await tx.auditLog.create({
        data: {
          actorUserId: supervisorUserId,
          action: "SUPERVISOR_APPROVE_LEAVE",
          entityType: "LeaveRequest",
          entityId: requestId,
          oldValues: { status: "PENDING" },
          newValues: { status: "SUPERVISOR_APPROVED" },
          createdAt: at(addDays(filedAt, 1), 10),
        },
      });
    }
    await tx.auditLog.create({
      data: {
        actorUserId: hrAdmin.id,
        action: "APPROVE_LEAVE",
        entityType: "LeaveRequest",
        entityId: requestId,
        oldValues: { status: supervisorUserId ? "SUPERVISOR_APPROVED" : "PENDING" },
        newValues: { status: "APPROVED" },
        createdAt: hrApprovedAt,
      },
    });
  });
}

async function availableDays(leave: DemoLeave) {
  const balance = await prisma.leaveBalance.findUnique({
    where: { employeeId_leaveTypeId_year: { employeeId: leave.employeeId, leaveTypeId: leave.leaveTypeId, year: leave.startDate.getFullYear() } },
  });
  if (balance) return Number(balance.earnedDays) - Number(balance.usedDays);
  const leaveType = await prisma.leaveType.findUniqueOrThrow({ where: { id: leave.leaveTypeId } });
  return Number(leaveType.defaultDays);
}

async function seed() {
  const leaves = only ? DEMO_LEAVES.filter((leave) => leave.employeeId === only) : DEMO_LEAVES;
  if (leaves.length === 0) {
    console.log(`No demo leave for ${only}.`);
    return;
  }
  const employeeIds = new Set(leaves.map((leave) => leave.employeeId));
  if ((await seededRequests()).some((request) => employeeIds.has(request.employeeId))) {
    console.log("Demo leaves are already seeded — run with --remove first to start over.");
    return;
  }

  let blocked = false;
  for (const leave of leaves) {
    const [overlapping, attended] = await Promise.all([
      // Also the week after: approved leave right after a parental leave
      // pushes the return day back, so the expected notice wouldn't show.
      prisma.leaveRequest.count({
        where: {
          employeeId: leave.employeeId,
          status: { in: ["PENDING", "SUPERVISOR_APPROVED", "NEEDS_REVISION", "APPROVED", "CANCELLATION_PENDING"] },
          startDate: { lte: addDays(leave.endDate, 7) },
          endDate: { gte: leave.startDate },
        },
      }),
      prisma.attendanceRecord.count({
        where: { employeeId: leave.employeeId, attendanceDate: { gte: leave.startDate, lt: addDays(leave.endDate, 1) } },
      }),
    ]);
    console.log(
      `${leave.name}: ${leave.startDate.toDateString()} – ${leave.endDate.toDateString()} (${totalDays(leave)} days) — ${leave.purpose}`,
    );
    if (attended > 0) console.log(`  note: ${attended} attendance record(s) fall inside this leave (only cosmetic on the DTR)`);
    const available = await availableDays(leave);
    if (available < totalDays(leave)) {
      console.log(`  BLOCKED: only ${available} day(s) left in the balance`);
      blocked = true;
    }
    if (overlapping > 0) {
      console.log(`  BLOCKED: ${overlapping} existing leave request(s) overlap these dates or the week after`);
      blocked = true;
    }
  }

  if (blocked) {
    console.log("\nNothing written — fix the blocked leave(s) first.");
    return;
  }
  if (!apply) {
    console.log("\nDry run — nothing written. Re-run with --apply.");
    return;
  }

  for (const leave of leaves) {
    const created = await prisma.leaveRequest.create({
      data: {
        employeeId: leave.employeeId,
        leaveTypeId: leave.leaveTypeId,
        startDate: leave.startDate,
        endDate: leave.endDate,
        totalDays: totalDays(leave),
        reason: `${DEMO_REASON} ${leave.purpose}`,
        status: "APPROVED",
      },
    });
    await recordApprovalHistory(created.id, leave.employeeId, leave.startDate);
    await adjustBalance(leave.employeeId, leave.leaveTypeId, leave.startDate, totalDays(leave));
  }

  const service = new ParentalReturnService(prisma as never, new NotificationsService(prisma as never));
  const result = await service.process();
  const reminders = await service.remindExtensionDeadlines();
  console.log(
    `\nSeeded ${leaves.length} approved leave(s); sent ${result.sent} parental return and ${reminders.sent} extension reminder notification(s).`,
  );

  const sent = await prisma.notification.findMany({
    where: {
      type: { in: ["LEAVE_PARENTAL_ENDING", "LEAVE_PARENTAL_RETURN", "LEAVE_EXTENSION_REMINDER", "LEAVE_ENDING_REMINDER"] },
      createdAt: { gte: addDays(today, 0) },
    },
    select: { title: true, user: { select: { email: true } } },
    orderBy: { createdAt: "asc" },
  });
  for (const notification of sent) console.log(`  ${notification.title} → ${notification.user.email}`);
}

async function unseed() {
  const parents = await seededRequests();
  const parentIds = parents.map((request) => request.id);
  // Any extension requested on a seeded Maternity Leave while trying it out.
  const extensions = await prisma.leaveRequest.findMany({
    where: { extensionOfId: { in: parentIds } },
    select: { id: true },
  });
  const ids = [...parentIds, ...extensions.map((request) => request.id)];
  console.log(`${parentIds.length} demo leave(s), ${extensions.length} extension request(s) on them`);
  if (ids.length === 0) return;

  // Give back the days each seeded leave still holds. One cancelled (or
  // rejected) in the app already had them returned there; an extension
  // never took any.
  for (const request of parents) {
    if (request.status !== "APPROVED" && request.status !== "CANCELLATION_PENDING") continue;
    await adjustBalance(request.employeeId, request.leaveTypeId, request.startDate, -Number(request.totalDays));
  }

  await prisma.$transaction(async (tx) => {
    await tx.auditLog.deleteMany({ where: { entityType: "LeaveRequest", entityId: { in: ids } } });
    await tx.notification.deleteMany({ where: { entityId: { in: ids } } });
    await tx.leaveRequestNote.deleteMany({ where: { leaveRequestId: { in: ids } } });
    await tx.leaveRequest.deleteMany({ where: { id: { in: ids } } });
  });
  console.log("\nDemo parental leaves, their extensions and notifications removed.");
}

// Backfills the filing date and approval steps onto demo leaves seeded
// before recordApprovalHistory existed, leaving everything else (including
// any extension filed on them) as it is.
async function fixSeededHistory() {
  const seeded = await seededRequests();
  for (const request of seeded) {
    await recordApprovalHistory(request.id, request.employeeId, request.startDate);
  }
  console.log(`Approval history recorded on ${seeded.length} demo leave(s).`);
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url) && !force) {
    throw new Error("DATABASE_URL is not a localhost database — re-run with --force if this is intentional.");
  }
  if (remove) await unseed();
  else if (fixHistory) await fixSeededHistory();
  else await seed();
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
