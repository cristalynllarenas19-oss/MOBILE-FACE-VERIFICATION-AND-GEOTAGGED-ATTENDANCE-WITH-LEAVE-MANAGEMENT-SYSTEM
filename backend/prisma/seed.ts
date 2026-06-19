import { PrismaClient, RoleCode } from "@prisma/client";
import * as argon2 from "argon2";

const prisma = new PrismaClient();

const permissionRows = [
  ["dashboard:view", "Dashboard"],
  ["users:read", "Users"],
  ["users:write", "Users"],
  ["employees:read", "Employees"],
  ["employees:write", "Employees"],
  ["attendance:read", "Attendance"],
  ["attendance:write", "Attendance"],
  ["leave:read", "Leave"],
  ["leave:write", "Leave"],
  ["schedules:read", "Schedules"],
  ["schedules:write", "Schedules"],
  ["reports:read", "Reports"],
] as const;

const rolePermissions: Record<RoleCode, string[]> = {
  ADMIN: permissionRows.map(([code]) => code),
  SUPERVISOR: ["dashboard:view", "employees:read", "attendance:read", "leave:read", "schedules:read", "reports:read"],
  EMPLOYEE: ["dashboard:view", "attendance:write", "leave:write"],
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

    for (const permissionCode of rolePermissions[code]) {
      const permission = await prisma.permission.findUniqueOrThrow({ where: { code: permissionCode } });
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
        update: {},
        create: { roleId: role.id, permissionId: permission.id },
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
    departmentId: quality.id,
    positionId: employeePosition.id,
    hireDate: new Date("2023-03-01"),
  });
  await prisma.employee.update({ where: { id: employee.id }, data: { supervisorId: supervisor.id } });

  for (const name of ["Vacation Leave", "Sick Leave", "Bereavement Leave", "Maternity Leave", "Paternity Leave", "Solo Parent Leave", "Special Leave"]) {
    await prisma.leaveType.upsert({
      where: { name },
      update: {},
      create: { name, defaultDays: name.includes("Vacation") || name.includes("Sick") ? 15 : 7, requiresDocument: !name.includes("Vacation") },
    });
  }

  const sickLeave = await prisma.leaveType.findUniqueOrThrow({ where: { name: "Sick Leave" } });
  const regularShift = await prisma.shift.upsert({
    where: { id: "66666666-6666-4666-8666-666666666666" },
    update: { name: "Regular Shift", startTime: "08:00", endTime: "17:00", gracePeriodMinutes: 10 },
    create: {
      id: "66666666-6666-4666-8666-666666666666",
      name: "Regular Shift",
      startTime: "08:00",
      endTime: "17:00",
      gracePeriodMinutes: 10,
    },
  });

  await prisma.shift.upsert({
    where: { id: "77777777-7777-4777-8777-777777777777" },
    update: { name: "Morning Shift", startTime: "06:00", endTime: "14:00", gracePeriodMinutes: 5 },
    create: {
      id: "77777777-7777-4777-8777-777777777777",
      name: "Morning Shift",
      startTime: "06:00",
      endTime: "14:00",
      gracePeriodMinutes: 5,
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
    where: { employeeId_attendanceDate: { employeeId: employee.id, attendanceDate } },
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
