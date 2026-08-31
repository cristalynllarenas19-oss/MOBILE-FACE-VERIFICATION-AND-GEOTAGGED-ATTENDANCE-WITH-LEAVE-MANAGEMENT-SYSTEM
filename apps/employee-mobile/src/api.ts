import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";
import { clearDataCache } from "./utils/dataCache";

const DEFAULT_API_BASE_URL = "http://localhost:3001/api/v1";
// "https://mobile-face-verification-and-geotagged.onrender.com/api/v1"

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
// let refreshPromise: Promise<string | null> | null = null; // refresh tokens disabled — see refreshAccessToken() below

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
  // Null/undefined = consent still pending (admin cannot face-register this
  // employee yet); set once the employee accepts on FaceConsentScreen. Only
  // meaningful when requiresFaceConsent is true — pre-existing employees are
  // grandfathered out and never show this screen regardless of this value.
  faceConsentAcceptedAt?: string | null;
  requiresFaceConsent?: boolean;
};
export type TodayAttendance = {
  status: string;
  timeInAt: string | null;
  timeOutAt: string | null;
  // Optional, OFFICE-only lunch break window — always null for FIELD visits.
  lunchOutAt?: string | null;
  lunchInAt?: string | null;
  // Shift-rounded official start time — a same-day arrival within the grace
  // window is bumped up to the next 30-minute mark past shift start (e.g. a
  // 7:01 arrival renders as 7:30). Falls back to timeInAt when absent.
  renderTimeInAt?: string | null;
  // renderTimeInAt (or timeInAt) plus 9 hours, so the 1-hour lunch break
  // doesn't eat into the 8 hours actually worked.
  expectedTimeOutAt?: string | null;
  visitNumber?: number;
  workLocationId?: string | null;
  recordType?: AttendanceRecordType;
  // True once the same-day flagged-attempt count has already reached the
  // backend's notify threshold AND at least one of today's flagged attempts
  // is still unresolved. The app warns on the next tap of ANY attendance
  // button (Time In, Time Out, Lunch Out/In) that an unauthorized attempt
  // was detected on the account, rather than opening the camera straight
  // away — account-wide, not scoped to whichever specific action was
  // originally flagged.
  hasUnresolvedFlaggedAttempt?: boolean;
};

// Both must hold before Time In (and therefore Lunch/Time Out, which all
// require having timed in first) is even attempted — checked up front so an
// employee never goes through the whole camera/liveness flow only to be
// rejected by the backend's own equivalent check inside submit().
export type AttendanceEligibility = {
  faceEnrolled: boolean;
  hasWorkLocation: boolean;
  hasScheduleToday: boolean;
};

export type AttendanceSubmitResult = {
  approved: boolean;
  verificationStatus: string;
  logType: "TIME_IN" | "TIME_OUT" | "LUNCH_OUT" | "LUNCH_IN";
  geoResult: { reason?: string | null };
  faceResult: { reason?: string | null };
  // How many same-day flagged (PENDING_REVIEW — borderline face match)
  // attempts this employee now has, including this one. Only set when this
  // scan itself was flagged; null otherwise. Lets the modal tell the
  // employee whether this is their 1st/2nd/3rd unclear attempt today.
  flaggedAttemptCount?: number | null;
  faceImage?: string | null;
  // The server's own timestamp for this scan — exactly what got written to
  // the AttendanceRecord (and therefore the DTR) as timeInAt/timeOutAt/
  // lunchOutAt/lunchInAt. Only present when approved; always prefer this
  // over the device's own clock when displaying "recorded at" times, since
  // it can otherwise drift from the DTR by however long verification took.
  capturedAt: string | null;
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
  latitude: string | number;
  longitude: string | number;
  // Reverse-geocoded once, server-side, at submission time (see
  // attendance.service.ts submit()) — always prefer this over re-geocoding
  // on-device, since that's what keeps this screen showing the same address
  // as the web DTR view for the same log instead of each asking a different
  // geocoding provider (device-native here vs Nominatim on web). Null for
  // rows from before this field existed, or if the geocode itself failed.
  address: string | null;
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
  // Only present on the GET /employees/me response — whether this employee
  // has an active EmployeeSchedule assignment whose workingDays include today.
  hasScheduleToday?: boolean;
  sex?: "MALE" | "FEMALE";
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
  cancellationAllowed: boolean;
  cancellationCutoffValue: number | null;
  cancellationCutoffUnit: "WORKING_DAYS_BEFORE_START" | "HOURS_BEFORE_SHIFT_START" | null;
  kind?: "GENERAL" | "MATERNITY" | "PATERNITY";
};

