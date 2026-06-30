export const roles = {
  admin: "ADMIN",
  supervisor: "SUPERVISOR",
  employee: "EMPLOYEE",
} as const;

export const permissions = {
  dashboardView: "dashboard:view",
  usersRead: "users:read",
  usersWrite: "users:write",
  employeesRead: "employees:read",
  employeesWrite: "employees:write",
  attendanceRead: "attendance:read",
  attendanceWrite: "attendance:write",
  leaveRead: "leave:read",
  schedulesRead: "schedules:read",
  schedulesWrite: "schedules:write",
  reportsRead: "reports:read",
  geolocationWrite: "geolocation:write",

  // Employee self-service permissions (mirrors employee-mobile)
  employeeAttendanceView: "employee-attendance:view",
  employeeLeaveView:      "employee-leave:view",
  employeeDtrView:        "employee-dtr:view",
  employeeWorkAreaView:   "employee-work-area:view",
  employeeSettingsView:   "employee-settings:view",
} as const;

export type PermissionCode = (typeof permissions)[keyof typeof permissions];
