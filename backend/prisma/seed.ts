import { PrismaClient, RoleCode } from "@prisma/client";
import * as argon2 from "argon2";

const prisma = new PrismaClient();

const permissionRows = [
  ["dashboard:view", "Dashboard"],
  ["users:read", "Users"],
  ["users:write", "Users"],
  ["employees:read", "Employees"],
  ["employees:write", "Employees"],
  ["departments:read", "Departments"],
  ["departments:write", "Departments"],
  ["attendance:read", "Attendance"],
  ["attendance:write", "Attendance"],
  ["leave:read", "Leave"],
  ["leave:write", "Leave"],
  ["leave:approve", "Leave"],
  ["schedules:read", "Schedules"],
  ["schedules:write", "Schedules"],
  ["reports:read", "Reports"],
  ["audit:read", "Audit"],
  ["geolocation:write", "Geolocation"],
] as const;

const rolePermissions: Record<RoleCode, string[]> = {
  ADMIN: permissionRows.map(([code]) => code),
  // leave:read/leave:approve let a Supervisor see their department's requests
  // and pre-approve them (Employee -> Supervisor -> HR chain) — without
  // these, a Supervisor account gets 403 on every leave endpoint.
  // geolocation:write lets a Supervisor create/edit/assign geotagged areas —
  // GeolocationService enforces the department boundary per-request, this
  // permission only gates whether they can hit the write endpoints at all.
  // employees:write lets a Supervisor edit/archive employees in their own
  // department — EmployeesService enforces the department boundary the same
  // way (see the scopeDepartmentId checks in create/update/archive).
  // reports:read lets a Supervisor view the Reports page — ReportsService
  // already ANDs in getSupervisorDepartmentScope so they only ever see their
  // own department's data, same as Employees/Leave/Dashboard. Deliberately
  // does NOT imply audit:read — Utilities/Audit Logs stays HR/Admin-only, so
  // that page and reports:read must stay on separate permission codes.
  SUPERVISOR: ["dashboard:view", "employees:read", "employees:write", "attendance:read", "schedules:read", "leave:read", "leave:approve", "geolocation:write", "reports:read"],
  EMPLOYEE: ["dashboard:view", "attendance:write", "leave:read", "leave:write"],
};

async function upsertUser(email: string, password: string, roleCode: RoleCode, employee: {
  employeeNo: string;
  firstName: string;
  lastName: string;
  departmentId: string;
  positionId: string;
  hireDate: Date;
}) {
  const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } });
  const passwordHash = await argon2.hash(password);
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash, status: "ACTIVE" },
    create: {
      email,
      passwordHash,
      userRoles: { create: { roleId: role.id } },
    },
  });

  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: user.id, roleId: role.id } },
    update: {},
    create: { userId: user.id, roleId: role.id },
  });

  return prisma.employee.upsert({
    where: { employeeNo: employee.employeeNo },
    update: { ...employee, userId: user.id },
    create: { ...employee, userId: user.id },
  });
}