export type LeaveBalance = {
  leaveTypeId: string;
  leaveTypeName: string;
  year: number;
  earnedDays: number;
  usedDays: number;
  remainingDays: number;
};

// One step in a request's approval timeline — reconstructed server-side from
// the AuditLog rows every status change already writes (see buildHistory in
// leave.service.ts). "FILED" is always first; everything after it reflects
// whatever actually happened (approval is single-step today, so most
// requests only ever get one more event after FILED).
export type LeaveRequestHistoryEvent = {
  action:
    | "FILED"
    | "SUPERVISOR_APPROVE_LEAVE"
    | "APPROVE_LEAVE"
    | "REJECT_LEAVE"
    | "RESUBMIT_LEAVE"
    | "CANCEL_LEAVE"
    | "REQUEST_CANCEL_LEAVE"
    | "APPROVE_CANCEL_LEAVE"
    | "DENY_CANCEL_LEAVE";
  status: string | null;
  actorName: string | null;
  occurredAt: string;
  // Normalized from whichever of remarks/note the underlying action wrote
  // (see buildHistory in leave.service.ts) — the reviewer's remarks on a
  // REJECT_LEAVE/DENY_CANCEL_LEAVE, or the employee's note on a
  // RESUBMIT_LEAVE/REQUEST_CANCEL_LEAVE.
  remarks: string | null;
  requirementDetails: string | null;
};

export type LeaveRequestNote = {
  id: string;
  type: "REJECTED" | "RESUBMITTED" | "CANCELLED" | "CANCELLATION_DENIED";
  message?: string | null;
  requiresAdditionalRequirements?: boolean;
  requirementDetails?: string | null;
  attachmentName?: string | null;
  // Only populated by getLeaveRequestDetail — the list poll (getLeaveRequests)
  // omits these to keep its payload light.
  attachmentMimeType?: string | null;
  attachmentData?: string | null;
  createdAt: string;
};

export type LeaveRequest = {
  id: string;
  startDate: string;
  endDate: string;
  totalDays: string;
  status: string;
  reason: string;
  createdAt: string;
  attachmentName?: string | null;
  // Only populated by getLeaveRequestDetail — the list poll (getLeaveRequests)
  // omits these to keep its payload light.
  attachmentMimeType?: string | null;
  attachmentData?: string | null;
  adminRemarks?: { remarks?: string } | null;
  notes?: LeaveRequestNote[];
  history?: LeaveRequestHistoryEvent[];
  leaveType: {
    id: string;
    name: string;
    cancellationAllowed?: boolean;
    cancellationCutoffValue?: number | null;
    cancellationCutoffUnit?: "WORKING_DAYS_BEFORE_START" | "HOURS_BEFORE_SHIFT_START" | null;
  };
  // Server-computed — whether an employee (not an admin override) could
  // cancel this request right now, and why not if not. Only meaningful for
  // an APPROVED request; PENDING/SUPERVISOR_APPROVED are always allowed.
  cancellation?: { allowed: boolean; reason?: string; deadline?: string };
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

const REQUEST_TIMEOUT_MS = 15000;

async function fetchFromApi(path: string, options: RequestInit, token?: string | null) {
  let response: Response | null = null;

  for (const baseUrl of API_BASE_URLS) {
    const url = `${baseUrl}${path}`;
    console.log("REQUEST:", url);

    // A hung/very slow request previously had no ceiling, which could leave
    // a screen's loading spinner stuck indefinitely. Timing out here just
    // routes into the same catch-and-try-next-baseUrl path that a network
    // error already takes below — no new behavior, just a bound on it.
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);

    try {
      response = await fetch(url, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...options.headers,
        },
        signal: timeoutController.signal,
      });
      break;
    } catch (error) {
      console.warn(`API request failed for ${url}`, error);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (!response) {
    throw new Error(`Cannot reach API server. Check internet connection or API URL: ${API_BASE_URLS.join(" or ")}`);
  }

  return response;
}

