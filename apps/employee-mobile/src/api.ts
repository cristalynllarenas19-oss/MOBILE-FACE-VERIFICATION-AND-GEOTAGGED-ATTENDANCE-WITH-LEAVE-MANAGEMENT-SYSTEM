import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";
import { clearDataCache } from "./utils/dataCache";

const DEFAULT_API_BASE_URL = "https://mobile-face-verification-and-geotagged.onrender.com/api/v1";

function getMetroHost() {
  const metroHost = (
    Constants as unknown as {
      expoConfig?: { hostUri?: string };
      manifest?: { debuggerHost?: string };
      manifest2?: { extra?: { expoClient?: { hostUri?: string } } };
    }
  ).expoConfig?.hostUri
    ?? (Constants as unknown as { manifest?: { debuggerHost?: string } }).manifest?.debuggerHost
    ?? (Constants as unknown as { manifest2?: { extra?: { expoClient?: { hostUri?: string } } } }).manifest2?.extra?.expoClient?.hostUri;

  return metroHost?.split(":")[0];
}

function replaceHost(url: string, host: string) {
  try {
    const parsed = new URL(url);
    parsed.hostname = host;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

function isLoopbackOrPrivateHost(host: string) {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  );
}

function getApiBaseUrls() {
  const configuredUrl = process.env.EXPO_PUBLIC_API_BASE_URL ?? DEFAULT_API_BASE_URL;
  const metroHost = getMetroHost();
  const urls = [configuredUrl];

  if (metroHost) {
    try {
      const parsed = new URL(configuredUrl);
      if (isLoopbackOrPrivateHost(parsed.hostname)) {
        urls.push(replaceHost(configuredUrl, metroHost));
      }
    } catch {
      // If the configured URL cannot be parsed, fall back to the raw value.
    }
  }

  return [...new Set(urls)];
}

const API_BASE_URLS = getApiBaseUrls();

let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler;
}

// The legal set of attendance mode codes is DB-driven (GET
// /departments/attendance-modes on the backend), not a compiled union.
export type AttendanceMode = string;
export type AttendanceRecordType = "OFFICE" | "FIELD";

export type MobileUser = {
  id: string;
  email: string;
  role: string;
  // All optional so a stale cached session from before these fields existed
  // still type-checks — anywhere these are read, treat undefined as "no
  // elevated role"/"no extra permissions" (i.e. plain employee behavior).
  roles?: string[];
  permissions?: string[];
  departmentId?: string;
  // Sent as a plain name string by POST /auth/login (auth.service.ts), not
  // a nested object — unlike EmployeeProfile.department below, which comes
  // from a different endpoint (GET /employees/me) that does nest it.
  department?: string;
  defaultView?: "ADMIN" | "EMPLOYEE";
  employeeId?: string;
  displayName: string;
  mustChangePassword?: boolean;
  // Optional so a stale cached session from before this field existed still
  // type-checks; anywhere this is read, treat undefined the same as "FIXED".
  attendanceMode?: AttendanceMode;
};
export type TodayAttendance = {
  status: string;
  timeInAt: string | null;
  timeOutAt: string | null;
  // Optional, OFFICE-only lunch break window — always null for FIELD visits.
  lunchOutAt?: string | null;
  lunchInAt?: string | null;
  visitNumber?: number;
  workLocationId?: string | null;
  recordType?: AttendanceRecordType;
};

// Both must hold before Time In (and therefore Lunch/Time Out, which all
// require having timed in first) is even attempted — checked up front so an
// employee never goes through the whole camera/liveness flow only to be
// rejected by the backend's own equivalent check inside submit().
export type AttendanceEligibility = {
  faceEnrolled: boolean;
  hasWorkLocation: boolean;
};

export type AttendanceSubmitResult = {
  approved: boolean;
  verificationStatus: string;
  logType: "TIME_IN" | "TIME_OUT" | "LUNCH_OUT" | "LUNCH_IN";
  geoResult: { reason?: string | null };
  faceResult: { reason?: string | null };
  faceImage?: string | null;
};

export type SubmitAttendanceInput = {
  employeeId: string;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  livenessScore: number;
  similarityScore: number;
  faceImageBase64: string;
  deviceId: string;
  // Which assigned site this visit is at — required when starting a new
  // visit as a FIELD employee, omitted for FIXED employees and for ending
  // a visit (the server resolves the site from the open record itself).
  workLocationId?: string;
  // Which of several legal next actions this scan is for, once the employee
  // has already timed in — the server can no longer infer this from state
  // alone since Time Out, Lunch Out, and Lunch In can all be valid at once.
  // Omitted for Time In.
  action?: "TIME_OUT" | "LUNCH_OUT" | "LUNCH_IN";
};

