const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:3001/api/v1";

export type AttendanceMode = "FIXED" | "FIELD";
export type AttendanceRecordType = "OFFICE" | "FIELD";

export type MobileUser = {
  id: string;
  email: string;
  role: string;
  employeeId?: string;
  displayName: string;
  mustChangePassword?: boolean;
  attendanceMode?: AttendanceMode;
};

export type TodayAttendance = {
  status: string;
  timeInAt: string | null;
  timeOutAt: string | null;
  visitNumber?: number;
  workLocationId?: string | null;
  recordType?: AttendanceRecordType;
};

export type AttendanceSubmitResult = {
  approved: boolean;
  verificationStatus: string;
  logType: "TIME_IN" | "TIME_OUT";
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
  workLocationId?: string;
};

export type AttendanceLogPhoto = {
  id: string;
  logType: "TIME_IN" | "TIME_OUT" | "FAILED_ATTEMPT";
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
  user: { email: string };
  department: { name: string };
  position: { title: string };
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

export type FaceBox = { x: number; y: number; width: number; height: number };

export async function apiRequest<T>(path: string, options: RequestInit = {}) {
  const token = localStorage.getItem("accessToken");
  let response: Response;

  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
  } catch {
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
    return body;
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
  localStorage.setItem("accessToken", data.accessToken);
  localStorage.setItem("refreshToken", data.refreshToken);
  localStorage.setItem("authUser", JSON.stringify(data.user));
  return data.user;
}

export function restoreSession() {
  const raw = localStorage.getItem("authUser");
  return raw ? (JSON.parse(raw) as MobileUser) : null;
}

export function logout() {
  localStorage.removeItem("accessToken");
  localStorage.removeItem("refreshToken");
  localStorage.removeItem("authUser");
}

export const forgotPassword = (email: string) =>
  apiRequest<{ message: string }>("/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) });

export const verifyResetOtp = (email: string, otp: string) =>
  apiRequest<{ resetToken: string }>("/auth/reset-password/verify-otp", {
    method: "POST",
    body: JSON.stringify({ email, otp }),
  });

export const resetPassword = (resetToken: string, newPassword: string) =>
  apiRequest<{ message: string }>("/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({ resetToken, newPassword }),
  });

export const getTodayAttendance = (employeeId: string) => apiRequest<TodayAttendance>(`/attendance/today/${employeeId}`);
export const detectFace = (imageBase64: string) =>
  apiRequest<{ detected: boolean; confidence: number; box: FaceBox | null }>("/face/detect", {
    method: "POST",
    body: JSON.stringify({ imageBase64 }),
  });
export const submitAttendance = (input: SubmitAttendanceInput) =>
  apiRequest<AttendanceSubmitResult>("/attendance/submit", { method: "POST", body: JSON.stringify(input) });
export const getAttendanceHistory = (employeeId: string, limit = 30) =>
  apiRequest<AttendanceHistoryRecord[]>(`/attendance/history/${employeeId}?limit=${limit}`);
export const getMyWorkLocation = () => apiRequest<WorkLocation | null>("/geolocation/my-location");
export const getMyWorkLocations = () => apiRequest<WorkLocation[]>("/geolocation/my-locations");
export const getMyProfile = () => apiRequest<EmployeeProfile>("/employees/me");
export const changePassword = (currentPassword: string, newPassword: string) =>
  apiRequest<{ message: string }>("/users/me/password", {
    method: "PATCH",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
export const setInitialPassword = (newPassword: string) =>
  apiRequest<{ message: string }>("/users/me/password", { method: "PATCH", body: JSON.stringify({ newPassword }) });
export const getLeaveTypes = () => apiRequest<LeaveType[]>("/leave-types");
export const getLeaveBalances = (employeeId: string) =>
  apiRequest<LeaveBalance[]>(`/leave-balances/${employeeId}?year=${new Date().getFullYear()}`);
export const getLeaveRequests = (employeeId: string) => apiRequest<LeaveRequest[]>(`/leave-requests?employeeId=${employeeId}`);
export const createLeaveRequest = (input: CreateLeaveRequestInput) =>
  apiRequest<LeaveRequest>("/leave-requests", { method: "POST", body: JSON.stringify(input) });
export const getNotifications = () => apiRequest<AppNotification[]>("/notifications/me");
export const getUnreadNotificationCount = () => apiRequest<{ count: number }>("/notifications/me/unread-count");
export const markNotificationRead = (id: string) => apiRequest(`/notifications/${id}/read`, { method: "PATCH" });
export const markAllNotificationsRead = () => apiRequest("/notifications/read-all", { method: "PATCH" });