// Refresh tokens are disabled for now — the backend no longer issues one
// (see backend/src/modules/auth/auth.service.ts) and /auth/refresh is
// commented out (auth.controller.ts). Re-enable this together with those.
// async function refreshAccessToken(): Promise<string | null> {
//   if (refreshPromise) return refreshPromise;
//
//   refreshPromise = (async () => {
//     const refreshToken = await SecureStore.getItemAsync("refreshToken");
//     if (!refreshToken) return null;
//
//     try {
//       const response = await fetchFromApi("/auth/refresh", {
//         method: "POST",
//         body: JSON.stringify({ refreshToken }),
//       });
//       if (!response.ok) return null;
//
//       const data = (await response.json()) as { accessToken?: string; refreshToken?: string };
//       if (!data.accessToken || !data.refreshToken) return null;
//
//       await SecureStore.setItemAsync("accessToken", data.accessToken);
//       await SecureStore.setItemAsync("refreshToken", data.refreshToken);
//       return data.accessToken;
//     } catch {
//       return null;
//     } finally {
//       refreshPromise = null;
//     }
//   })();
//
//   return refreshPromise;
// }

async function clearExpiredSession() {
  clearDataCache();
  await SecureStore.deleteItemAsync("accessToken");
  // await SecureStore.deleteItemAsync("refreshToken"); // refresh tokens disabled
  await SecureStore.deleteItemAsync("sessionUser");
  unauthorizedHandler?.();
}

export async function apiRequest<T>(path: string, options: RequestInit = {}) {
  const token = await SecureStore.getItemAsync("accessToken");
  const response = await fetchFromApi(path, options, token);

  // Refresh-and-retry on a 401 is disabled along with refresh tokens above —
  // an expired access token now just clears the session below, same as any
  // other invalid/missing token, so the user is prompted to log in again.

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 401) {
      await clearExpiredSession();
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
  // refreshToken is not part of the response while refresh tokens are
  // disabled — see backend/src/modules/auth/auth.service.ts.
  const data = await apiRequest<{ accessToken: string; user: MobileUser }>("/auth/login", {
    method: "POST",
    body: JSON.stringify(password ? { email, password } : { email }),
  });
  // A different account may have logged in on this device — never let it
  // see the previous account's cached data.
  clearDataCache();
  await SecureStore.setItemAsync("accessToken", data.accessToken);
  await SecureStore.setItemAsync("sessionUser", JSON.stringify(data.user));
  return data.user;
}

