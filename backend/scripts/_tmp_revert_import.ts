import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

(async () => {
  const users = await prisma.user.findMany({ where: { email: { endsWith: "@example.org" } }, select: { id: true, email: true } });
  const userIds = users.map((u) => u.id);
  const employees = await prisma.employee.findMany({ where: { userId: { in: userIds } }, select: { id: true, employeeNo: true, firstName: true, lastName: true, hireDate: true } });
  const empIds = employees.map((e) => e.id);
  console.log("Employees:", employees.map((e) => `${e.id} ${e.employeeNo} ${e.firstName} ${e.lastName}`));

  const byEmp = { employeeId: { in: empIds } };
  const counts = {
    employeeArchive: await prisma.employeeArchive.count({ where: byEmp }),
    workLocationEmployee: await prisma.workLocationEmployee.count({ where: byEmp }),
    attendanceRecord: await prisma.attendanceRecord.count({ where: byEmp }),
    attendanceLog: await prisma.attendanceLog.count({ where: byEmp }),
    faceProfile: await prisma.faceProfile.count({ where: byEmp }),
    leaveRequest: await prisma.leaveRequest.count({ where: byEmp }),
    leaveBalance: await prisma.leaveBalance.count({ where: byEmp }),
    leaveAccrualRecord: await prisma.leaveAccrualRecord.count({ where: byEmp }),
    undertimeFiling: await prisma.undertimeFiling.count({ where: byEmp }),
    employeeSchedule: await prisma.employeeSchedule.count({ where: byEmp }),
    evaluations: await prisma.probationaryEvaluation.count({ where: { OR: [byEmp, { supervisorId: { in: empIds } }] } }),
    teamMembersOfThem: await prisma.employee.count({ where: { supervisorId: { in: empIds } } }),
    spouseLinksToThem: await prisma.employee.count({ where: { spouseEmployeeId: { in: empIds }, id: { notIn: empIds } } }),
    userRole: await prisma.userRole.count({ where: { userId: { in: userIds } } }),
    passwordResetOtp: await prisma.passwordResetOtp.count({ where: { userId: { in: userIds } } }),
    notificationsOwned: await prisma.notification.count({ where: { userId: { in: userIds } } }),
    notificationsAboutThem: await prisma.notification.count({ where: { entityId: { in: [...empIds, ...userIds] }, userId: { notIn: userIds } } }),
    auditLogsAboutThem: await prisma.auditLog.count({ where: { entityId: { in: [...empIds, ...userIds] } } }),
    auditLogsByThem: await prisma.auditLog.count({ where: { actorUserId: { in: userIds } } }),
    leaveRequestNotes: await prisma.leaveRequestNote.count({ where: { authorUserId: { in: userIds } } }),
  };
  console.log(counts);
  console.log("Sample notifications about them:", await prisma.notification.findMany({ where: { entityId: { in: [...empIds, ...userIds] }, userId: { notIn: userIds } }, select: { title: true, type: true }, take: 5 }));
  console.log("Audit actions:", await prisma.auditLog.groupBy({ by: ["action", "entityType"], where: { entityId: { in: [...empIds, ...userIds] } }, _count: true }));

  // Employee-number counters per hire year: can only be wound back if no
  // other employee took a later number in that year.
  const years = Array.from(new Set(employees.map((e) => e.hireDate.getFullYear())));
  const seqs = await prisma.id_sequences.findMany({ where: { year: { in: years } } });
  const seqPlan: { year: number; from: number; to: number }[] = [];
  for (const s of seqs) {
    const prefix = `ULPI-${String(s.year).slice(-2)}`;
    const others = await prisma.employee.findMany({ where: { employeeNo: { startsWith: prefix }, id: { notIn: empIds } }, select: { employeeNo: true } });
    const maxOther = others.reduce((m, e) => Math.max(m, Number(e.employeeNo.slice(prefix.length)) || 0), 0);
    const maxOurs = employees.filter((e) => e.employeeNo.startsWith(prefix)).reduce((m, e) => Math.max(m, Number(e.employeeNo.slice(prefix.length))), 0);
    console.log(`seq ${s.year}: last_number=${s.last_number}, max other=${maxOther}, max imported=${maxOurs}`);
    if (s.last_number === maxOurs && maxOther < maxOurs) seqPlan.push({ year: s.year, from: s.last_number, to: maxOther });
  }
  console.log("Sequence rewind plan:", seqPlan);

  if (!APPLY) { console.log("DRY RUN — nothing changed."); await prisma.$disconnect(); return; }

  await prisma.$transaction(async (tx) => {
    const ids = [...empIds, ...userIds];
    await tx.notification.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { entityId: { in: ids } }] } });
    await tx.auditLog.deleteMany({ where: { entityId: { in: ids } } });
    await tx.employeeSchedule.deleteMany({ where: byEmp });
    await tx.leaveBalance.deleteMany({ where: byEmp });
    await tx.leaveAccrualRecord.deleteMany({ where: byEmp });
    await tx.workLocationEmployee.deleteMany({ where: byEmp });
    await tx.employee.updateMany({ where: { id: { in: empIds } }, data: { spouseEmployeeId: null, supervisorId: null } });
    await tx.employee.deleteMany({ where: { id: { in: empIds } } });
    await tx.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await tx.passwordResetOtp.deleteMany({ where: { userId: { in: userIds } } });
    await tx.user.deleteMany({ where: { id: { in: userIds } } });
    for (const p of seqPlan) await tx.id_sequences.update({ where: { year: p.year }, data: { last_number: p.to } });
  });
  console.log("APPLIED.");
  console.log("Remaining example.org users:", await prisma.user.count({ where: { email: { endsWith: "@example.org" } } }));
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
