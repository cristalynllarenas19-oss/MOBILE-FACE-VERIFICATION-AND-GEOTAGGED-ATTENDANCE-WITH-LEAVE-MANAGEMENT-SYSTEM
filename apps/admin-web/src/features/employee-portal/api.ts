import { apiRequest } from "../../lib/api";

export type AttendanceRecordType = "OFFICE" | "FIELD";

export type TodayAttendance = {
  status: string;
  timeInAt: string | null;
  timeOutAt: string | null;
  lunchOutAt?: string | null;
  lunchInAt?: string | null;
  visitNumber?: number;
  workLocationId?: string | null;
  recordType?: AttendanceRecordType;
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

export type AttendanceSubmitResult = {
  approved: boolean;
  verificationStatus: string;
  logType: "TIME_IN" | "TIME_OUT" | "LUNCH_OUT" | "LUNCH_IN";
  geoResult: { reason?: string | null };
  faceResult: { reason?: string | null };
  faceImage?: string | null;
  // The server's own timestamp for this scan — exactly what got written to
  // the AttendanceRecord (and therefore the DTR) as timeInAt/timeOutAt/
  // lunchOutAt/lunchInAt. Only present when approved; always prefer this
  // over the browser's own clock when displaying "recorded at" times, since
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
  workLocationId?: string;
  action?: "TIME_OUT" | "LUNCH_OUT" | "LUNCH_IN";
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
  hasActiveFaceEnrollment?: boolean;
  // Only present on the GET /employees/me response — whether this employee
  // has an active EmployeeSchedule assignment whose workingDays include today.
  hasScheduleToday?: boolean;
  user: { email: string };
  department: { name: string };
  position: { title: string };
};

export type AttendanceEligibility = {
  faceEnrolled: boolean;
  hasWorkLocation: boolean;
  hasScheduleToday: boolean;
};

// Live, continuously-recomputed status of whether the employee's current GPS
// position falls within (the radius of) any of their assigned work
// locations — "checking" while a fix is pending, "unavailable" when location
// permission is denied or nothing is assigned yet to compare against.
export type GeofenceStatus = "checking" | "inside" | "outside" | "unavailable";

export type LeaveType = {
  id: string;
  name: string;
  defaultDays: string;
  requiresDocument: boolean;
  supportingDocumentAfterDays: number | null;
  requiresHrValidation: boolean;
  requiresEhsActivation: boolean;
  ehsActivated: boolean;
  allowWithoutPay: boolean;
  isUnlimitedDays: boolean;
  isActive: boolean;
  requiresAdminGrant: boolean;
  isSingleDayOnly: boolean;
  advanceFilingAllowed: boolean;
  kind: "GENERAL" | "MATERNITY" | "PATERNITY";
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
  extensionRequested?: boolean;
  extensionApproved?: boolean | null;
};

export type ResubmitLeaveRequestInput = {
  note?: string;
  attachmentName: string;
  attachmentMimeType: string;
  attachmentData: string;
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
  extensionRequested?: boolean;
};

export function getTodayAttendance(employeeId: string) {
  return apiRequest<TodayAttendance>(`/attendance/today/${employeeId}`);
}

export function getAttendanceHistory(employeeId: string, limit = 30) {
  return apiRequest<AttendanceHistoryRecord[]>(`/attendance/history/${employeeId}?limit=${limit}`);
}

export function detectFace(imageBase64: string, precise = false) {
  return apiRequest<{ detected: boolean; confidence: number; box: FaceBox | null; ear: number | null }>("/face/detect", {
    method: "POST",
    body: JSON.stringify({ imageBase64, precise }),
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

export function cancelLeaveRequest(id: string) {
  return apiRequest<LeaveRequest>(`/leave-requests/${id}/cancel`, {
    method: "PATCH",
  });
}

export function resubmitLeaveRequest(id: string, input: ResubmitLeaveRequestInput) {
  return apiRequest<LeaveRequest>(`/leave-requests/${id}/resubmit`, {
    method: "PATCH",
    body: JSON.stringify(input),
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

export function getUndertimeEligibility(employeeId: string) {
  return apiRequest<UndertimeEligibility>(`/undertime-filings/eligibility/${employeeId}`);
}

export function getUndertimeFilings(employeeId: string) {
  return apiRequest<UndertimeFiling[]>(`/undertime-filings?employeeId=${employeeId}`);
}

export function fileUndertime(employeeId: string, reason?: string) {
  return apiRequest<UndertimeFiling>("/undertime-filings", {
    method: "POST",
    body: JSON.stringify({ employeeId, reason }),
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

export function updateMyPhoto(profilePhotoData: string, profilePhotoMimeType: string) {
  return apiRequest<EmployeeProfile>("/employees/me/photo", {
    method: "PATCH",
    body: JSON.stringify({ profilePhotoData, profilePhotoMimeType }),
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