// Called when the employee taps Accept on FaceConsentScreen. Persists the
// updated timestamp into the cached session too, so a later app reopen
// (restoreSession, which reads the cache with no network call) doesn't
// re-show the consent screen for an already-accepted employee.
export async function acceptFaceConsent(): Promise<string> {
  const result = await apiRequest<{ faceConsentAcceptedAt: string }>("/employees/me/consent", {
    method: "POST",
  });
  const savedUser = await SecureStore.getItemAsync("sessionUser");
  if (savedUser) {
    try {
      const parsed = JSON.parse(savedUser) as MobileUser;
      parsed.faceConsentAcceptedAt = result.faceConsentAcceptedAt;
      await SecureStore.setItemAsync("sessionUser", JSON.stringify(parsed));
    } catch {
      // Cache is best-effort here — the in-memory user update in App.tsx is
      // what actually gates the UI for the rest of this session.
    }
  }
  return result.faceConsentAcceptedAt;
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
  // await SecureStore.deleteItemAsync("refreshToken"); // refresh tokens disabled
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

export type FaceMatchResult = { status: "APPROVED" | "PENDING_REVIEW" | "REJECTED"; reason: string | null; similarityScore: number };

// Mid-scan identity pre-check: compares the given frame against the
// logged-in employee's own enrolled profile (server resolves employeeId
// from the JWT, never from this call's body). Not the authoritative
// decision — submitAttendance() below independently re-verifies the final
// captured photo regardless of what this returned.
export async function matchFace(imageBase64: string) {
  return apiRequest<FaceMatchResult>("/face/match", {
    method: "POST",
    body: JSON.stringify({ imageBase64 }),
  });
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
  // includeAttachments=false: this screen only ever shows attachmentName in
  // the list, never the base64 attachmentData — skipping it keeps the
  // 3-second poll fast regardless of how many/large the filed attachments are.
  return apiRequest<LeaveRequest[]>(`/leave-requests?employeeId=${employeeId}&includeAttachments=false`);
}

// Fetches a single request with its attachment data — called on demand
// (e.g. tapping "view attachment") instead of through the list poll above,
// so viewing a file never bloats that poll's payload.
export async function getLeaveRequestDetail(id: string) {
  return apiRequest<LeaveRequest>(`/leave-requests/${id}`);
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

export async function cancelLeaveRequest(id: string, note: string) {
  return apiRequest<LeaveRequest>(`/leave-requests/${id}/cancel`, {
    method: "PATCH",
    body: JSON.stringify({ note }),
  });
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
  history?: LeaveRequestHistoryEvent[];
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

// Decides an employee's request to cancel their own already-APPROVED leave
// (see leave.service.ts's approveCancellation/denyCancellation) — approving
// finalizes it to CANCELLED, denying reverts it to APPROVED as if nothing
// happened.
export async function approveLeaveCancellation(id: string) {
  return apiRequest<TeamLeaveRequest>(`/leave-requests/${id}/approve-cancellation`, { method: "PATCH" });
}

export async function denyLeaveCancellation(id: string, remarks?: string) {
  return apiRequest<TeamLeaveRequest>(`/leave-requests/${id}/deny-cancellation`, {
    method: "PATCH",
    body: JSON.stringify({ remarks: remarks?.trim() || undefined }),
  });
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

export type MySchedule = {
  id: string;
  startsOn: string;
  endsOn?: string | null;
  // 0=Sunday..6=Saturday, matches JS Date.getDay().
  workingDays: number[];
};

// The signed-in employee's own active schedule assignment(s) — used to mark
// their non-working days on the leave-filing calendar.
export async function getMySchedules() {
  return apiRequest<MySchedule[]>("/schedules/mine");
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

// ── Probationary evaluations (Supervisor-facing) ────────────────────────────

export type EvaluationRecommendation = "READY_FOR_CONVERSION" | "NOT_YET_READY" | "NOT_RECOMMENDED";

export type ProbationaryEvaluation = {
  id: string;
  employeeId: string;
  supervisorId: string;
  workQuality: number | null;
  productivity: number | null;
  jobKnowledge: number | null;
  workAttitude: number | null;
  communication: number | null;
  teamwork: number | null;
  adaptability: number | null;
  overallRating: number | null;
  comments: string | null;
  recommendation: EvaluationRecommendation | null;
  status: "DRAFT" | "SUBMITTED";
  submittedAt: string | null;
};

export type EvaluationCriteriaInput = {
  workQuality?: number;
  productivity?: number;
  jobKnowledge?: number;
  workAttitude?: number;
  communication?: number;
  teamwork?: number;
  adaptability?: number;
  overallRating?: number;
  comments?: string;
  recommendation?: EvaluationRecommendation;
};

// Null when this Supervisor has never started an evaluation for this
// employee yet — the form starts blank in that case.
export async function getEmployeeEvaluation(employeeId: string) {
  return apiRequest<ProbationaryEvaluation | null>(`/evaluations/employee/${employeeId}`);
}

export async function saveEvaluationDraft(employeeId: string, input: EvaluationCriteriaInput) {
  return apiRequest<ProbationaryEvaluation>(`/evaluations/employee/${employeeId}/draft`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function submitEvaluation(employeeId: string, input: Required<Omit<EvaluationCriteriaInput, "comments">> & { comments?: string }) {
  return apiRequest<ProbationaryEvaluation>(`/evaluations/employee/${employeeId}/submit`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
