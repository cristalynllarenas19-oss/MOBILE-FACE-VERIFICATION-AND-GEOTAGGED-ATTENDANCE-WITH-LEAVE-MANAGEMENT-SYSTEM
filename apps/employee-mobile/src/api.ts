import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";
import { clearDataCache } from "./utils/dataCache";
import type { GeofenceBoundary } from "./utils/geofence";

const DEFAULT_API_BASE_URL = "https://backend-production-b9de.up.railway.app/api/v1";
// "http://localhost:3001/api/v1"
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
let refreshPromise: Promise<string | null> | null = null;

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
  // The working day this record belongs to — yesterday's date during the
  // after-midnight half of an overnight shift.
  attendanceDate?: string;
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
  // "BREAK" when the assigned shift's break doesn't fall around midday
  // (night/evening shifts), so the Start/End buttons read "Break" instead
  // of "Lunch".
  breakKind?: "LUNCH" | "BREAK";
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
  // The explanation to show while that hold is active — the same text as
  // the employee's "Attendance Disabled" notification. Null otherwise.
  flagHoldMessage?: string | null;
  // Set once a reviewer has rejected a flagged attempt today and attendance
  // is enabled again, until the employee records an approved scan — the
  // same text as the "Attendance Rejected" notification. Null otherwise.
  flagRejectedMessage?: string | null;
  // Set when this working day is covered by an approved leave and nothing
  // has been timed in — attendance can't be recorded while on leave.
  onLeave?: { leaveTypeName: string } | null;
};

// Both must hold before Time In (and therefore Lunch/Time Out, which all
// require having timed in first) is even attempted — checked up front so an
// employee never goes through the whole camera/liveness flow only to be
// rejected by the backend's own equivalent check inside submit().
export type AttendanceEligibility = {
  faceEnrolled: boolean;
  hasWorkLocation: boolean;
  hasScheduleToday: boolean;
  // ISO time today's shift ends — Time In / Start Visit is disabled from then
  // on. Missing (older cached eligibility) or null = no cutoff known.
  shiftEndsAt?: string | null;
};

export type AttendanceSubmitResult = {
  approved: boolean;
  verificationStatus: string;
  logType: "TIME_IN" | "TIME_OUT" | "LUNCH_OUT" | "LUNCH_IN";
  geoResult: { reason?: string | null };
  faceResult: { reason?: string | null };
  // 0-100 match between the captured face and the enrolled one, as scored
  // by the server. 0 when no face comparison happened at all.
  similarityScore?: number;
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
  // Absent from GET /attendance/history/:employeeId (see attendance.
  // service.ts getHistory) — populated only after getAttendanceRecordPhotos
  // is called for the record this log belongs to.
  faceImageData?: string | null;
  faceImageMimeType?: string | null;
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
  overtimeMinutes?: number;
  visitNumber?: number;
  workLocationId?: string | null;
  workLocation?: { name: string } | null;
  recordType?: AttendanceRecordType;
  // Whether any of this record's logs has a captured photo — computed
  // server-side so the list can show the camera badge without shipping the
  // photo data itself (see getHistory()'s comment in attendance.service.ts).
  hasPhoto?: boolean;
  // Set on rows the server rebuilt for a day with no attendance record: an
  // absence, or a day on approved leave (leaveTypeName says which leave).
  isSynthetic?: boolean;
  leaveTypeName?: string | null;
  // The shift the employee was scheduled for on a rebuilt (absent/leave) day.
  scheduledShift?: { name: string | null; startTime: string; endTime: string } | null;
  breakKind?: "LUNCH" | "BREAK";
  lateMinutes?: number;
  // Minutes timed out before the shift's scheduled end.
  undertimeMinutes?: number;
  // Whether this record's undertime filing has been approved.
  hasApprovedUndertime?: boolean;
  logs: AttendanceLogPhoto[];
};