export type AttendanceLogPhoto = {
  id: string;
  logType: "TIME_IN" | "TIME_OUT" | "LUNCH_OUT" | "LUNCH_IN" | "FAILED_ATTEMPT";
  capturedAt: string;
  verificationStatus: string;
  failureReason: string | null;
  faceImageData: string | null;
  faceImageMimeType: string | null;
};

export type AttendanceHistoryRecord = {
  id: string;
  attendanceDate: string;
  timeInAt: string | null;
  timeOutAt: string | null;
  lunchOutAt?: string | null;
  lunchInAt?: string | null;
  status: string;
  totalMinutes: number;
  visitNumber?: number;
  workLocationId?: string | null;
  workLocation?: { name: string } | null;
  recordType?: AttendanceRecordType;
  logs: AttendanceLogPhoto[];
};

export type WorkLocation = {
  id: string;
  name: string;
  latitude: string | number;
  longitude: string | number;
  radiusMeters: string | number;
  allowedAccuracyMeters: string | number;
};

export type EmployeeProfile = {
  id: string;
  firstName: string;
  lastName: string;
  contactNumber: string | null;
  profilePhotoData: string | null;
  profilePhotoMimeType: string | null;
  // Only present on the GET /employees/me response (not on the photo-update
  // response) — whether this employee has an ACTIVE FaceProfile enrolled.
  hasActiveFaceEnrollment?: boolean;
  user: { email: string };
  department: { name: string };
  position: { title: string };
};

export type LeaveType = {
  id: string;
  name: string;
  defaultDays: string;
  requiresDocument: boolean;
  supportingDocumentAfterDays?: number | null;
  requiresEhsActivation?: boolean;
  ehsActivated?: boolean;
  allowWithoutPay: boolean;
  isUnlimitedDays: boolean;
  isActive: boolean;
  requiresAdminGrant: boolean;
  isSingleDayOnly: boolean;
  advanceFilingAllowed: boolean;
};

export type LeaveBalance = {
  leaveTypeId: string;
  leaveTypeName: string;
  year: number;
  earnedDays: number;
  usedDays: number;
  remainingDays: number;
};

export type LeaveRequestNote = {
  id: string;
  type: "REJECTED" | "RESUBMITTED";
  message?: string | null;
  requiresAdditionalRequirements?: boolean;
  requirementDetails?: string | null;
  attachmentName?: string | null;
  createdAt: string;
};

export type LeaveRequest = {
  id: string;
  startDate: string;
  endDate: string;
  totalDays: string;
  status: string;
  reason: string;
  attachmentName?: string | null;
  adminRemarks?: { remarks?: string } | null;
  notes?: LeaveRequestNote[];
  leaveType: { id: string; name: string };
};

export type CreateLeaveRequestInput = {
  employeeId: string;
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  reason: string;
  attachmentName?: string;
  attachmentMimeType?: string;
  attachmentData?: string;
};

export type ResubmitLeaveRequestInput = {
  note?: string;
  attachmentName: string;
  attachmentMimeType: string;
  attachmentData: string;
};

export type AppNotification = {
  id: string;
  title: string;
  message: string;
  type: string | null;
  entityId: string | null;
  readAt: string | null;
  createdAt: string;
};

export async function apiRequest<T>(path: string, options: RequestInit = {}) {
  const token = await SecureStore.getItemAsync("accessToken");
  let response: Response | null = null;

  for (const baseUrl of API_BASE_URLS) {
    const url = `${baseUrl}${path}`;
    console.log("REQUEST:", url);

    try {
      response = await fetch(url, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...options.headers,
        },
      });
      break;
    } catch (error) {
      console.warn(`API request failed for ${url}`, error);
    }
  }

  if (!response) {
    throw new Error(`Cannot reach API server. Check internet connection or API URL: ${API_BASE_URLS.join(" or ")}`);
  }

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 401) {
      clearDataCache();
      await SecureStore.deleteItemAsync("accessToken");
      await SecureStore.deleteItemAsync("refreshToken");
      await SecureStore.deleteItemAsync("sessionUser");
      unauthorizedHandler?.();
    }
    throw new Error(extractErrorMessage(body) || `Request failed with status ${response.status}`);
  }

  // Nest's Express adapter treats a controller returning `null` the same as
  // `undefined` and sends a completely empty body (not the literal string
  // "null") — response.json() throws "Unexpected end of input" on that, so
  // an empty-but-ok body is read as text first and treated as `null`.
  const text = await response.text();
  return (text ? JSON.parse(text) : null) as T;
}

