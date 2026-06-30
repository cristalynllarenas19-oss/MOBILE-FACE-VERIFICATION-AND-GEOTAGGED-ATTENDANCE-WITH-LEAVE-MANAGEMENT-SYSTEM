import { apiRequest } from "../../lib/api";

export type AttendanceRecordType = "OFFICE" | "FIELD";

export type TodayAttendance = {
  status: string;
  timeInAt: string | null;
  timeOutAt: string | null;
  visitNumber?: number;
  workLocationId?: string | null;
  recordType?: AttendanceRecordType;
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

export type FaceBox = { x: number; y: number; width: number; height: number };

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

export function getTodayAttendance(employeeId: string) {
  return apiRequest<TodayAttendance>(`/attendance/today/${employeeId}`);
}

export function getAttendanceHistory(employeeId: string, limit = 30) {
  return apiRequest<AttendanceHistoryRecord[]>(`/attendance/history/${employeeId}?limit=${limit}`);
}

export function detectFace(imageBase64: string) {
  return apiRequest<{ detected: boolean; confidence: number; box: FaceBox | null }>("/face/detect", {
    method: "POST",
    body: JSON.stringify({ imageBase64 }),
  });
}

export function submitAttendance(input: SubmitAttendanceInput) {
  return apiRequest<AttendanceSubmitResult>("/attendance/submit", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getMyWorkLocation() {
  return apiRequest<WorkLocation | null>("/geolocation/my-location");
}

export function getMyWorkLocations() {
  return apiRequest<WorkLocation[]>("/geolocation/my-locations");
}

export function getLeaveTypes() {
  return apiRequest<LeaveType[]>("/leave-types");
}

export function getLeaveBalances(employeeId: string) {
  return apiRequest<LeaveBalance[]>(`/leave-balances/${employeeId}?year=${new Date().getFullYear()}`);
}

export function getLeaveRequests(employeeId: string) {
  return apiRequest<LeaveRequest[]>(`/leave-requests?employeeId=${employeeId}`);
}

export function createLeaveRequest(input: CreateLeaveRequestInput) {
  return apiRequest<LeaveRequest>("/leave-requests", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getMyProfile() {
  return apiRequest<EmployeeProfile>("/employees/me");
}

export function changePassword(currentPassword: string, newPassword: string) {
  return apiRequest<{ message: string }>("/users/me/password", {
    method: "PATCH",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

// Haversine distance in metres — same as employee-mobile utils/geofence.ts
export function distanceInMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Same FRIENDLY_REASONS map as employee-mobile utils/attendanceMessages.ts
const FRIENDLY_REASONS: Record<string, string> = {
  "GPS accuracy is too low": "Your location signal is too weak. Move to an open area and try again.",
  "Employee is outside the approved work location": "You're outside your assigned work area. Move closer and try again.",
  "No face detected in the captured photo. Please retake in good lighting.":
    "We couldn't find a face in the photo. Make sure you're well-lit and facing the camera, then try again.",
  "Face does not match enrolled profile":
    "We couldn't verify your identity. Try again with clear lighting and your face centered in the frame.",
  "Borderline face match requires HR review":
    "Your face match was inconclusive, so this attendance has been sent to HR for review.",
  "Liveness check failed": "We couldn't confirm a live face. Please try again.",
};

export function getFriendlyReason(reason: string | null | undefined, verificationStatus: string) {
  if (reason && FRIENDLY_REASONS[reason]) return FRIENDLY_REASONS[reason];
  if (reason) return reason;
  if (verificationStatus === "APPROVED") return "Your face was verified and you're within your assigned work area.";
  return "Please try again.";
}