export type WorkLocation = {
  id: string;
  name: string;
  latitude: string | number;
  longitude: string | number;
  radiusMeters: string | number;
  // Set for a polygon area — check inside/outside with
  // distanceOutsideGeofence (utils/geofence), never radiusMeters alone.
  boundary?: GeofenceBoundary | null;
  allowedAccuracyMeters: string | number;
  // Office or Field area — any Field area makes the employee a FIELD
  // employee (see GeolocationService.syncAttendanceModes on the backend).
  type?: "OFFICE" | "FIELD";
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
  // Only present on the GET /employees/me response — when today's shift ends
  // (ISO), or null when there's no shift today. See AttendanceEligibility.
  shiftEndsAt?: string | null;
  sex?: "MALE" | "FEMALE";
  // REGULAR, PROBATIONARY, ... — decides which leave types they may request
  // (see LeaveType.applicableStatuses).
  employmentStatus?: string;
  // The live value — follows the employee's assigned geotagged area, so it
  // can differ from the attendanceMode saved with the login session.
  attendanceMode?: AttendanceMode;
  user: { email: string };
  department: { name: string };
  position: { title: string };
  // Only present on the GET /employees/me response; null when unassigned.
  supervisor?: { firstName: string; lastName: string } | null;
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
  // Employment statuses allowed to request this type — the backend rejects a
  // request from anyone else (leave.service.ts create()).
  applicableStatuses?: string[];
  requiresAdminGrant: boolean;
  isSingleDayOnly: boolean;
  advanceFilingAllowed: boolean;
  // Sick Leave: on top of today, may be filed for a past day the employee
  // was absent (leave.service.ts create()).
  pastAbsenceFilingAllowed?: boolean;
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
  // Approved Maternity Leave extension days — shown on top of the leave's
  // own days, never part of earnedDays/usedDays/remainingDays.
  extensionDays?: number;
  // "As needed" type: no allotment, so only the days used are shown.
  isUnlimitedDays?: boolean;
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
    | "DENY_CANCEL_LEAVE"
    | "LAPSE_LEAVE";
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
  // Set only on a LAPSED request: "REPORTED_FOR_WORK" or "NOT_DECIDED".
  lapseReason?: string | null;
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
  // workedDates: days of this leave the employee already timed in on —
  // those can't be picked when cancelling only some days.
  cancellation?: { allowed: boolean; reason?: string; workedDates?: string[] };
  // Set on a Maternity Leave extension — the leave it extends.
  extensionOfId?: string | null;
  // Server-computed, only on an APPROVED Maternity Leave — whether its
  // extension (without pay) can be requested now, and why not if not. It must
  // be requested by `deadline` (45 days before the leave ends); startDate/
  // endDate are the days it would cover.
  extension?: LeaveExtensionEligibility | null;
};