async function main() {
  for (const [code, module] of permissionRows) {
    await prisma.permission.upsert({
      where: { code },
      update: { module },
      create: { code, module, description: `${module} access` },
    });
  }

  for (const code of Object.values(RoleCode)) {
    const role = await prisma.role.upsert({
      where: { code },
      update: { name: code === "ADMIN" ? "Admin / HR Personnel" : code === "SUPERVISOR" ? "Supervisor / Manager" : "Employee" },
      create: {
        code,
        name: code === "ADMIN" ? "Admin / HR Personnel" : code === "SUPERVISOR" ? "Supervisor / Manager" : "Employee",
      },
    });

    // Full replace, not additive upsert — otherwise a permission removed from
    // rolePermissions above would stay granted forever on an already-seeded DB.
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    for (const permissionCode of rolePermissions[code]) {
      const permission = await prisma.permission.findUniqueOrThrow({ where: { code: permissionCode } });
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionId: permission.id },
      });
    }
  }

  const hr = await prisma.department.upsert({ where: { name: "Human Resources" }, update: {}, create: { name: "Human Resources" } });
  const production = await prisma.department.upsert({ where: { name: "Production" }, update: {}, create: { name: "Production" } });
  const quality = await prisma.department.upsert({ where: { name: "Quality Control" }, update: {}, create: { name: "Quality Control" } });
  const hrPosition = await prisma.position.upsert({ where: { id: "11111111-1111-4111-8111-111111111111" }, update: { title: "HR Personnel" }, create: { id: "11111111-1111-4111-8111-111111111111", title: "HR Personnel" } });
  const supervisorPosition = await prisma.position.upsert({ where: { id: "22222222-2222-4222-8222-222222222222" }, update: { title: "Department Supervisor" }, create: { id: "22222222-2222-4222-8222-222222222222", title: "Department Supervisor" } });
  const employeePosition = await prisma.position.upsert({ where: { id: "33333333-3333-4333-8333-333333333333" }, update: { title: "Leaf Processor" }, create: { id: "33333333-3333-4333-8333-333333333333", title: "Leaf Processor" } });

  await prisma.workLocation.upsert({
    where: { id: "44444444-4444-4444-8444-444444444444" },
    update: {},
    create: {
      id: "44444444-4444-4444-8444-444444444444",
      name: "Universal Leaf Philippines Inc. - Agoo",
      latitude: 16.3226,
      longitude: 120.3659,
      radiusMeters: 150,
      allowedAccuracyMeters: 60,
    },
  });

  await upsertUser("hradmin@universal-leaf.com", "password123", "ADMIN", {
    employeeNo: "UL-001",
    firstName: "Maria",
    lastName: "Santos",
    departmentId: hr.id,
    positionId: hrPosition.id,
    hireDate: new Date("2021-01-15"),
  });
  const supervisor = await upsertUser("supervisor@universal-leaf.com", "password123", "SUPERVISOR", {
    employeeNo: "UL-002",
    firstName: "Juan",
    lastName: "Dela Cruz",
    departmentId: production.id,
    positionId: supervisorPosition.id,
    hireDate: new Date("2020-05-10"),
  });
  const employee = await upsertUser("employee@universal-leaf.com", "password123", "EMPLOYEE", {
    employeeNo: "UL-003",
    firstName: "Ana",
    lastName: "Reyes",
    // Must match `supervisor`'s department (Production) — EmployeesService now
    // rejects a supervisorId whose department differs from the employee's,
    // and this employee/supervisor pairing exists specifically to demo that
    // Employee -> Supervisor -> HR leave approval chain.
    departmentId: production.id,
    positionId: employeePosition.id,
    hireDate: new Date("2023-03-01"),
  });
  await prisma.employee.update({ where: { id: employee.id }, data: { supervisorId: supervisor.id } });

  const allClassifications = ["REGULAR", "CONTRACTUAL_SEASONAL", "PIECE_RATE", "SEPARATED"] as const;

  const leaveTypeSeeds = [
    { name: "Sick Leave", defaultDays: 15, requiresDocument: true, supportingDocumentAfterDays: 2, isAutoCredited: true, isSingleDayOnly: true },
    { name: "Emergency Leave", defaultDays: 5, requiresDocument: false, isAutoCredited: true, isSingleDayOnly: true },
    { name: "Vacation Leave", defaultDays: 15, requiresDocument: false, isAutoCredited: true },
    // Admin-grant-only: an employee applies to HR/Admin, who then grants this
    // specific leave type (and day count) to that employee via the "Grant
    // Leave Type" action on the Leave page — see LeaveBalancesService.grant.
    // Until granted, the employee has 0 days of it.
    { name: "Study Leave", defaultDays: 15, requiresDocument: true, requiresHrValidation: true, requiresAdminGrant: true },
    { name: "Adverse Weather Leave", defaultDays: 0, requiresDocument: false, requiresEhsActivation: true, isUnlimitedDays: true },
    { name: "Bereavement Leave", defaultDays: 5, requiresDocument: true },
    { name: "Solo Parent Leave", defaultDays: 7, requiresDocument: true, requiresHrValidation: true, requiresAdminGrant: true },
    { name: "Maternity Leave", defaultDays: 105, requiresDocument: true, requiresHrValidation: true },
    { name: "Paternity Leave", defaultDays: 7, requiresDocument: false },
    // The extra days a mother can transfer from her own Maternity Leave to
    // the father (RA 11210) — the count is whatever she chooses to transfer,
    // so it starts at 0 and HR sets it per grant.
    { name: "Added Paternity Leave", defaultDays: 0, requiresDocument: true, requiresHrValidation: true, isTransferable: true, requiresAdminGrant: true },
  ] as const;

  for (const seedType of leaveTypeSeeds) {
    await prisma.leaveType.upsert({
      where: { name: seedType.name },
      update: {},
      create: {
        name: seedType.name,
        defaultDays: seedType.defaultDays,
        requiresDocument: seedType.requiresDocument,
        supportingDocumentAfterDays: "supportingDocumentAfterDays" in seedType ? seedType.supportingDocumentAfterDays : undefined,
        requiresHrValidation: "requiresHrValidation" in seedType ? seedType.requiresHrValidation : false,
        requiresEhsActivation: "requiresEhsActivation" in seedType ? seedType.requiresEhsActivation : false,
        isUnlimitedDays: "isUnlimitedDays" in seedType ? seedType.isUnlimitedDays : false,
        allowWithoutPay: false,
        isAutoCredited: "isAutoCredited" in seedType ? seedType.isAutoCredited : false,
        isTransferable: "isTransferable" in seedType ? seedType.isTransferable : false,
        requiresAdminGrant: "requiresAdminGrant" in seedType ? seedType.requiresAdminGrant : false,
        isSingleDayOnly: "isSingleDayOnly" in seedType ? seedType.isSingleDayOnly : false,
        applicableStatuses: [...allClassifications],
      },
    });
  }

  // Leave Without Pay is retired — archive it (not delete) so any pre-existing
  // DB that seeded it before this change loses employee-facing access to it
  // while historical leave records/balances referencing it stay intact.
  await prisma.leaveType.updateMany({
    where: { name: "Leave Without Pay" },
    data: { isActive: false },
  });

  const sickLeave = await prisma.leaveType.findUniqueOrThrow({ where: { name: "Sick Leave" } });
  const regularShift = await prisma.shift.upsert({
    where: { id: "66666666-6666-4666-8666-666666666666" },
    update: { name: "Standard Shift", startTime: "08:00", endTime: "17:00", lateThresholdMinutes: 10 },
    create: {
      id: "66666666-6666-4666-8666-666666666666",
      name: "Standard Shift",
      startTime: "08:00",
      endTime: "17:00",
      lateThresholdMinutes: 10,
    },
  });

  await prisma.shift.upsert({
    where: { id: "77777777-7777-4777-8777-777777777777" },
    update: { name: "Alternative Shift", startTime: "09:00", endTime: "18:00", lateThresholdMinutes: 10 },
    create: {
      id: "77777777-7777-4777-8777-777777777777",
      name: "Alternative Shift",
      startTime: "09:00",
      endTime: "18:00",
      lateThresholdMinutes: 10,
    },
  });

  await prisma.employeeSchedule.upsert({
    where: { id: "88888888-8888-4888-8888-888888888888" },
    update: {},
    create: {
      id: "88888888-8888-4888-8888-888888888888",
      employeeId: employee.id,
      shiftId: regularShift.id,
      startsOn: new Date("2026-06-01"),
    },
  });

  await prisma.leaveRequest.upsert({
    where: { id: "55555555-5555-4555-8555-555555555555" },
    update: {},
    create: {
      id: "55555555-5555-4555-8555-555555555555",
      employeeId: employee.id,
      leaveTypeId: sickLeave.id,
      startDate: new Date("2026-06-12"),
      endDate: new Date("2026-06-12"),
      totalDays: 1,
      reason: "Medical appointment",
    },
  });

  const today = new Date();
  const attendanceDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  await prisma.attendanceRecord.upsert({
    where: {
      employeeId_attendanceDate_recordType_visitNumber: {
        employeeId: employee.id,
        attendanceDate,
        recordType: "OFFICE",
        visitNumber: 1,
      },
    },
    update: {},
    create: {
      employeeId: employee.id,
      attendanceDate,
      timeInAt: new Date(),
      status: "PRESENT",
    },
  });
}

main()
  .then(async () => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
