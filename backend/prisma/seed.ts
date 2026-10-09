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
  ["employee-types:write", "Employee Types"],
] as const;

// Initial rows for Utilities → Employee Types — after first boot these are
// HR-managed data (renamable/archivable in the app), so an existing row is
// never overwritten here. Each carries the existing EmploymentStatus its
// employees get.
const initialEmployeeTypes = [
  { name: "Regular Employee", employmentStatus: "REGULAR" },
  { name: "Probationary Employee", employmentStatus: "PROBATIONARY" },
  { name: "Permanent Seasonal Employee", employmentStatus: "PERMANENT_SEASONAL" },
  { name: "Probationary Seasonal Employee", employmentStatus: "PROBATIONARY_SEASONAL" },
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
  employeeTypeId: string;
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
        code,
        label,
        description,
        sort_order,
        is_active,
        available_for_employees,
        available_for_departments
      )
      VALUES (
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

  for (const type of initialEmployeeTypes) {
    await prisma.employeeType.upsert({ where: { name: type.name }, update: {}, create: type });
  }
  const regularEmployeeType = await prisma.employeeType.findUniqueOrThrow({ where: { name: "Regular Employee" } });

  const hr = await prisma.department.upsert({ where: { name: "Human Resources" }, update: {}, create: { name: "Human Resources" } });
  const production = await prisma.department.upsert({ where: { name: "Production" }, update: {}, create: { name: "Production" } });
  const quality = await prisma.department.upsert({ where: { name: "Quality Control" }, update: {}, create: { name: "Quality Control" } });
  // Ids are database-generated (POS-1001, ...), so bootstrap rows are matched
  // by their natural key instead of a hardcoded id.
  const ensurePosition = async (title: string) =>
    (await prisma.position.findFirst({ where: { title } })) ?? (await prisma.position.create({ data: { title } }));
  const hrPosition = await ensurePosition("HR Personnel");
  const supervisorPosition = await ensurePosition("Department Supervisor");
  const employeePosition = await ensurePosition("Leaf Processor");

  // Initial Utilities → Positions rows (one shared row each). Only created
  // when missing — after first boot these are HR-managed data.
  const initialPositions = [
    { title: "Senior Manager", departmentScope: "ALL", departmentIds: [] as string[] },
    { title: "Manager I", departmentScope: "ALL_EXCEPT", departmentIds: [hr.id] },
    { title: "Manager II", departmentScope: "ALL_EXCEPT", departmentIds: [hr.id] },
    { title: "Manager Trainee", departmentScope: "ONLY", departmentIds: [hr.id] },
    { title: "HR Manager I", departmentScope: "ONLY", departmentIds: [hr.id] },
    { title: "HR Manager II", departmentScope: "ONLY", departmentIds: [hr.id] },
    { title: "HR Director", departmentScope: "ONLY", departmentIds: [hr.id] },
  ] as const;
  for (const position of initialPositions) {
    if (await prisma.position.findFirst({ where: { title: position.title } })) continue;
    await prisma.position.create({
      data: {
        title: position.title,
        departmentScope: position.departmentScope,
        departments: { create: position.departmentIds.map((departmentId) => ({ departmentId })) },
      },
    });
  }

  // Coordinates match the canonical Office record already live in
  // production — only created when no area of this name exists yet.
  const officeName = "Universal Leaf Philippines Inc. - Agoo";
  if (!(await prisma.workLocation.findFirst({ where: { name: officeName } }))) {
    await prisma.workLocation.create({
      data: {
        name: officeName,
        latitude: 16.358048,
        longitude: 120.353511,
        radiusMeters: 1000,
        allowedAccuracyMeters: 50,
      },
    });
  }

  await upsertUser("hradmin@universal-leaf.com", "password123", "ADMIN", {
    employeeNo: "UL-001",
    firstName: "Cristalyn",
    lastName: "Llarenas",
    departmentId: hr.id,
    positionId: hrPosition.id,
    employeeTypeId: regularEmployeeType.id,
    hireDate: new Date("2021-01-15"),
  });
  const { employee: supervisor } = await upsertUser("supervisor@universal-leaf.com", "password123", "SUPERVISOR", {
    employeeNo: "UL-002",
    firstName: "James",
    lastName: "Higoy",
    departmentId: production.id,
    positionId: supervisorPosition.id,
    employeeTypeId: regularEmployeeType.id,
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
    employeeTypeId: regularEmployeeType.id,
    hireDate: new Date("2023-03-01"),
  });
  // Only wire the demo supervisor link on first bootstrap — on an
  // already-real employee this would silently overwrite a supervisor
  // reassignment HR made since through the app.
  if (isNewEmployee) {
    await prisma.employee.update({ where: { id: employee.id }, data: { supervisorId: supervisor.id } });
  }

  const allClassifications = ["REGULAR", "PERMANENT_SEASONAL", "PROBATIONARY_SEASONAL", "SEPARATED"] as const;

  // Leave Types are HR/Admin-managed business data from here on (Utilities ->
  // Leave Types), not developer-seeded — this single row just keeps the page
  // from being completely empty on first boot. HR adds everything else
  // (Sick, Maternity, Paternity, etc.) themselves, picking each type's Kind
  // (General/Maternity/Paternity) from the form.
  let vacationLeave = await prisma.leaveType.findUnique({ where: { name: "Vacation Leave" } });
  if (!vacationLeave) {
    // Leave type ids carry a category code (LT-VL-001) — same database
    // function LeaveTypesService.create uses.
    const [{ id: vacationLeaveId }] = await prisma.$queryRaw<{ id: string }[]>`SELECT next_leave_type_id(${"Vacation Leave"}) AS id`;
    vacationLeave = await prisma.leaveType.create({
      data: {
        id: vacationLeaveId,
        name: "Vacation Leave",
        defaultDays: 15,
        requiresDocument: false,
        isAutoCredited: true,
        isSeasonalAccrualEligible: true,
        applicableStatuses: [...allClassifications],
      },
    });
  }

  const ensureShift = async (name: string, startTime: string, endTime: string) => {
    const data = { name, startTime, endTime, lateThresholdMinutes: 10 };
    const existing = await prisma.shift.findFirst({ where: { name } });
    return existing ? prisma.shift.update({ where: { id: existing.id }, data }) : prisma.shift.create({ data });
  };
  const regularShift = await ensureShift("Standard Shift", "08:00", "17:00");
  await ensureShift("Alternative Shift", "09:00", "18:00");

  // Demo schedule/leave-request/attendance-record only ever get fabricated
  // for a brand-new bootstrap employee — attaching them to an already-real
  // employee (isNewEmployee false) would plant a fake pending leave request
  // and a fake attendance clock-in under a real person's name.
  if (isNewEmployee) {
    await prisma.employeeSchedule.create({
      data: {
        employeeId: employee.id,
        shiftId: regularShift.id,
        startsOn: new Date("2026-06-01"),
      },
    });

    await prisma.leaveRequest.create({
      data: {
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
