export const roles = {
  admin: "ADMIN",
  supervisor: "SUPERVISOR",
  employee: "EMPLOYEE",
} as const;

export type RoleCode = (typeof roles)[keyof typeof roles];

export const permissions = {
  dashboardView: "dashboard:view",
  usersRead: "users:read",
  usersCreate: "users:write",
  usersUpdate: "users:write",
  employeesRead: "employees:read",
  employeesManage: "employees:write",
  attendanceRead: "attendance:read",
  attendanceCreate: "attendance:write",
  attendanceValidate: "attendance:write",
  leaveRead: "leave:read",
  leaveCreate: "leave:write",
  leaveApprove: "leave:write",
  schedulesRead: "schedules:read",
  schedulesManage: "schedules:write",
  reportsRead: "reports:read",
  reportsExport: "reports:read",
} as const;

export type PermissionCode = (typeof permissions)[keyof typeof permissions];

export type AuthUser = {
  id: string;
  email: string;
  role: RoleCode;
  permissions: PermissionCode[];
  employeeId?: string;
  displayName: string;
};

export type LoginResponse = {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
};

export type AttendanceVerificationStatus = "APPROVED" | "REJECTED" | "PENDING_REVIEW";

export type GeoPoint = {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
};