export type LeaveExtensionEligibility = {
  allowed: boolean;
  reason?: string;
  // How many days the extension covers — the leave type's configured
  // extension days (Utilities → Leave Types).
  days: number;
  deadline: string;
  startDate: string;
  endDate: string;
  extensionId?: string;
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

// Sick Leave picked for several days at once — one request per date.
export type CreateLeaveRequestsInput = Omit<CreateLeaveRequestInput, "startDate" | "endDate" | "totalDays"> & {
  dates: string[];
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

// 60s, not 15s. Originally sized for Render's free tier, which could take
// 50+ seconds to wake a cold instance — a shorter timeout was aborting the
// very first request after any period of inactivity, well before the server
// actually responded. Now pointed at Railway (see DEFAULT_API_BASE_URL
// above), which doesn't sleep the same way, but kept generous rather than
// re-tuned blind without measuring Railway's own worst case.
const REQUEST_TIMEOUT_MS = 60000;

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

async function refreshAccessToken(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const refreshToken = await SecureStore.getItemAsync("refreshToken");
    if (!refreshToken) return null;

    try {
      const response = await fetchFromApi("/auth/refresh", {
        method: "POST",
        body: JSON.stringify({ refreshToken }),
      });
      if (!response.ok) return null;

      const data = (await response.json()) as { accessToken?: string; refreshToken?: string };
      if (!data.accessToken || !data.refreshToken) return null;

      await SecureStore.setItemAsync("accessToken", data.accessToken);
      await SecureStore.setItemAsync("refreshToken", data.refreshToken);
      return data.accessToken;
    } catch {
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function clearExpiredSession() {
  clearDataCache();
  await SecureStore.deleteItemAsync("accessToken");
  await SecureStore.deleteItemAsync("refreshToken");
  await SecureStore.deleteItemAsync("sessionUser");
  unauthorizedHandler?.();
}

export async function apiRequest<T>(path: string, options: RequestInit = {}) {
  const token = await SecureStore.getItemAsync("accessToken");
  let response = await fetchFromApi(path, options, token);

  // A 401 on anything but the refresh call itself gets one silent
  // refresh-and-retry — only once, so an invalid/revoked refresh token still
  // falls through to clearExpiredSession() below instead of looping.
  if (response.status === 401 && path !== "/auth/refresh") {
    const newToken = await refreshAccessToken();
    if (newToken) {
      response = await fetchFromApi(path, options, newToken);
    }
  }

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
  // Sent with fetchFromApi directly, not apiRequest: there is no session yet,
  // so a 401 here means wrong credentials — apiRequest would treat it as an
  // expired session (refresh attempt, then the "Session Expired" logout).
  const response = await fetchFromApi("/auth/login", {
    method: "POST",
    body: JSON.stringify(password ? { email, password } : { email }),
  });
  if (!response.ok) {
    const body = await response.text();
    if (response.status === 401) throw new Error("Incorrect email or password.");
    throw new Error(extractErrorMessage(body) || `Request failed with status ${response.status}`);
  }
  const data = (await response.json()) as { accessToken: string; refreshToken: string; user: MobileUser };
  // A different account may have logged in on this device — never let it
  // see the previous account's cached data.
  clearDataCache();
  await SecureStore.setItemAsync("accessToken", data.accessToken);
  await SecureStore.setItemAsync("refreshToken", data.refreshToken);
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

// Keeps the saved session's attendanceMode in step with the backend, which
// changes it whenever the employee is assigned to a different kind of
// geotagged area — otherwise the next restoreSession() would bring back the
// mode from login time (Time In/Out for someone now on Start/End Visit).
export async function saveSessionAttendanceMode(attendanceMode: AttendanceMode) {
  const savedUser = await SecureStore.getItemAsync("sessionUser");
  if (!savedUser) return;
  try {
    const parsed = JSON.parse(savedUser) as MobileUser;
    parsed.attendanceMode = attendanceMode;
    await SecureStore.setItemAsync("sessionUser", JSON.stringify(parsed));
  } catch {
    // Best-effort, same as acceptFaceConsent above — the in-memory user
    // update in App.tsx is what drives the UI for this session.
  }
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

// Idle auto-logout: an account left signed in on an unattended phone is
// logged out once the app has been closed or in the background this long
// (see App.tsx). Only the "lastActiveAt" key below is involved — the saved
// login itself is cleared by the normal logout().
const IDLE_LOGOUT_MS = 20 * 60 * 1000;

// Records "the app was in use just now".
export async function markAppActive() {
  await SecureStore.setItemAsync("lastActiveAt", String(Date.now()));
}

// False when nothing was recorded yet (e.g. a session saved before this
// feature existed), so nobody is logged out without a known idle time.
export async function hasIdleTimedOut() {
  const raw = await SecureStore.getItemAsync("lastActiveAt");
  if (!raw) return false;
  const lastActiveAt = Number(raw);
  if (!Number.isFinite(lastActiveAt)) return false;
  return Date.now() - lastActiveAt > IDLE_LOGOUT_MS;
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
  // wellLit is false when the detected face is too dark for a reliable match.
  return apiRequest<{ detected: boolean; confidence: number; box: FaceBox | null; ear: number | null; wellLit?: boolean }>(
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

// Fetched lazily when a DTR row's detail modal is opened — see the
// AttendanceLogPhoto.faceImageData comment above.
export async function getAttendanceRecordPhotos(recordId: string) {
  return apiRequest<Pick<AttendanceLogPhoto, "id" | "faceImageData" | "faceImageMimeType">[]>(
    `/attendance/records/${recordId}/photos`,
  );
}

// One calendar month of the signed-in employee's own DTR, for Download /
// Print DTR. The server takes the employee from the login token, not from
// this request, so there's no id to pass.
export type MonthlyDtrRow = {
  id: string;
  attendanceDate: string;
  recordType?: AttendanceRecordType;
  visitNumber?: number;
  timeInAt: string | null;
  timeOutAt: string | null;
  lunchOutAt?: string | null;
  lunchInAt?: string | null;
  status: string;
  totalMinutes: number;
  lateMinutes?: number;
  undertimeMinutes?: number;
  overtimeMinutes?: number;
  workLocation?: { name: string } | null;
  leaveTypeName?: string | null;
  hasApprovedUndertime?: boolean;
  isSynthetic?: boolean;
};

export type MonthlyDtr = {
  employee: {
    employeeNo: string;
    name: string;
    firstName: string;
    lastName: string;
    department: string | null;
    position: string | null;
    employeeType: string | null;
  };
  year: number;
  month: number;
  generatedAt: string;
  rows: MonthlyDtrRow[];
};

export async function getMyMonthlyDtr(year: number, month: number) {
  return apiRequest<MonthlyDtr>(`/attendance/me/dtr?year=${year}&month=${month}`);
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
  return apiRequest<LeaveBalance[]>(`/leave-balances/${employeeId}`);
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

export async function createLeaveRequests(input: CreateLeaveRequestsInput) {
  return apiRequest<LeaveRequest[]>("/leave-requests/batch", {
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

// The supporting document is optional — kept on the cancellation's own note.
export async function cancelLeaveRequest(
  id: string,
  note: string,
  attachment?: { attachmentName: string; attachmentMimeType: string; attachmentData: string },
  // Only these days are cancelled; omitted = the whole leave.
  dates?: string[],
) {
  return apiRequest<LeaveRequest>(`/leave-requests/${id}/cancel`, {
    method: "PATCH",
    body: JSON.stringify({ note, ...attachment, dates }),
  });
}

// Files the Maternity Leave extension (without pay) of approved leave
// `id` — a new request reviewed by the employee's Supervisor or HR/Admin.
export async function requestLeaveExtension(
  id: string,
  reason: string,
  attachment?: { attachmentName: string; attachmentMimeType: string; attachmentData: string },
) {
  return apiRequest<LeaveRequest>(`/leave-requests/${id}/extension`, {
    method: "POST",
    body: JSON.stringify({ reason, ...attachment }),
  });
}

export type LateAttendanceRecord = {
  id: string;
  attendanceDate: string;
  lateMinutes: number;
  undertimeMinutes?: number;
  timeInAt: string | null;
};

// Undertime a filing covers for a day: minutes late plus minutes timed out
// before the shift's scheduled end.
export function filedMinutes(record: { lateMinutes?: number; undertimeMinutes?: number }) {
  return (record.lateMinutes ?? 0) + (record.undertimeMinutes ?? 0);
}


export type UndertimeFiling = {
  id: string;
  filingDate: string;
  attendanceRecordId: string;
  cutoffStart: string;
  cutoffEnd: string;
  reason: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED";
  remarks: string | null;
  createdAt: string;
  reviewedAt: string | null;
  attendanceRecord?: LateAttendanceRecord;
  reviewer?: { employee?: { firstName: string; lastName: string } | null } | null;
};

export type UndertimeEligibility = {
  isFilingDay: boolean;
  filingDaysOfMonth: number[];
  targetCutoff: { start: string; end: string };
  lateRecords: LateAttendanceRecord[];
  existingFiling: UndertimeFiling | null;
  eligible: boolean;
};

export async function getUndertimeEligibility(employeeId: string) {
  return apiRequest<UndertimeEligibility>(`/undertime-filings/eligibility/${employeeId}`);
}

export async function getUndertimeFilings(employeeId: string) {
  return apiRequest<UndertimeFiling[]>(`/undertime-filings?employeeId=${employeeId}`);
}

export async function fileUndertime(employeeId: string, attendanceRecordId: string, reason: string) {
  return apiRequest<UndertimeFiling>("/undertime-filings", {
    method: "POST",
    body: JSON.stringify({ employeeId, attendanceRecordId, reason }),
  });
}

// Which half of the inbox a portal shows: "reviewer" is the team's requests
// a Supervisor has to act on, "personal" is what is about the signed-in
// person themselves. A supervisor who switches to their employee profile
// gets a separate list and a separate unread badge in each.
export type NotificationView = "reviewer" | "personal";

export async function getNotifications(view: NotificationView) {
  return apiRequest<AppNotification[]>(`/notifications/me?view=${view}`);
}

export async function getUnreadNotificationCount(view: NotificationView) {
  return apiRequest<{ count: number }>(`/notifications/me/unread-count?view=${view}`);
}

export async function markNotificationRead(id: string) {
  return apiRequest(`/notifications/${id}/read`, { method: "PATCH" });
}

// Scoped to the same view, so clearing one portal's list leaves the other
// portal's unread items unread.
export async function markAllNotificationsRead(view: NotificationView) {
  return apiRequest(`/notifications/read-all?view=${view}`, { method: "PATCH" });
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
  calendar: {
    monthLabel: string;
    days: {
      date: string;
      day: number;
      present: number;
      late: number;
      absent: number;
      onLeave: number;
      // Tells a company-wide rest day apart from a day with no data yet —
      // both otherwise sum to all-zero.
      isDayOff: boolean;
    }[];
  };
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
  employeeTypeId?: string;
  employeeType?: { id: string; name: string; isActive: boolean } | null;
  attendanceMode?: AttendanceMode;
  sex?: "MALE" | "FEMALE";
  hireDate?: string;
  // attendanceMode is the department's own setting (FIXED/FIELD/BOTH) —
  // a FIXED department can't be put on a Field area.
  department?: { id: string; name: string; attendanceMode?: string } | null;
  positionId?: string | null;
  position?: { title: string } | null;
  supervisorId?: string | null;
};

// Every position from admin-web's Utilities -> Positions — the only source
// for the Team tab's Position filter, never a list kept in this app or
// inferred from whoever happens to hold a position (the same rule
// EmployeesPage.tsx follows on web).
export type PositionOption = { id: string; title: string; isActive: boolean };

export async function getPositions() {
  return apiRequest<PositionOption[]>("/positions");
}

export async function getTeamEmployees() {
  // Archived (SEPARATED) employees are not part of the active team roster.
  const employees = await apiRequest<TeamEmployee[]>("/employees");
  return employees.filter((employee) => employee.employmentStatus !== "SEPARATED");
}

export type TeamAttendanceRecord = {
  id: string;
  attendanceDate: string;
  timeInAt?: string | null;
  timeOutAt?: string | null;
  lunchOutAt?: string | null;
  lunchInAt?: string | null;
  breakKind?: "LUNCH" | "BREAK";
  status: string;
  visitNumber?: number;
  recordType?: AttendanceRecordType | null;
  workLocation?: { name: string } | null;
  employee: {
    employeeNo?: string;
    firstName: string;
    lastName: string;
    department: { name: string };
    position?: { title: string } | null;
  };
};

export async function getTeamAttendance(params?: {
  department?: string;
  status?: string;
  recordType?: string;
  date?: string;
  from?: string;
  to?: string;
}) {
  const qs = new URLSearchParams(params as Record<string, string>).toString();
  return apiRequest<TeamAttendanceRecord[]>(`/attendance${qs ? `?${qs}` : ""}`);
}

// A face-mismatch attempt still awaiting a supervisor/HR decision: an
// AttendanceLog with no AttendanceRecord behind it yet. Same endpoint and
// shape admin-web's AttendancePage merges into its list as synthetic
// "FLAGGED" rows.
export type FlaggedAttendanceLog = {
  id: string;
  logType: "TIME_IN" | "TIME_OUT" | "LUNCH_OUT" | "LUNCH_IN";
  capturedAt: string;
  attendanceDate?: string | null;
  recordType?: AttendanceRecordType | null;
  latitude: string;
  longitude: string;
  distanceFromSiteMeters: string;
  faceSimilarityScore?: string | null;
  verificationStatus: string;
  failureReason?: string | null;
  faceImageData?: string | null;
  faceImageMimeType?: string | null;
  workLocation?: { name: string } | null;
  employee: {
    id: string;
    employeeNo?: string;
    firstName: string;
    lastName: string;
    department: { name: string };
    position?: { title: string } | null;
    user?: { userRoles: { role: { code: string } }[] } | null;
    // Newest enrolled profile only (take: 1 server-side) — the "registered
    // face" half of the comparison the reviewer is here to make.
    faceProfiles?: { referenceImageData?: string | null }[];
  };
};

// Needs attendance:write. A Supervisor whose role was not granted it gets a
// 403 here — callers swallow that and show no flagged rows at all, exactly
// as admin-web's AttendancePage does.
export async function getFlaggedAttendanceLogs() {
  return apiRequest<FlaggedAttendanceLog[]>("/attendance/flagged");
}

// A flagged log's earlier same-day failed attempts (oldest first) — only the
// latest one is listed in the review queue, the ones it superseded are
// fetched per log when its review modal opens.
export type PreviousFlaggedAttempt = Pick<
  FlaggedAttendanceLog,
  | "id"
  | "logType"
  | "capturedAt"
  | "latitude"
  | "longitude"
  | "distanceFromSiteMeters"
  | "faceSimilarityScore"
  | "verificationStatus"
  | "failureReason"
  | "faceImageData"
  | "faceImageMimeType"
>;

export async function getPreviousFlaggedAttempts(logId: string) {
  return apiRequest<PreviousFlaggedAttempt[]>(`/attendance/flagged/${logId}/attempts`);
}

// "validate" records the attempt as genuine attendance; "reject" tags it as
// a fake attendance attempt. Either way the log leaves the pending-review
// queue, so the caller refetches afterwards.
export async function reviewFlaggedAttendanceLog(
  logId: string,
  decision: "validate" | "reject",
  remarks?: string,
) {
  return apiRequest<{ id: string }>(`/attendance/flagged/${logId}/${decision}`, {
    method: "PATCH",
    body: JSON.stringify({ remarks: remarks?.trim() ?? "" }),
  });
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
  boundary?: GeofenceBoundary | null;
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
  // Set only on a LAPSED request: "REPORTED_FOR_WORK" or "NOT_DECIDED".
  lapseReason?: string | null;
  status: string;
  reason: string;
  createdAt: string;
  adminRemarks?: { remarks?: string } | null;
  attachmentName?: string | null;
  extensionRequested?: boolean;
  extensionApproved?: boolean | null;
  // Set on a Maternity Leave extension — the leave it extends.
  extensionOfId?: string | null;
  history?: LeaveRequestHistoryEvent[];
  // The team list is fetched with attachments included, so a note's
  // document (e.g. one sent with a cancellation) can be opened directly.
  notes?: Array<{
    id: string;
    type: string;
    message?: string | null;
    attachmentName?: string | null;
    attachmentMimeType?: string | null;
    attachmentData?: string | null;
    createdAt: string;
  }>;
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
export async function approveLeaveCancellation(id: string, remarks?: string) {
  return apiRequest<TeamLeaveRequest>(`/leave-requests/${id}/approve-cancellation`, {
    method: "PATCH",
    body: JSON.stringify({ remarks: remarks?.trim() || undefined }),
  });
}

export async function denyLeaveCancellation(id: string, remarks?: string) {
  return apiRequest<TeamLeaveRequest>(`/leave-requests/${id}/deny-cancellation`, {
    method: "PATCH",
    body: JSON.stringify({ remarks: remarks?.trim() || undefined }),
  });
}

export type TeamUndertimeFiling = UndertimeFiling & {
  employee: {
    id: string;
    firstName: string;
    lastName: string;
    department?: { name: string };
  };
};

export async function getTeamUndertimeFilings() {
  return apiRequest<TeamUndertimeFiling[]>("/undertime-filings");
}

export async function approveUndertimeFiling(id: string, remarks?: string) {
  return apiRequest<TeamUndertimeFiling>(`/undertime-filings/${id}/approve`, {
    method: "PATCH",
    body: JSON.stringify({ remarks: remarks?.trim() || undefined }),
  });
}

export async function rejectUndertimeFiling(id: string, remarks?: string) {
  return apiRequest<TeamUndertimeFiling>(`/undertime-filings/${id}/reject`, {
    method: "PATCH",
    body: JSON.stringify({ remarks: remarks?.trim() || undefined }),
  });
}

export type ScheduleAssignment = {
  id: string;
  startsOn: string;
  endsOn?: string | null;
  employee: {
    id: string;
    firstName: string;
    lastName: string;
    department: { name: string };
    position?: { title: string } | null;
  };
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
  shift: { id: string; name: string; startTime: string; endTime: string };
};

// The signed-in employee's own active schedule assignment(s) — used to mark
// their non-working days on the leave-filing calendar and to render the
// "My Schedule" settings screen.
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
  attendance: {
    id: string;
    attendanceDate: string;
    status: string;
    timeInAt?: string | null;
    timeOutAt?: string | null;
    lunchOutAt?: string | null;
    lunchInAt?: string | null;
    breakKind?: "LUNCH" | "BREAK";
    workLocation?: { name: string } | null;
    employee: { firstName: string; lastName: string; department: { name: string } };
  }[];
  leaves: {
    id: string;
    startDate: string;
    endDate: string;
    totalDays: string;
    status: string;
    // Set only on a LAPSED request: "REPORTED_FOR_WORK" or "NOT_DECIDED".
    lapseReason?: string | null;
    employee: { firstName: string; lastName: string; employmentStatus?: string; department: { name: string } };
    leaveType: { name: string };
  }[];
  undertime?: {
    id: string;
    filingDate: string;
    reason: string | null;
    status: string;
    employee: { firstName: string; lastName: string; department: { name: string } };
    attendanceRecord: { attendanceDate: string; lateMinutes: number; undertimeMinutes?: number };
    reviewer?: { email: string; employee?: { firstName: string; lastName: string } | null } | null;
  }[];
  schedules: {
    id: string;
    startsOn: string;
    endsOn?: string | null;
    employee: { firstName: string; lastName: string; department: { name: string }; position?: { title: string } | null };
    shift: { name: string; startTime: string; endTime: string };
  }[];
  employees: {
    id: string;
    firstName: string;
    lastName: string;
    sex?: string | null;
    hireDate: string;
    department: { name: string };
  }[];
  leaveBalances: {
    employeeId: string;
    employee: { firstName: string; lastName: string; sex?: string | null; department: { name: string } };
    leaveTypeId: string;
    leaveTypeName: string;
    remainingDays: number;
    usedDays: number;
    usedDates: { startDate: string; endDate: string }[];
  }[];
};

export async function getReportsSummary(params?: { from?: string; to?: string; department?: string }) {
  const qs = new URLSearchParams(params as Record<string, string>).toString();
  return apiRequest<ReportsSummary>(`/reports${qs ? `?${qs}` : ""}`);
}

// ── Regularization review (probationary employees) ─────────────────────────

export type RegularizationReview = {
  viewerRole: "ADMIN" | "SUPERVISOR";
  employee: {
    id: string;
    employeeNo: string;
    firstName: string;
    lastName: string;
    email: string | null;
    department: string | null;
    position: string | null;
    employeeType: string | null;
    supervisorName: string | null;
    hireDate: string;
    employmentStatus: string;
  };
  // Null once the employee is no longer on probation — nothing left to decide.
  targetStatus: string | null;
  attendance: {
    totalWorkingDays: number;
    daysPresent: number;
    absences: number;
    lateOccurrences: number;
    undertimeOccurrences: number;
  };
  recommendation: {
    decision: "APPROVE" | "REJECT";
    remarks: string | null;
    decidedAt: string | null;
    supervisorName: string;
  } | null;
};

export async function getRegularizationReview(employeeId: string) {
  return apiRequest<RegularizationReview>(`/evaluations/employee/${employeeId}/review`);
}

// Supervisor's Approve / Reject — a recommendation sent to Admin.
export async function recommendRegularization(employeeId: string, decision: "APPROVE" | "REJECT", remarks?: string) {
  return apiRequest(`/evaluations/employee/${employeeId}/recommend`, {
    method: "POST",
    body: JSON.stringify({ decision, remarks }),
  });
}

// Admin's Approve — the same status change Edit Employee makes on admin-web.
export async function approveRegularization(employeeId: string, targetStatus: string) {
  return apiRequest(`/employees/${employeeId}`, {
    method: "PATCH",
    body: JSON.stringify({ employmentStatus: targetStatus }),
  });
}

// Admin's Reject — the employee stays on probation.
export async function rejectRegularization(employeeId: string, remarks?: string) {
  return apiRequest(`/evaluations/employee/${employeeId}/reject`, {
    method: "POST",
    body: JSON.stringify({ remarks }),
  });
}
