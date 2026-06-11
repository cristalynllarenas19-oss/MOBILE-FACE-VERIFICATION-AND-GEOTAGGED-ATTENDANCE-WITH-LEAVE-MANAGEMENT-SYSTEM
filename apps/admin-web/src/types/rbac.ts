export const roles = {
  admin: "ADMIN",
  supervisor: "SUPERVISOR",
  employee: "EMPLOYEE",
} as const;

export const permissions = {
  dashboardView: "dashboard:view",
  usersRead: "users:read",
  employeesRead: "employees:read",
  attendanceRead: "attendance:read",
  leaveRead: "leave:read",
  schedulesRead: "schedules:read",
  reportsRead: "reports:read",
} as const;

export type PermissionCode = (typeof permissions)[keyof typeof permissions];
