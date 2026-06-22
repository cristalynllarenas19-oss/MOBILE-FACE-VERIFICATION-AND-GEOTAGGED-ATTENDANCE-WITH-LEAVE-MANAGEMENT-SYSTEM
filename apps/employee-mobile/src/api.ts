import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";

const DEFAULT_API_BASE_URL =
  "https://mobile-face-verification-and-geotagged-attendanc-production.up.railway.app/api/v1";

function getApiBaseUrl() {
  const configuredUrl =
    process.env.EXPO_PUBLIC_API_BASE_URL ??
    DEFAULT_API_BASE_URL;

  const metroHost = (
    Constants as unknown as {
      expoConfig?: { hostUri?: string };
      manifest?: { debuggerHost?: string };
      manifest2?: { extra?: { expoClient?: { hostUri?: string } } };
    }
  ).expoConfig?.hostUri
    ?? (Constants as unknown as { manifest?: { debuggerHost?: string } }).manifest?.debuggerHost
    ?? (Constants as unknown as { manifest2?: { extra?: { expoClient?: { hostUri?: string } } } }).manifest2?.extra?.expoClient?.hostUri;

  const host = metroHost?.split(":")[0];
  if (host && /localhost|127\.0\.0\.1/.test(configuredUrl)) {
    return configuredUrl.replace(/localhost|127\.0\.0\.1/, host);
  }

  return configuredUrl;
}

const API_BASE_URL = getApiBaseUrl();

export type MobileUser = {
  id: string;
  email: string;
  role: string;
  employeeId?: string;
  displayName: string;
};
export type TodayAttendance = {
  status: string;
  timeInAt: string | null;
  timeOutAt: string | null;
};

export type AttendanceSubmitResult = {
  approved: boolean;
  verificationStatus: string;
  geoResult: { reason?: string | null };
  faceResult: { reason?: string | null };
};

export type SubmitAttendanceInput = {
  employeeId: string;
  logType: "TIME_IN" | "TIME_OUT";
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  livenessScore: number;
  similarityScore: number;
  faceImageBase64: string;
  deviceId: string;
};

export type LeaveType = {
  id: string;
  name: string;
  defaultDays: string;
  requiresDocument: boolean;
};

export type LeaveBalance = {
  leaveTypeId: string;
  leaveTypeName: string;
  year: number;
  earnedDays: number;
  usedDays: number;
  remainingDays: number;
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
  const url = `${API_BASE_URL}${path}`;
  console.log("REQUEST:", url);
  const token = await SecureStore.getItemAsync("accessToken");
  let response: Response;

  try {
    response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
  } catch (error) {
    throw new Error(`Cannot reach API server. Check internet connection or API URL: ${API_BASE_URL}`);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(extractErrorMessage(body) || `Request failed with status ${response.status}`);
  }

  return response.json() as Promise<T>;
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

export async function login(email: string, password: string) {
  const data = await apiRequest<{ accessToken: string; refreshToken: string; user: MobileUser }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  await SecureStore.setItemAsync("accessToken", data.accessToken);
  await SecureStore.setItemAsync("refreshToken", data.refreshToken);
  return data.user;
}

export async function logout() {
  await SecureStore.deleteItemAsync("accessToken");
  await SecureStore.deleteItemAsync("refreshToken");
}

export async function getTodayAttendance(
  employeeId: string,
) {
  return apiRequest<TodayAttendance>(
    `/attendance/today/${employeeId}`,
  );
}

export async function submitAttendance(input: SubmitAttendanceInput) {
  return apiRequest<AttendanceSubmitResult>("/attendance/submit", {
    method: "POST",
    body: JSON.stringify(input),
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