function extractErrorMessage(body: string) {
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed?.message)) return parsed.message.join(" ");
    if (typeof parsed?.message === "string") return parsed.message;
  } catch {
    // Not JSON, fall back to the raw text below.
  }
  return body;
}

export async function checkApiHealth() {
  return apiRequest<{ ok: boolean; service: string; checkedAt: string }>("/health");
}

export async function login(email: string, password?: string) {
  const data = await apiRequest<{ accessToken: string; refreshToken: string; user: MobileUser }>("/auth/login", {
    method: "POST",
    body: JSON.stringify(password ? { email, password } : { email }),
  });
  // A different account may have logged in on this device — never let it
  // see the previous account's cached data.
  clearDataCache();
  await SecureStore.setItemAsync("accessToken", data.accessToken);
  await SecureStore.setItemAsync("refreshToken", data.refreshToken);
  await SecureStore.setItemAsync("sessionUser", JSON.stringify(data.user));
  return data.user;
}

// Restores the last logged-in user so the app opens straight to their
// portal without a network round-trip. Returns null when nobody is
// logged in (no token) or the saved user predates this feature.
export async function restoreSession(): Promise<MobileUser | null> {
  const token = await SecureStore.getItemAsync("accessToken");
  if (!token) return null;
  const savedUser = await SecureStore.getItemAsync("sessionUser");
  if (!savedUser) return null;
  try {
    return JSON.parse(savedUser) as MobileUser;
  } catch {
    return null;
  }
}

export async function logout() {
  clearDataCache();
  await SecureStore.deleteItemAsync("accessToken");
  await SecureStore.deleteItemAsync("refreshToken");
  await SecureStore.deleteItemAsync("sessionUser");
}

export async function forgotPassword(email: string) {
  return apiRequest<{ message: string }>("/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function verifyResetOtp(email: string, otp: string) {
  return apiRequest<{ resetToken: string }>("/auth/reset-password/verify-otp", {
    method: "POST",
    body: JSON.stringify({ email, otp }),
  });
}

export async function resetPassword(resetToken: string, newPassword: string) {
  return apiRequest<{ message: string }>("/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({ resetToken, newPassword }),
  });
}

export async function getTodayAttendance(
  employeeId: string,
) {
  return apiRequest<TodayAttendance>(
    `/attendance/today/${employeeId}`,
  );
}

export type FaceBox = { x: number; y: number; width: number; height: number };

export async function detectFace(imageBase64: string, precise = false) {
  return apiRequest<{ detected: boolean; confidence: number; box: FaceBox | null; ear: number | null }>(
    "/face/detect",
    {
      method: "POST",
      body: JSON.stringify({ imageBase64, precise }),
    },
  );
}

