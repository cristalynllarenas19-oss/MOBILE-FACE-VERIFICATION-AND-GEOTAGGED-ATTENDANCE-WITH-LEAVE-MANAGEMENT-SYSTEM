import { apiRequest } from "../../lib/api";

export type AttendanceRecordType = "OFFICE" | "FIELD";

export type TodayAttendance = {
  status: string;
  timeInAt: string | null;
  timeOutAt: string | null;
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
  // Stored per-log for exactly this reason — the photo itself is never
  // watermarked (see CameraScanner's finishScan), so a viewer draws the GPS
  // stamp from these instead. Decimal columns serialize as strings over
  // JSON, same as WorkLocation's lat/lng above.
  latitude: string | number;
  longitude: string | number;
  // Reverse-geocoded once, server-side, at submission time (see
  // attendance.service.ts submit()) — always prefer this over re-geocoding
  // client-side, since that's what keeps mobile's and web's DTR viewers
  // showing the same address for the same log instead of each asking a
  // different geocoding provider. Null for rows from before this field
  // existed, or if the geocode itself failed.
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
  // Whether any of this record's logs has a captured photo — computed
  // server-side so the list can show the camera badge without shipping the
  // photo data itself (see getHistory()'s comment in attendance.service.ts).
  hasPhoto?: boolean;
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
  cancellationAllowed: boolean;
  cancellationCutoffValue: number | null;
  cancellationCutoffUnit: "WORKING_DAYS_BEFORE_START" | "HOURS_BEFORE_SHIFT_START" | null;
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
  type: "REJECTED" | "RESUBMITTED" | "CANCELLED" | "CANCELLATION_DENIED";
  message?: string | null;
  requiresAdditionalRequirements?: boolean;
  requirementDetails?: string | null;
  attachmentName?: string | null;
  attachmentMimeType?: string | null;
  attachmentData?: string | null;
  createdAt: string;
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

export type LeaveRequest = {
  id: string;
  startDate: string;
  endDate: string;
  totalDays: string;
  status: string;
  reason: string;
  createdAt: string;
  attachmentName?: string | null;
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
  extensionRequested?: boolean;
  extensionApproved?: boolean | null;
  // Server-computed — whether an employee (not an admin override) could
  // cancel this request right now, and why not if not. Only meaningful for
  // an APPROVED request; PENDING/SUPERVISOR_APPROVED are always allowed.
  cancellation?: { allowed: boolean; reason?: string; deadline?: string };
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

// Fetched lazily when a DTR row's detail modal is opened — see the
// AttendanceLogPhoto.faceImageData comment above.
export function getAttendanceRecordPhotos(recordId: string) {
  return apiRequest<Pick<AttendanceLogPhoto, "id" | "faceImageData" | "faceImageMimeType">[]>(
    `/attendance/records/${recordId}/photos`,
  );
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

export function cancelLeaveRequest(id: string, note: string) {
  return apiRequest<LeaveRequest>(`/leave-requests/${id}/cancel`, {
    method: "PATCH",
    body: JSON.stringify({ note }),
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

export type MySchedule = {
  id: string;
  startsOn: string;
  endsOn?: string | null;
  // 0=Sunday..6=Saturday, matches JS Date.getDay().
  workingDays: number[];
};

// The signed-in employee's own active schedule assignment(s) — used to mark
// their non-working days on the leave-filing calendar (mirrors
// employee-mobile's api.ts getMySchedules).
export function getMySchedules() {
  return apiRequest<MySchedule[]>("/schedules/mine");
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
