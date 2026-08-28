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
  ["leave-types:write", "Leave Types"],
  ["schedules:read", "Schedules"],
  ["schedules:write", "Schedules"],
  ["reports:read", "Reports"],
  ["audit:read", "Audit"],
  ["geolocation:write", "Geolocation"],
  ["announcements:write", "Announcements"],
  ["evaluations:write", "Evaluations"],
] as const;

const rolePermissions: Record<RoleCode, string[]> = {
  ADMIN: permissionRows.map(([code]) => code),
  // leave:read/leave:approve let a Supervisor see their department's requests
  // and pre-approve them (Employee -> Supervisor -> HR chain) — without
  // these, a Supervisor account gets 403 on every leave endpoint.
  // geolocation:write lets a Supervisor create/edit/assign geotagged areas —
  // GeolocationService enforces the department boundary per-request, this
  // permission only gates whether they can hit the write endpoints at all.
  // employees:write is intentionally withheld — a Supervisor may only view
  // employees (employees:read) in their own department, never add, edit, or
  // archive them. Add/Edit Employee and Archive Employee in EmployeesPage
  // are all gated on this same permission (canWrite), so removing it here
  // hides them in the UI too — this list is the single source of truth for
  // both.
  // reports:read lets a Supervisor view the Reports page — ReportsService
  // already ANDs in getSupervisorDepartmentScope so they only ever see their
  // own department's data, same as Employees/Leave/Dashboard. Deliberately
  // does NOT imply audit:read — Utilities/Audit Logs stays HR/Admin-only, so
  // that page and reports:read must stay on separate permission codes.
  // evaluations:write lets a Supervisor view/save-draft/submit the
  // probationary evaluation of their own team members (ownership is
  // enforced per-request in EvaluationsService, same pattern as
  // geolocation:write's department-boundary check) — see EvaluationsService.
  SUPERVISOR: ["dashboard:view", "employees:read", "attendance:read", "schedules:read", "leave:read", "leave:approve", "geolocation:write", "reports:read", "evaluations:write"],
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

  // Keyed off userId (the true 1:1 anchor), not employeeNo — employeeNo gets
  // renumbered to the real ULPI-XXXXX scheme once HR edits an employee
  // through the app, so it no longer matches this seed's placeholder value.
  // An already-provisioned employee is left untouched rather than
  // re-synced: this is real, HR-edited data past first bootstrap, and
  // overwriting department/position/hireDate/employeeNo with the seed's
  // placeholders on every reseed would silently discard those edits.
  // `isNew` lets main() gate the demo supervisor link / schedule / leave
  // request / attendance record on "this account was just bootstrapped",
  // so a reseed never fabricates records against an already-real employee.
  const existingEmployee = await prisma.employee.findUnique({ where: { userId: user.id } });
  if (existingEmployee) return { employee: existingEmployee, isNew: false };

  const created = await prisma.employee.create({ data: { ...employee, userId: user.id } });
  return { employee: created, isNew: true };
}

async function seedAttendanceModeOptions() {
  const modes = [
    {
      code: "FIXED",
      label: "Non-field",
      description: "Regular office-based attendance mode.",
      sortOrder: 10,
      availableForEmployees: true,
      availableForDepartments: true,
    },
    {
      code: "FIELD",
      label: "Field",
      description: "Field/site visit attendance mode.",
      sortOrder: 20,
      availableForEmployees: true,
      availableForDepartments: true,
    },
    {
      code: "BOTH",
      label: "Both",
      description: "No department-level restriction.",
      sortOrder: 30,
      availableForEmployees: false,
      availableForDepartments: true,
    },
  ];

  for (const mode of modes) {
    await prisma.$executeRaw`
      INSERT INTO attendance_mode_options (
        id,
        code,
        label,
        description,
        sort_order,
        is_active,
        available_for_employees,
        available_for_departments
      )
      VALUES (
        gen_random_uuid()::text,
        ${mode.code},
        ${mode.label},
        ${mode.description},
        ${mode.sortOrder},
        true,
        ${mode.availableForEmployees},
        ${mode.availableForDepartments}
      )
      ON CONFLICT (code) DO UPDATE SET
        label = EXCLUDED.label,
        description = EXCLUDED.description,
        sort_order = EXCLUDED.sort_order,
        is_active = EXCLUDED.is_active,
        available_for_employees = EXCLUDED.available_for_employees,
        available_for_departments = EXCLUDED.available_for_departments
    `;
  }
}

async function main() {
  await seedAttendanceModeOptions();
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
    firstName: "Cristalyn",
    lastName: "Llarenas",
    departmentId: hr.id,
    positionId: hrPosition.id,
    hireDate: new Date("2021-01-15"),
  });
  const { employee: supervisor } = await upsertUser("supervisor@universal-leaf.com", "password123", "SUPERVISOR", {
    employeeNo: "UL-002",
    firstName: "James",
    lastName: "Higoy",
    departmentId: production.id,
    positionId: supervisorPosition.id,
    hireDate: new Date("2020-05-10"),
  });
  const { employee, isNew: isNewEmployee } = await upsertUser("employee@universal-leaf.com", "password123", "EMPLOYEE", {
    employeeNo: "UL-003",
    firstName: "Zean",
    lastName: "Marquez",
    // Must match `supervisor`'s department (Production) — EmployeesService now
    // rejects a supervisorId whose department differs from the employee's,
    // and this employee/supervisor pairing exists specifically to demo that
    // Employee -> Supervisor -> HR leave approval chain.
    departmentId: production.id,
    positionId: employeePosition.id,
    hireDate: new Date("2023-03-01"),
  });
  // Only wire the demo supervisor link on first bootstrap — on an
  // already-real employee this would silently overwrite a supervisor
  // reassignment HR made since through the app.
  if (isNewEmployee) {
    await prisma.employee.update({ where: { id: employee.id }, data: { supervisorId: supervisor.id } });
  }

  const allClassifications = ["REGULAR", "CONTRACTUAL_SEASONAL", "PIECE_RATE", "SEPARATED"] as const;

  // Leave Types are HR/Admin-managed business data from here on (Utilities ->
  // Leave Types), not developer-seeded — this single row just keeps the page
  // from being completely empty on first boot. HR adds everything else
  // (Sick, Maternity, Paternity, etc.) themselves, picking each type's Kind
  // (General/Maternity/Paternity) from the form.
  const vacationLeave = await prisma.leaveType.upsert({
    where: { name: "Vacation Leave" },
    update: {},
    create: {
      name: "Vacation Leave",
      defaultDays: 15,
      requiresDocument: false,
      isAutoCredited: true,
      applicableStatuses: [...allClassifications],
    },
  });
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

  // Demo schedule/leave-request/attendance-record only ever get fabricated
  // for a brand-new bootstrap employee — attaching them to an already-real
  // employee (isNewEmployee false) would plant a fake pending leave request
  // and a fake attendance clock-in under a real person's name.
  if (isNewEmployee) {
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
        leaveTypeId: vacationLeave.id,
        startDate: new Date("2026-06-12"),
        endDate: new Date("2026-06-12"),
        totalDays: 1,
        reason: "Family trip",
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
}

main()
  .then(async () => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