export async function submitAttendance(input: SubmitAttendanceInput) {
  return apiRequest<AttendanceSubmitResult>("/attendance/submit", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getAttendanceHistory(employeeId: string, limit = 30) {
  return apiRequest<AttendanceHistoryRecord[]>(`/attendance/history/${employeeId}?limit=${limit}`);
}

export async function getMyWorkLocation() {
  return apiRequest<WorkLocation | null>("/geolocation/my-location");
}

export async function getMyWorkLocations() {
  return apiRequest<WorkLocation[]>("/geolocation/my-locations");
}

export async function getMyProfile() {
  return apiRequest<EmployeeProfile>("/employees/me");
}

export async function updateMyPhoto(profilePhotoData: string, profilePhotoMimeType: string) {
  return apiRequest<EmployeeProfile>("/employees/me/photo", {
    method: "PATCH",
    body: JSON.stringify({ profilePhotoData, profilePhotoMimeType }),
  });
}

export async function changePassword(currentPassword: string, newPassword: string) {
  return apiRequest<{ message: string }>("/users/me/password", {
    method: "PATCH",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export async function setInitialPassword(currentPassword: string, newPassword: string) {
  return apiRequest<{ message: string }>("/users/me/password", {
    method: "PATCH",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export async function getLeaveTypes() {
  return apiRequest<LeaveType[]>("/leave-types");
}

export async function getLeaveBalances(employeeId: string) {
  return apiRequest<LeaveBalance[]>(`/leave-balances/${employeeId}?year=${new Date().getFullYear()}`);
}

export async function getLeaveRequests(employeeId: string) {
  return apiRequest<LeaveRequest[]>(`/leave-requests?employeeId=${employeeId}`);
}

export async function createLeaveRequest(input: CreateLeaveRequestInput) {
  return apiRequest<LeaveRequest>("/leave-requests", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function resubmitLeaveRequest(id: string, input: ResubmitLeaveRequestInput) {
  return apiRequest<LeaveRequest>(`/leave-requests/${id}/resubmit`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function cancelLeaveRequest(id: string) {
  return apiRequest<LeaveRequest>(`/leave-requests/${id}/cancel`, { method: "PATCH" });
}

export type UndertimeEligibility = {
  isFilingDay: boolean;
  filingDaysOfMonth: number[];
  maxFilingsPerMonth: number;
  filedThisMonth: number;
  remaining: number;
  alreadyFiledToday: boolean;
  eligible: boolean;
};

export type UndertimeFiling = {
  id: string;
  filingDate: string;
  reason: string | null;
  createdAt: string;
};

export async function getUndertimeEligibility(employeeId: string) {
  return apiRequest<UndertimeEligibility>(`/undertime-filings/eligibility/${employeeId}`);
}

export async function getUndertimeFilings(employeeId: string) {
  return apiRequest<UndertimeFiling[]>(`/undertime-filings?employeeId=${employeeId}`);
}

export async function fileUndertime(employeeId: string, reason?: string) {
  return apiRequest<UndertimeFiling>("/undertime-filings", {
    method: "POST",
    body: JSON.stringify({ employeeId, reason }),
  });
}

export async function getNotifications() {
  return apiRequest<AppNotification[]>("/notifications/me");
}

export async function getUnreadNotificationCount() {
  return apiRequest<{ count: number }>("/notifications/me/unread-count");
}

export async function markNotificationRead(id: string) {
  return apiRequest(`/notifications/${id}/read`, { method: "PATCH" });
}

export async function markAllNotificationsRead() {
  return apiRequest("/notifications/read-all", { method: "PATCH" });
}

// ── Supervisor endpoints ─────────────────────────────────────────────────
// Every call below hits the same backend routes admin-web's Supervisor
// portal uses, so department-scoping and read/write permission enforcement
// (getSupervisorDepartmentScope, @RequirePermissions) is identical — nothing
// extra to re-implement client-side beyond mirroring the UI gating.

export type DashboardSummary = {
  stats: {
    totalEmployees: number;
    presentToday: number;
    lateToday: number;
    absentToday: number;
    pendingLeaves: number;
    geotaggedLogs: number;
  };
  enrollment: { enrolled: number; total: number };
  geotagging: { assigned: number; total: number };
  calendar: { monthLabel: string; days: { date: string; status?: string }[] };
};

export async function getDashboardSummary(month?: number, year?: number) {
  const params = new URLSearchParams();
  if (month !== undefined) params.set("month", String(month + 1));
  if (year !== undefined) params.set("year", String(year));
  const qs = params.toString();
  return apiRequest<DashboardSummary>(`/dashboard/summary${qs ? `?${qs}` : ""}`);
}

export type TeamEmployee = {
  id: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
  email?: string;
  employmentStatus: string;
  attendanceMode?: AttendanceMode;
  sex?: "MALE" | "FEMALE";
  hireDate?: string;
  department?: { id: string; name: string } | null;
  position?: { title: string } | null;
  supervisorId?: string | null;
};

export type CreateTeamEmployeeInput = {
  firstName: string;
  lastName: string;
  email: string;
  department: string;
  hireDate?: string;
  employmentStatus: "REGULAR" | "PROBATIONARY" | "CONTRACTUAL_SEASONAL" | "PIECE_RATE";
  attendanceMode?: AttendanceMode;
  sex: "MALE" | "FEMALE";
  supervisorId?: string;
};

export type UpdateTeamEmployeeInput = Partial<Omit<CreateTeamEmployeeInput, "email">> & { email?: string };

export async function getTeamEmployees() {
  return apiRequest<TeamEmployee[]>("/employees");
}

export async function getSupervisorOptions() {
  return apiRequest<TeamEmployee[]>("/employees/supervisors");
}

export async function createTeamEmployee(input: CreateTeamEmployeeInput) {
  return apiRequest<TeamEmployee>("/employees", { method: "POST", body: JSON.stringify(input) });
}

export async function updateTeamEmployee(id: string, input: UpdateTeamEmployeeInput) {
  return apiRequest<TeamEmployee>(`/employees/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export async function archiveTeamEmployee(id: string, reason?: string) {
  return apiRequest<TeamEmployee>(`/employees/${id}/archive`, { method: "PATCH", body: JSON.stringify({ reason }) });
}

export type TeamAttendanceRecord = {
  id: string;
  attendanceDate: string;
  timeInAt?: string | null;
  timeOutAt?: string | null;
  lunchOutAt?: string | null;
  lunchInAt?: string | null;
  status: string;
  visitNumber?: number;
  workLocation?: { name: string } | null;
  employee: {
    employeeNo?: string;
    firstName: string;
    lastName: string;
    department: { name: string };
  };
};

export async function getTeamAttendance(params?: { department?: string; status?: string; date?: string; from?: string; to?: string }) {
  const qs = new URLSearchParams(params as Record<string, string>).toString();
  return apiRequest<TeamAttendanceRecord[]>(`/attendance${qs ? `?${qs}` : ""}`);
}

export type GeoEmployeeOption = {
  id: string;
  firstName: string;
  lastName: string;
  department: { id: string; name: string };
};

export type GeotaggedLocation = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  isActive?: boolean;
  departmentId?: string | null;
  department?: { id: string; name: string } | null;
  type?: "OFFICE" | "FIELD";
  employees?: Array<{ employee: GeoEmployeeOption }>;
};

export async function getGeotaggedLocations() {
  return apiRequest<GeotaggedLocation[]>("/geolocation/locations");
}

export async function assignEmployeeToLocation(locationId: string, employeeId: string) {
  return apiRequest<GeotaggedLocation>(`/geolocation/locations/${locationId}/employees/${employeeId}`, { method: "POST" });
}

export async function unassignEmployeeFromLocation(locationId: string, employeeId: string) {
  return apiRequest<GeotaggedLocation>(`/geolocation/locations/${locationId}/employees/${employeeId}`, { method: "DELETE" });
}

export type TeamLeaveRequest = {
  id: string;
  startDate: string;
  endDate: string;
  totalDays: string;
  status: string;
  reason: string;
  createdAt: string;
  adminRemarks?: { remarks?: string } | null;
  attachmentName?: string | null;
  extensionRequested?: boolean;
  extensionApproved?: boolean | null;
  employee: {
    id: string;
    firstName: string;
    lastName: string;
    department?: { name: string };
  };
  leaveType: { id: string; name: string };
};

export async function getTeamLeaveRequests() {
  return apiRequest<TeamLeaveRequest[]>("/leave-requests");
}

export async function approveLeaveRequest(id: string, remarks?: string) {
  return apiRequest<TeamLeaveRequest>(`/leave-requests/${id}/approve`, {
    method: "PATCH",
    body: JSON.stringify({ remarks: remarks?.trim() ?? "" }),
  });
}

export async function rejectLeaveRequest(
  id: string,
  input: { remarks: string; requiresAdditionalRequirements?: boolean; requirementDetails?: string },
) {
  return apiRequest<TeamLeaveRequest>(`/leave-requests/${id}/reject`, { method: "PATCH", body: JSON.stringify(input) });
}

export type ScheduleAssignment = {
  id: string;
  startsOn: string;
  endsOn?: string | null;
  employee: { id: string; firstName: string; lastName: string; department: { name: string } };
  shift: { id: string; name: string; startTime: string; endTime: string };
};

export type Shift = { id: string; name: string; startTime: string; endTime: string };

export async function getSchedules() {
  return apiRequest<ScheduleAssignment[]>("/schedules");
}

export async function getShifts() {
  return apiRequest<Shift[]>("/schedules/shifts");
}

export type ReportsSummary = {
  generatedAt: string;
  totals: {
    attendanceRecords: number;
    approvedLeaves: number;
    pendingLeaves: number;
    activeSchedules: number;
  };
  attendanceByStatus: Record<string, number>;
  leaveByStatus: Record<string, number>;
};

export async function getReportsSummary(params?: { from?: string; to?: string; department?: string }) {
  const qs = new URLSearchParams(params as Record<string, string>).toString();
  return apiRequest<ReportsSummary>(`/reports${qs ? `?${qs}` : ""}`);
}
