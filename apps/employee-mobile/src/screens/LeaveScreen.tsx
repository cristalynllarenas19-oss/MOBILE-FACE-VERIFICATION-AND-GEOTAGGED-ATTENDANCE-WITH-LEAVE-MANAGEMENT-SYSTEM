import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Modal,
  SafeAreaView,
  Dimensions,
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import ResultModal, { ResultModalStatus } from "../components/ResultModal";
import LeaveBalanceChart from "../components/LeaveBalanceChart";
import CalendarPickerModal from "../components/CalendarPickerModal";
import SegmentedControl from "../components/SegmentedControl";
import {
  LeaveType,
  LeaveBalance,
  LeaveRequest,
  UndertimeEligibility,
  UndertimeFiling,
  EmployeeProfile,
  MySchedule,
  getLeaveTypes,
  getLeaveBalances,
  getLeaveRequests,
  createLeaveRequest,
  cancelLeaveRequest,
  resubmitLeaveRequest,
  getUndertimeEligibility,
  getUndertimeFilings,
  fileUndertime,
  getMyProfile,
  getMySchedules,
} from "../api";
import { CACHE_KEYS, useCachedData } from "../utils/dataCache";
import AestheticScrollView from "../components/AestheticScrollView";

const { height: SCREEN_HEIGHT } = Dimensions.get("window");
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
// There's no push/WebSocket infra in this app — a supervisor's approve/
// reject only lands here on the next fetch. Polling this often while the
// screen is mounted (it unmounts when the tab is switched away, since
// MainScreen swaps tabs via plain state rather than routing) is the
// pragmatic way to make that feel near-instant without adding real-time
// transport.
const LEAVE_POLL_MS = 3000;

// Stable fallbacks so useMemo filters don't recompute on every render while
// the cache/network is still empty.
const EMPTY_LEAVE_TYPES: LeaveType[] = [];
const EMPTY_BALANCES: LeaveBalance[] = [];
const EMPTY_REQUESTS: LeaveRequest[] = [];
const EMPTY_UNDERTIME_FILINGS: UndertimeFiling[] = [];
const EMPTY_SCHEDULES: MySchedule[] = [];

type PickedAttachment = {
  name: string;
  mimeType: string;
  sizeBytes: number;
  base64: string;
};

type Props = {
  employeeId?: string;
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Mirrors the backend's isEligibleForLeaveType (leave-balances.service.ts) —
// Maternity/Paternity-kind types are sex-restricted even though both are
// listed as applicable to REGULAR employees on the leave type itself.
function isEligibleForLeaveType(kind: LeaveType["kind"], sex: EmployeeProfile["sex"]) {
  if (kind === "MATERNITY") return sex === "FEMALE";
  if (kind === "PATERNITY") return sex === "MALE";
  return true;
}

function isOneDayLeaveType(name?: string, isSingleDayOnly?: boolean) {
  if (isSingleDayOnly) return true;
  const normalized = (name ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return normalized.includes("adverse weather") || normalized === "sick leave" || normalized === "emergency leave";
}

// SUPERVISOR_APPROVED only exists on legacy rows from the old two-step flow;
// it stays amber because it still needs one more Approve click to finalize.
type RequestStatusFilter = "ALL" | "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";

// Same neutral pill style as every other filter chip here (Filed From/To
// below) — a permanent per-status color made the row read as decoration
// rather than a set of toggles.
const STATUS_FILTERS: { key: Exclude<RequestStatusFilter, "ALL">; label: string }[] = [
  { key: "PENDING", label: "Pending" },
  { key: "APPROVED", label: "Approved" },
  { key: "REJECTED", label: "Rejected" },
  { key: "CANCELLED", label: "Cancelled" },
];

// Buckets a request's raw status into one of the four filter chips —
// SUPERVISOR_APPROVED joins APPROVED, and PENDING/NEEDS_REVISION/
// CANCELLATION_PENDING all join PENDING, same grouping as statusTone below.
function statusFilterBucket(status: string): Exclude<RequestStatusFilter, "ALL"> | null {
  if (status === "APPROVED" || status === "SUPERVISOR_APPROVED") return "APPROVED";
  if (status === "REJECTED") return "REJECTED";
  if (status === "CANCELLED") return "CANCELLED";
  if (status === "PENDING" || status === "NEEDS_REVISION" || status === "CANCELLATION_PENDING") return "PENDING";
  return null;
}

function statusTone(status: string) {
  // SUPERVISOR_APPROVED reads as "Approved" (see statusLabel) so it needs
  // the same green tone as APPROVED — matches admin-web's employee portal,
  // which already handles both.
  if (status === "APPROVED" || status === "SUPERVISOR_APPROVED") return { color: "#15803D", bg: "#DCFCE7" };
  if (status === "REJECTED") return { color: "#B91C1C", bg: "#FEE2E2" };
  // Darker red than REJECTED, not a different color family — still reads as
  // "not approved" but distinct in shade from an outright rejection.
  if (status === "CANCELLED") return { color: "#7F1D1D", bg: "#FEE2E2" };
  return { color: "#B45309", bg: "#FEF3C7" };
}

// Same wording as admin-web's employee portal and Leave Management page, so
// an employee and their supervisor/HR always read the same status for the
// same request regardless of which app they're on.
function statusLabel(status: string) {
  if (status === "SUPERVISOR_APPROVED") return "APPROVED";
  if (status === "CANCELLATION_PENDING") return "PENDING CANCELLATION";
  return status.replace(/_/g, " ");
}

export default function LeaveScreen({ employeeId }: Props) {
  const leaveTypesCache = useCachedData<LeaveType[]>(CACHE_KEYS.leaveTypes, getLeaveTypes);
  // Same cache key as MainScreen/ViewProfileScreen, so this reuses whatever
  // profile is already in cache instead of firing a redundant fetch.
  const profileCache = useCachedData<EmployeeProfile>(CACHE_KEYS.myProfile, getMyProfile);
  const employeeSex = profileCache.data?.sex;
  const balancesCache = useCachedData<LeaveBalance[]>(
    employeeId ? CACHE_KEYS.leaveBalances(employeeId) : null,
    () => getLeaveBalances(employeeId!),
  );
  const requestsCache = useCachedData<LeaveRequest[]>(
    employeeId ? CACHE_KEYS.leaveRequests(employeeId) : null,
    () => getLeaveRequests(employeeId!),
  );
  // Own schedule assignment(s) — drives the calendar's day-off/non-working
  // classification below (see isNonWorkingDay).
  const mySchedulesCache = useCachedData<MySchedule[]>(
    employeeId ? CACHE_KEYS.mySchedules(employeeId) : null,
    () => getMySchedules(),
  );
  const leaveTypes = leaveTypesCache.data ?? EMPTY_LEAVE_TYPES;
  const balances = balancesCache.data ?? EMPTY_BALANCES;
  const requests = requestsCache.data ?? EMPTY_REQUESTS;
  const mySchedules = mySchedulesCache.data ?? EMPTY_SCHEDULES;
  const isLoadingData = leaveTypesCache.isLoading || balancesCache.isLoading || requestsCache.isLoading;
  // Balance tab only ever renders balancesCache's data, so its spinner
  // shouldn't wait on the (much heavier) requests/leave-types fetches too.
  const isBalanceLoading = balancesCache.isLoading;

  const [leaveTypeId, setLeaveTypeId] = useState("");
  const [searchLeave, setSearchLeave] = useState("");
  const [reason, setReason] = useState("");

  const [startDate, setStartDate] = useState(new Date());
  const [endDate, setEndDate] = useState(new Date());
  const [startDateSelected, setStartDateSelected] = useState(false);
  const [endDateSelected, setEndDateSelected] = useState(false);

  const [isStartPickerVisible, setStartPickerVisibility] = useState(false);
  const [isEndPickerVisible, setEndPickerVisibility] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [dropdownLayout, setDropdownLayout] = useState({ x: 0, y: 0, width: 0 });
  const dropdownButtonRef = useRef<View>(null);

  const [attachment, setAttachment] = useState<PickedAttachment | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isPickingFile, setIsPickingFile] = useState(false);

  const [showPending, setShowPending] = useState(false);
  // "My Leave Requests" modal — Current (anything still awaiting a decision,
  // or approved and not yet finished) vs Past (cancelled, rejected, or an
  // approved leave whose dates are already over). Defaults to Current since
  // that's what an employee opens this for most of the time — including
  // right after requesting a cancellation, so that request stays visible
  // instead of appearing to vanish.
  const [requestsListTab, setRequestsListTab] = useState<"current" | "past">("current");
  const [requestsStatusFilter, setRequestsStatusFilter] = useState<RequestStatusFilter>("ALL");
  // Filed-date range — two calendars (from/to), same pattern as the leave
  // request form's own Start Date/End Date pickers above.
  const [requestsDateFrom, setRequestsDateFrom] = useState<Date | null>(null);
  const [requestsDateTo, setRequestsDateTo] = useState<Date | null>(null);
  const [isRequestsFromPickerVisible, setRequestsFromPickerVisibility] = useState(false);
  const [isRequestsToPickerVisible, setRequestsToPickerVisibility] = useState(false);
  // Tapping a summary row in the "My Leave Requests" list opens its detail
  // (with the Cancel button) in place of the list, inside the same modal.
  const [expandedRequestId, setExpandedRequestId] = useState<string | null>(null);
  // Cancel is a destructive, irreversible action — tapping Cancel opens this
  // confirm step instead of cancelling immediately. The backend requires a
  // reason (see leave.service.ts's cancel()), so it's collected right here.
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);
  const [cancelReasonText, setCancelReasonText] = useState("");
  // Resubmitting a NEEDS_REVISION request straight from its detail view here
  // — the same action already available from the LEAVE_NEEDS_REQUIREMENTS
  // notification (NotificationsScreen.tsx), so an employee who dismissed
  // that notification isn't stuck without a way back in.
  const [resubmitAttachment, setResubmitAttachment] = useState<PickedAttachment | null>(null);
  const [resubmitAttachmentError, setResubmitAttachmentError] = useState<string | null>(null);
  const [isPickingResubmitFile, setIsPickingResubmitFile] = useState(false);
  const [resubmitNote, setResubmitNote] = useState("");
  const [activeTab, setActiveTab] = useState<"balance" | "request" | "undertime">("balance");
  const [resultModal, setResultModal] = useState<{ status: ResultModalStatus; title: string; message: string } | null>(null);
  // Sticks around (independent of resultModal, which the user may have
  // already dismissed by the time a background submission actually fails)
  // until explicitly closed, and shows on every tab so a failed leave
  // request filed optimistically is never silently missed.
  const [submissionAlert, setSubmissionAlert] = useState<{ title: string; message: string } | null>(null);

  // Undertime filing
  const undertimeEligibilityCache = useCachedData<UndertimeEligibility>(
    employeeId ? CACHE_KEYS.undertimeEligibility(employeeId) : null,
    () => getUndertimeEligibility(employeeId!),
  );
  const undertimeFilingsCache = useCachedData<UndertimeFiling[]>(
    employeeId ? CACHE_KEYS.undertimeFilings(employeeId) : null,
    () => getUndertimeFilings(employeeId!),
  );
  const undertimeEligibility = undertimeEligibilityCache.data;
  const undertimeFilings = undertimeFilingsCache.data ?? EMPTY_UNDERTIME_FILINGS;
  const [undertimeReason, setUndertimeReason] = useState("");
  const [isFilingUndertime, setIsFilingUndertime] = useState(false);

  async function handleFileUndertime() {
    if (!employeeId) return;
    setIsFilingUndertime(true);
    try {
      await fileUndertime(employeeId, undertimeReason.trim() || undefined);
      setUndertimeReason("");
      await Promise.all([undertimeEligibilityCache.refresh(), undertimeFilingsCache.refresh()]);
      setResultModal({ status: "approved", title: "Undertime Filed", message: "Your undertime filing for today has been recorded." });
    } catch (err) {
      setResultModal({
        status: "error",
        title: "Filing Failed",
        message: err instanceof Error ? err.message : "Unable to file undertime.",
      });
    } finally {
      setIsFilingUndertime(false);
    }
  }

  const selectedLeaveType = leaveTypes.find((t) => t.id === leaveTypeId);
  const isSingleDayLeave = isOneDayLeaveType(selectedLeaveType?.name, selectedLeaveType?.isSingleDayOnly);
  // Separate from isSingleDayLeave (which only controls the 1-day duration
  // UI) — this is the advance-filing rule (Sick Leave: today only, never a
  // future date), driven by the leave type's own config so it isn't tied to
  // the type's name or its single-day-ness.
  const lockedToToday = selectedLeaveType?.advanceFilingAllowed === false;
  const today = useMemo(() => new Date(), []);
  const todayStart = useMemo(() => new Date(today.getFullYear(), today.getMonth(), today.getDate()), [today]);
  const filteredLeaveTypes = leaveTypes
    .filter((item) => item.isActive !== false)
    .filter((item) => !item.requiresEhsActivation || item.ehsActivated)
    .filter((item) => isEligibleForLeaveType(item.kind, employeeSex))
    .filter((item) => item.name.toLowerCase().includes(searchLeave.toLowerCase()));

  const remainingByLeaveType = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of balances) map.set(b.leaveTypeId, b.remainingDays);
    return map;
  }, [balances]);

  function remainingDaysFor(item: LeaveType) {
    const remaining = remainingByLeaveType.get(item.id);
    if (remaining !== undefined) return remaining;
    return item.requiresAdminGrant ? 0 : Number(item.defaultDays);
  }

  // Admin-grant-only types (Solo Parent, Study Leave, Added Paternity Leave)
  // that this employee hasn't been granted yet shouldn't clutter the balance
  // view with a 0/0 row — they only show up there once HR/Admin grants them.
  const visibleBalances = useMemo(() => {
    return balances.filter((b) => {
      const type = leaveTypes.find((t) => t.id === b.leaveTypeId);
      if (type?.requiresAdminGrant && b.earnedDays <= 0) return false;
      return true;
    });
  }, [balances, leaveTypes]);

  function isLeaveTypeExhausted(item: LeaveType) {
    if (item.allowWithoutPay || item.isUnlimitedDays) return false;
    return remainingDaysFor(item) <= 0;
  }

  // "Request" button on a balance row: jump to the request tab with that
  // leave type already selected, unless it can't be requested (same rules as
  // the disabled dropdown entries).
  function handleRequestFromBalance(id: string) {
    const type = leaveTypes.find((t) => t.id === id);
    if (!type || type.isActive === false) return;
    if (isLeaveTypeExhausted(type)) {
      setResultModal({
        status: "info",
        title: type.requiresAdminGrant ? "Not Yet Granted" : "No Balance Left",
        message: type.requiresAdminGrant
          ? `${type.name} must be granted by HR/Admin before you can request it. Please apply to HR/Admin first.`
          : `You have no remaining ${type.name} days to request.`,
      });
      return;
    }
    if (isLeaveTypeAlreadyPending(type)) {
      setResultModal({
        status: "info",
        title: "Already Pending",
        message: `You already have a ${type.name} request awaiting review. Please wait until it is approved, rejected, or cancelled before filing another for this leave type.`,
      });
      return;
    }
    if (isLeaveTypeUnavailableToday(type)) {
      setResultModal({
        status: "info",
        title: "Non-Working Day",
        message: `${type.name} can only be filed for today's date, but today is your day off / a non-working day.`,
      });
      return;
    }
    setLeaveTypeId(id);
    if (type.isSingleDayOnly) {
      setStartDate(todayStart);
      setEndDate(todayStart);
      setStartDateSelected(true);
      setEndDateSelected(true);
    }
    setActiveTab("request");
  }

  function openLeaveTypeDropdown() {
    dropdownButtonRef.current?.measureInWindow((x, y, width, height) => {
      setDropdownLayout({ x, y: y + height, width });
      setIsDropdownOpen(true);
    });
    setSearchLeave("");
  }

  const pendingRequests = useMemo(
    () => requests.filter((r) => r.status === "PENDING" || r.status === "SUPERVISOR_APPROVED" || r.status === "NEEDS_REVISION"),
    [requests],
  );
  // A request is "current" if it's still awaiting a decision (including a
  // pending self-cancellation — CANCELLATION_PENDING — so requesting a
  // cancellation never makes the request appear to vanish from this list) or
  // it's APPROVED and its leave period hasn't finished yet. Everything else
  // (CANCELLED, REJECTED, or an APPROVED leave whose dates are already over)
  // is "past". Together these two are every request the employee has ever
  // filed — the split is purely by date/finality, not a separate filter.
  // Each card's own Cancel button still only shows when that specific
  // request is actually cancellable (see canShowCancelSection below), never
  // assumed here.
  function isCurrentLeaveRequest(r: LeaveRequest) {
    if (
      r.status === "PENDING" ||
      r.status === "SUPERVISOR_APPROVED" ||
      r.status === "NEEDS_REVISION" ||
      r.status === "CANCELLATION_PENDING"
    ) {
      return true;
    }
    return r.status === "APPROVED" && new Date(r.endDate) >= todayStart;
  }

  function matchesDateFilter(r: LeaveRequest) {
    if (!requestsDateFrom && !requestsDateTo) return true;
    const filed = new Date(r.createdAt);
    const filedDateOnly = new Date(filed.getFullYear(), filed.getMonth(), filed.getDate());
    if (requestsDateFrom) {
      const from = new Date(requestsDateFrom.getFullYear(), requestsDateFrom.getMonth(), requestsDateFrom.getDate());
      if (filedDateOnly < from) return false;
    }
    if (requestsDateTo) {
      const to = new Date(requestsDateTo.getFullYear(), requestsDateTo.getMonth(), requestsDateTo.getDate());
      if (filedDateOnly > to) return false;
    }
    return true;
  }

  function matchesStatusFilter(r: LeaveRequest) {
    if (requestsStatusFilter === "ALL") return true;
    return statusFilterBucket(r.status) === requestsStatusFilter;
  }

  const currentRequests = useMemo(
    () =>
      requests
        .filter((r) => isCurrentLeaveRequest(r) && matchesDateFilter(r) && matchesStatusFilter(r))
        .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime()),
    [requests, todayStart, requestsDateFrom, requestsDateTo, requestsStatusFilter],
  );
  // History — everything not currently active, most-recently-filed first.
  const pastRequests = useMemo(
    () =>
      requests
        .filter((r) => !isCurrentLeaveRequest(r) && matchesDateFilter(r) && matchesStatusFilter(r))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [requests, todayStart, requestsDateFrom, requestsDateTo, requestsStatusFilter],
  );
  const expandedRequest = useMemo(
    () => requests.find((r) => r.id === expandedRequestId),
    [requests, expandedRequestId],
  );

  // Clears any in-progress resubmission draft whenever the detail view
  // navigates to a different request (or back to the list) — otherwise a
  // half-attached file for one request could get submitted against another.
  useEffect(() => {
    setResubmitAttachment(null);
    setResubmitAttachmentError(null);
    setResubmitNote("");
  }, [expandedRequestId]);

  // Mirrors the backend's same-type check (leave.service.ts) — a leave type
  // with an active request can't be selected again until that one is
  // resolved, but other types remain requestable.
  function isLeaveTypeAlreadyPending(item: LeaveType) {
    return pendingRequests.some((r) => r.leaveType.id === item.id);
  }

  // Re-fetches everything after a mutation (e.g. submitting a request);
  // initial loads happen inside each useCachedData hook.
  async function loadData() {
    try {
      await Promise.all([leaveTypesCache.refresh(), balancesCache.refresh(), requestsCache.refresh()]);
    } catch (error) {
      console.error("Failed to load leave data", error);
    }
  }

  // Keeps status changes (a supervisor's approve/reject, balance deducted,
  // etc.) showing up here without the employee having to leave and reopen
  // the tab. Stopped automatically on unmount, i.e. whenever they switch
  // away from the Leave tab.
  const loadDataRef = useRef(loadData);
  loadDataRef.current = loadData;
  useEffect(() => {
    const interval = setInterval(() => loadDataRef.current(), LEAVE_POLL_MS);
    // setInterval doesn't reliably keep firing while the app is backgrounded
    // — refetch immediately on returning to the foreground so a decision
    // made while the employee's phone was locked shows up the moment they
    // look at it again, instead of waiting out whatever's left of the poll.
    const appStateSub = AppState.addEventListener("change", (state) => {
      if (state === "active") loadDataRef.current();
    });
    return () => {
      clearInterval(interval);
      appStateSub.remove();
    };
  }, []);

  // Opening the requests list is exactly when a stale status is most
  // visible and most annoying — force a fresh fetch right away instead of
  // waiting for the next poll tick (up to LEAVE_POLL_MS late). Only
  // `requests` is shown in this modal, so only that cache needs refetching.
  function openPendingModal() {
    setShowPending(true);
    setRequestsListTab("current");
    setRequestsDateFrom(null);
    setRequestsDateTo(null);
    requestsCache.refresh().catch(() => undefined);
  }

  // Optimistic — the app already knows the outcome (mirrors
  // leave.service.ts's cancel(): an APPROVED request can't cancel outright,
  // it drops to CANCELLATION_PENDING until a Supervisor/Admin decides;
  // anything else not yet committed goes straight to CANCELLED) — so the
  // confirmation modal closes and the new status shows immediately instead
  // of the employee waiting on the round trip, and the request to the
  // supervisor goes out in the background. Balance is untouched either way
  // (see cancel()'s comments), so only the requests cache needs refreshing.
  //
  // Deliberately does NOT clear expandedRequestId — the employee stays right
  // where they were and sees the request's own status flip to "Pending
  // Cancellation"/"Cancelled" in place, instead of being bounced back out to
  // the list.
  function handleCancel(requestId: string, note: string) {
    const target = requests.find((r) => r.id === requestId);
    if (!target) return;
    const newStatus = target.status === "APPROVED" ? "CANCELLATION_PENDING" : "CANCELLED";

    requestsCache.setData(requests.map((r) => (r.id === requestId ? { ...r, status: newStatus } : r)));
    setResultModal({
      status: "approved",
      title: newStatus === "CANCELLATION_PENDING" ? "Cancellation Requested" : "Leave Request Cancelled",
      message:
        newStatus === "CANCELLATION_PENDING"
          ? "Your supervisor has been notified and will need to approve this cancellation."
          : "This leave request has been cancelled.",
    });

    cancelLeaveRequest(requestId, note)
      .then(() => requestsCache.refresh())
      .catch((err) => {
        // The optimistic status above was wrong — re-sync with the real
        // server state instead of leaving a false status showing.
        requestsCache.refresh().catch(() => undefined);
        setResultModal({
          status: "error",
          title: "Cancellation Failed",
          message: err instanceof Error ? err.message : "Unable to cancel this leave request.",
        });
      });
  }

  const handleStartDateConfirm = (selectedDate = new Date()) => {
    setStartPickerVisibility(false);
    setStartDate(selectedDate);
    setStartDateSelected(true);
    if (isSingleDayLeave) {
      setEndDate(selectedDate);
      setEndDateSelected(true);
      return;
    }
    if (endDateSelected && selectedDate > endDate) {
      setEndDate(selectedDate);
    }
  };

  const handleEndDateConfirm = (selectedDate = new Date()) => {
    setEndPickerVisibility(false);
    setEndDate(selectedDate);
    setEndDateSelected(true);
  };

  const formatDate = (displayDate = new Date()) => {
    return `${displayDate.getMonth() + 1}/${displayDate.getDate()}/${displayDate.getFullYear()}`;
  };

  const totalDays = useMemo(() => {
    if (isSingleDayLeave) return 1;
    if (!startDateSelected || !endDateSelected) return 0;
    const diff = Math.round((endDate.getTime() - startDate.getTime()) / 86400000) + 1;
    return Math.max(1, diff);
  }, [isSingleDayLeave, startDate, endDate, startDateSelected, endDateSelected]);

  // The date range a request can span cannot exceed the leave type's
  // remaining allotment (e.g. Vacation Leave with 15 days left caps the end
  // date 15 days after the start date) — unlimited/without-pay types are
  // exempt, same as the balance check in handleSubmit below.
  const maxEndDate = useMemo(() => {
    if (!selectedLeaveType || !startDateSelected) return undefined;
    if (selectedLeaveType.allowWithoutPay || selectedLeaveType.isUnlimitedDays) return undefined;
    const remaining = remainingDaysFor(selectedLeaveType);
    const max = new Date(startDate);
    max.setDate(max.getDate() + Math.max(0, remaining - 1));
    return max;
  }, [selectedLeaveType, startDate, startDateSelected, remainingByLeaveType]);

  // Date ranges already filed (any non-cancelled/rejected status) for the
  // currently selected leave type — the calendar disables every individual
  // day within them, and handleSubmit's overlap check (mirroring the
  // backend) is the authoritative backstop regardless of what the UI shows.
  const blockedRangesForSelectedType = useMemo(() => {
    if (!leaveTypeId) return [];
    return requests
      .filter(
        (r) =>
          r.leaveType.id === leaveTypeId &&
          (r.status === "PENDING" ||
            r.status === "SUPERVISOR_APPROVED" ||
            r.status === "NEEDS_REVISION" ||
            r.status === "APPROVED"),
      )
      .map((r) => ({
        start: new Date(new Date(r.startDate).getFullYear(), new Date(r.startDate).getMonth(), new Date(r.startDate).getDate()),
        end: new Date(new Date(r.endDate).getFullYear(), new Date(r.endDate).getMonth(), new Date(r.endDate).getDate()),
      }));
  }, [requests, leaveTypeId]);

  function isDateAlreadyFiledForType(date: Date) {
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const hit = blockedRangesForSelectedType.some((range) => day >= range.start && day <= range.end);
    return hit ? "Already filed for this leave type" : undefined;
  }

  // Sunday is a company-wide rest day (mirrors backend/schedule.util.ts's
  // isDayOff); beyond that, a schedule assignment active on this date can
  // narrow which other weekdays are actually worked (e.g. a 6-day shift's
  // Saturday, or a part-timer's own override). No active assignment for the
  // date falls back to "working" — same "nothing to compare against" rule
  // the backend uses.
  function isDateNonWorking(date: Date) {
    if (date.getDay() === 0) return "Day off / non-working day";
    const schedule = mySchedules.find((s) => {
      const start = new Date(s.startsOn);
      if (date < new Date(start.getFullYear(), start.getMonth(), start.getDate())) return false;
      if (!s.endsOn) return true;
      const end = new Date(s.endsOn);
      return date <= new Date(end.getFullYear(), end.getMonth(), end.getDate());
    });
    if (!schedule) return undefined;
    return schedule.workingDays.includes(date.getDay()) ? undefined : "Day off / non-working day";
  }

  // A !advanceFilingAllowed type (Sick Leave, Emergency Leave, Adverse
  // Weather Leave) can only ever be filed for today — so if today happens to
  // be this employee's day off, the type is entirely unfilable right now,
  // not just on some dates. Surfaced up front (dropdown + Date section)
  // instead of only failing at submit time.
  function isLeaveTypeUnavailableToday(item: LeaveType) {
    return item.advanceFilingAllowed === false && Boolean(isDateNonWorking(todayStart));
  }

  // Single-day-only types (Sick Leave, Emergency Leave) always mirror the end
  // date to the start date the moment either one is known.
  useEffect(() => {
    if (isSingleDayLeave && startDateSelected) {
      setEndDate(startDate);
      setEndDateSelected(true);
    }
  }, [isSingleDayLeave, startDate, startDateSelected]);

  useEffect(() => {
    if (!lockedToToday) return;
    setStartDate(todayStart);
    setEndDate(todayStart);
    setStartDateSelected(true);
    setEndDateSelected(true);
  }, [lockedToToday, todayStart]);

  // Clamp a previously-picked end date if switching leave type (or the
  // remaining balance) shrinks the allowed range below it.
  useEffect(() => {
    if (!maxEndDate || !endDateSelected) return;
    if (endDate > maxEndDate) setEndDate(maxEndDate);
  }, [maxEndDate]);

  async function pickAttachment() {
    setAttachmentError(null);
    setIsPickingFile(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ["image/*", "application/pdf"],
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];

      if (asset.size && asset.size > MAX_ATTACHMENT_BYTES) {
        setAttachmentError("File is too large. Please attach a file under 5MB.");
        return;
      }

      const base64 = asset.base64 ?? (await new File(asset.uri).base64());
      const sizeBytes = asset.size ?? Math.ceil((base64.length * 3) / 4);

      if (sizeBytes > MAX_ATTACHMENT_BYTES) {
        setAttachmentError("File is too large. Please attach a file under 5MB.");
        return;
      }

      setAttachment({
        name: asset.name,
        mimeType: asset.mimeType ?? "application/octet-stream",
        sizeBytes,
        base64,
      });
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "Failed to attach file.");
    } finally {
      setIsPickingFile(false);
    }
  }

  async function pickResubmitAttachment() {
    setResubmitAttachmentError(null);
    setIsPickingResubmitFile(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ["image/*", "application/pdf"],
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];

      if (asset.size && asset.size > MAX_ATTACHMENT_BYTES) {
        setResubmitAttachmentError("File is too large. Please attach a file under 5MB.");
        return;
      }

      const base64 = asset.base64 ?? (await new File(asset.uri).base64());
      const sizeBytes = asset.size ?? Math.ceil((base64.length * 3) / 4);

      if (sizeBytes > MAX_ATTACHMENT_BYTES) {
        setResubmitAttachmentError("File is too large. Please attach a file under 5MB.");
        return;
      }

      setResubmitAttachment({
        name: asset.name,
        mimeType: asset.mimeType ?? "application/octet-stream",
        sizeBytes,
        base64,
      });
    } catch (error) {
      setResubmitAttachmentError(error instanceof Error ? error.message : "Failed to attach file.");
    } finally {
      setIsPickingResubmitFile(false);
    }
  }

  function handleResubmitRequest(requestId: string) {
    if (!resubmitAttachment) {
      setResubmitAttachmentError("Please attach the requested requirement before resubmitting.");
      return;
    }
    const payload = {
      note: resubmitNote.trim() || undefined,
      attachmentName: resubmitAttachment.name,
      attachmentMimeType: resubmitAttachment.mimeType,
      attachmentData: resubmitAttachment.base64,
    };

    // Optimistic — resubmit() always succeeds straight from NEEDS_REVISION to
    // PENDING (see leave.service.ts), so the request shows back in the
    // supervisor's queue immediately instead of the employee waiting on the
    // round trip. The attachment/note controls disappear the instant this
    // fires since they're only ever shown for a NEEDS_REVISION request.
    requestsCache.setData(requests.map((r) => (r.id === requestId ? { ...r, status: "PENDING" } : r)));
    setResubmitAttachment(null);
    setResubmitAttachmentError(null);
    setResubmitNote("");
    setResultModal({ status: "approved", title: "Resubmitted", message: "Your reviewer has been notified." });

    resubmitLeaveRequest(requestId, payload).catch((error) => {
      requestsCache.refresh().catch(() => undefined);
      setResultModal({
        status: "error",
        title: "Resubmission Failed",
        message: error instanceof Error ? error.message : "Please try again.",
      });
    });
  }

  function resetForm() {
    setLeaveTypeId("");
    setReason("");
    setStartDateSelected(false);
    setEndDateSelected(false);
    setStartDate(new Date());
    setEndDate(new Date());
    setAttachment(null);
    setAttachmentError(null);
  }

  async function handleSubmit() {
    if (!employeeId) {
      setResultModal({ status: "error", title: "Missing Employee Profile", message: "This account isn't linked to an employee record." });
      return;
    }
    if (!leaveTypeId) {
      setResultModal({ status: "info", title: "Select Leave Type", message: "Please choose a leave type before submitting." });
      return;
    }
    if (!startDateSelected || !endDateSelected) {
      setResultModal({ status: "info", title: "Select Dates", message: "Please choose both a start and end date." });
      return;
    }
    if (!reason.trim()) {
      setResultModal({ status: "info", title: "Reason Required", message: "Please tell us the reason for your leave." });
      return;
    }

    const leaveStartDate = isSingleDayLeave ? startDate : startDate;
    const leaveEndDate = isSingleDayLeave ? startDate : endDate;
    const leaveTotalDays = isSingleDayLeave ? 1 : totalDays;

    // Mirrors the backend's own-day-off check (leave.service.ts) — catches
    // dates set outside the calendar's disabled-day styling, e.g. the
    // "Request" shortcut from the Balance tab, which jumps straight to today.
    const nonWorkingBoundary = isDateNonWorking(leaveStartDate) ? leaveStartDate : isDateNonWorking(leaveEndDate) ? leaveEndDate : null;
    if (nonWorkingBoundary) {
      setResultModal({
        status: "info",
        title: "Non-Working Day",
        message: `${formatDate(nonWorkingBoundary)} is your day off / a non-working day. Leave can only be filed for a working day.`,
      });
      return;
    }

    // Mirrors the backend's check (leave.service.ts) so the error shows up
    // immediately instead of after a round trip — same type is blocked
    // regardless of dates, a different type is always fine.
    const pendingOfSameType = pendingRequests.find((r) => r.leaveType.id === leaveTypeId);
    if (pendingOfSameType) {
      setResultModal({
        status: "error",
        title: "Already Pending",
        message: `You already have a ${selectedLeaveType?.name} request awaiting review. Please wait until it is approved, rejected, or cancelled before filing another for this leave type.`,
      });
      return;
    }

    // Any date already covered by an APPROVED request of this *same* leave
    // type is off-limits until that request is cancelled. Mirrors the
    // backend's check in leave.service.ts.
    const overlappingApproved = requests.find(
      (r) =>
        r.leaveType.id === leaveTypeId &&
        r.status === "APPROVED" &&
        new Date(r.startDate) <= leaveEndDate &&
        new Date(r.endDate) >= leaveStartDate,
    );
    if (overlappingApproved) {
      setResultModal({
        status: "error",
        title: "Dates Unavailable",
        message: `These dates overlap your approved ${selectedLeaveType?.name} (${new Date(overlappingApproved.startDate).toLocaleDateString()} - ${new Date(overlappingApproved.endDate).toLocaleDateString()}). Cancel that request first if you need to change it.`,
      });
      return;
    }

    if (selectedLeaveType?.requiresDocument && !attachment) {
      setResultModal({
        status: "info",
        title: "Document Required",
        message: `${selectedLeaveType.name} requires a supporting document. Please attach one before submitting.`,
      });
      return;
    }
    if (selectedLeaveType && !selectedLeaveType.allowWithoutPay && !selectedLeaveType.isUnlimitedDays) {
      const remainingDays = remainingDaysFor(selectedLeaveType);
      if (selectedLeaveType.requiresAdminGrant && remainingDays <= 0) {
        setResultModal({
          status: "info",
          title: "Not Yet Granted",
          message: `${selectedLeaveType.name} must be granted by HR/Admin before you can request it. Please apply to HR/Admin first.`,
        });
        return;
      }
      if (remainingDays <= 0) {
        setResultModal({
          status: "error",
          title: "No Remaining Balance",
          message: "You have no remaining balance for this leave type.",
        });
        return;
      }
      if (leaveTotalDays > remainingDays) {
        setResultModal({
          status: "error",
          title: "Insufficient Balance",
          message: `You have ${remainingDays} day(s) of ${selectedLeaveType.name} left, but requested ${leaveTotalDays}.`,
        });
        return;
      }
    }

    // All the validation above (including the same-type-pending check)
    // already mirrors what the backend will enforce, so the request is
    // effectively guaranteed to succeed — confirm immediately and let the
    // actual submission finish in the background instead of making the
    // employee wait on the round trip.
    const payload = {
      employeeId,
      leaveTypeId,
      startDate: leaveStartDate.toISOString(),
      endDate: leaveEndDate.toISOString(),
      totalDays: leaveTotalDays,
      reason: reason.trim(),
      attachmentName: attachment?.name,
      attachmentMimeType: attachment?.mimeType,
      attachmentData: attachment?.base64,
    };

    resetForm();
    setResultModal({
      status: "approved",
      title: "Leave Request Submitted",
      message: "Your HR/Admin and supervisor have been notified. You'll be notified once it's reviewed.",
    });

    createLeaveRequest(payload)
      // The POST already returns the created record — write it straight into
      // the cache instead of following up with a second GET round-trip, so
      // it appears on "My Leave Requests" the moment submission succeeds.
      .then((created) => requestsCache.setData([created, ...requests]))
      .catch((error) => {
        // The "Submitted" modal above has likely already been dismissed by
        // now, so a transient modal here isn't enough — this sticks around
        // (see submissionAlert) until the employee explicitly closes it.
        setSubmissionAlert({
          title: "Leave Request Failed",
          message: `Your ${selectedLeaveType?.name ?? "leave"} request did not go through: ${error instanceof Error ? error.message : "please try again."}`,
        });
        // Best-effort — if this also fails (e.g. still offline), the cached
        // pending list simply stays as it was; the alert above is what
        // actually informs the employee either way.
        requestsCache.refresh().catch(() => undefined);
      });
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      {submissionAlert && (
        <View style={styles.submissionAlertBanner}>
          <Ionicons name="warning-outline" size={18} color="#B91C1C" />
          <View style={{ flex: 1 }}>
            <Text style={styles.submissionAlertTitle}>{submissionAlert.title}</Text>
            <Text style={styles.submissionAlertMessage}>{submissionAlert.message}</Text>
          </View>
          <Pressable onPress={() => setSubmissionAlert(null)} hitSlop={8}>
            <Ionicons name="close" size={18} color="#B91C1C" />
          </Pressable>
        </View>
      )}
      <SegmentedControl
        segments={[
          { key: "balance", label: "Balance" },
          { key: "request", label: "Request" },
          { key: "undertime", label: "Undertime" },
        ]}
        value={activeTab}
        onChange={(key) => setActiveTab(key as typeof activeTab)}
        style={styles.tabSwitcher}
      />

      {activeTab === "balance" ? (
        <View style={[styles.tabContentPad, { flex: 1 }]}>
          <LeaveBalanceChart
            balances={visibleBalances}
            loading={isBalanceLoading}
            pendingCount={pendingRequests.length}
            onPressPending={openPendingModal}
            onPressViewAll={openPendingModal}
            onRequestLeave={handleRequestFromBalance}
          />
        </View>
      ) : activeTab === "undertime" ? (
        <AestheticScrollView
          contentContainerStyle={[styles.tabContentPad, { flexGrow: 1 }]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.card}>
            <View style={styles.formHeader}>
              <Ionicons color="#DC2777" name="document-text-outline" size={32} />
              <Text style={styles.cardTitle}>File Undertime</Text>
            </View>

            {/* Mirrors whatever the backend's eligibility check returns — the
                8th/23rd filing days and the 3-per-month cap are not hardcoded
                here, only reflected from the API. */}
            {undertimeEligibility && (
              <Text style={styles.pendingNoticeText}>
                {undertimeEligibility.filedThisMonth}/{undertimeEligibility.maxFilingsPerMonth} filed this month.{" "}
                {undertimeEligibility.alreadyFiledToday
                  ? "You've already filed undertime today."
                  : !undertimeEligibility.isFilingDay
                    ? `Undertime can only be filed on the ${undertimeEligibility.filingDaysOfMonth.join(" or ")} of the month.`
                    : undertimeEligibility.remaining <= 0
                      ? "You've reached this month's filing limit."
                      : "You're eligible to file undertime today."}
              </Text>
            )}

            <Text style={styles.label}>Reason (optional)</Text>
            <View style={styles.textAreaContainer}>
              <TextInput
                placeholder="Optional note for this filing"
                multiline
                value={undertimeReason}
                onChangeText={setUndertimeReason}
                style={styles.textAreaInput}
              />
            </View>

            <Pressable
              style={[styles.button, (isFilingUndertime || !undertimeEligibility?.eligible) && styles.buttonDisabled]}
              onPress={handleFileUndertime}
              disabled={isFilingUndertime || !undertimeEligibility?.eligible}
            >
              {isFilingUndertime ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.buttonText}>File Undertime for Today</Text>
              )}
            </Pressable>

            <Text style={[styles.cardTitle, { fontSize: 15, marginTop: 20, marginBottom: 8 }]}>This Month's Filings</Text>
            {undertimeFilings.length === 0 ? (
              <Text style={styles.modalEmptyText}>No undertime filings yet.</Text>
            ) : (
              undertimeFilings.map((f) => (
                <View key={f.id} style={styles.requestCard}>
                  <Text style={styles.requestTitle}>{new Date(f.filingDate).toLocaleDateString()}</Text>
                  {f.reason && <Text>{f.reason}</Text>}
                </View>
              ))
            )}
          </View>
        </AestheticScrollView>
      ) : (
        <View style={[styles.tabContentPad, { flex: 1 }]}>
          <View style={styles.card}>
            <View style={styles.formHeader}>
              <Ionicons color="#DC2777" name="document-text-outline" size={28} />
              <Text style={styles.cardTitle}>Leave Request</Text>
            </View>

            {pendingRequests.length > 0 && (
              <Pressable onPress={openPendingModal}>
                <Text style={styles.pendingNoticeText}>
                  You have {pendingRequests.length} leave request{pendingRequests.length === 1 ? "" : "s"} awaiting review (tap to view). You can still file for a different leave type.
                </Text>
              </Pressable>
            )}

            <Text style={styles.label}>Leave Type</Text>
            <View style={styles.dropdownWrapper}>
              <Pressable
                ref={dropdownButtonRef}
                style={[styles.dropdownButton, isDropdownOpen && { borderColor: "#062B59" }]}
                onPress={() => (isDropdownOpen ? setIsDropdownOpen(false) : openLeaveTypeDropdown())}
              >
                <Text style={[styles.dropdownText, !leaveTypeId && { color: "#94A3B8" }]}>
                  {selectedLeaveType?.name || (isLoadingData ? "Loading leave types…" : "Select Leave Type")}
                </Text>
                <Ionicons name={isDropdownOpen ? "chevron-up" : "chevron-down"} size={20} color="#64748B" />
              </Pressable>
            </View>

            <Modal
              visible={isDropdownOpen}
              transparent
              animationType="none"
              onRequestClose={() => setIsDropdownOpen(false)}
            >
              <Pressable style={StyleSheet.absoluteFill} onPress={() => setIsDropdownOpen(false)} />
              <View
                style={[
                  styles.inlineDropdownContainer,
                  { top: dropdownLayout.y, left: dropdownLayout.x, width: dropdownLayout.width },
                ]}
              >
                <View style={styles.searchBarWrapper}>
                  <Ionicons name="search-outline" size={16} color="#94A3B8" style={styles.searchIcon} />
                  <TextInput
                    placeholder="Search leave type..."
                    value={searchLeave}
                    onChangeText={setSearchLeave}
                    style={styles.inlineSearchInput}
                    autoFocus={true}
                  />
                </View>

                <AestheticScrollView style={{ maxHeight: 160 }}>
                  {filteredLeaveTypes.length > 0 ? (
                    filteredLeaveTypes.map((item) => {
                      const exhausted = isLeaveTypeExhausted(item);
                      const alreadyPending = isLeaveTypeAlreadyPending(item);
                      const unavailableToday = !exhausted && !alreadyPending && isLeaveTypeUnavailableToday(item);
                      const disabled = exhausted || alreadyPending || unavailableToday;
                      return (
                        <Pressable
                          key={item.id}
                          style={[styles.inlineItem, disabled && styles.inlineItemDisabled]}
                          disabled={disabled}
                          onPress={() => {
                            setLeaveTypeId(item.id);
                            if (isOneDayLeaveType(item.name, item.isSingleDayOnly)) {
                              setStartDate(todayStart);
                              setEndDate(todayStart);
                              setStartDateSelected(true);
                              setEndDateSelected(true);
                            }
                            setIsDropdownOpen(false);
                            setSearchLeave("");
                          }}
                        >
                          <Text
                            style={[
                              styles.inlineItemText,
                              leaveTypeId === item.id && styles.selectedItemText,
                              disabled && styles.disabledItemText,
                            ]}
                          >
                            {item.name}
                            {item.requiresDocument ? " (document required)" : ""}
                            {exhausted
                              ? item.requiresAdminGrant
                                ? " (apply to HR/Admin first)"
                                : " (no balance left)"
                              : alreadyPending
                                ? " (already pending)"
                                : unavailableToday
                                  ? " (today is a non-working day)"
                                  : ""}
                          </Text>
                        </Pressable>
                      );
                    })
                  ) : (
                    <View style={styles.noResultsBox}>
                      <Text style={styles.noResultsText}>No leave types found</Text>
                    </View>
                  )}
                </AestheticScrollView>
              </View>
            </Modal>

            <Text style={styles.label}>{isSingleDayLeave ? "Date" : "Leave Duration"}</Text>
            {isSingleDayLeave ? (
              <View style={styles.dateRow}>
                <Pressable style={styles.dateBox} onPress={() => setStartPickerVisibility(true)}>
                  <Text style={[styles.dateText, !startDateSelected && { color: "#94A3B8" }]}>
                    {startDateSelected ? formatDate(startDate) : "Select Date"}
                  </Text>
                  <Ionicons name="calendar-outline" size={20} color="#64748B" />
                </Pressable>
              </View>
            ) : (
              <View style={styles.dateRow}>
                <Pressable style={styles.dateBox} onPress={() => setStartPickerVisibility(true)}>
                  <Text style={[styles.dateText, !startDateSelected && { color: "#94A3B8" }]}>
                    {startDateSelected ? formatDate(startDate) : "Start Date"}
                  </Text>
                  <Ionicons name="calendar-outline" size={20} color="#64748B" />
                </Pressable>

                <Pressable style={styles.dateBox} onPress={() => setEndPickerVisibility(true)}>
                  <Text style={[styles.dateText, !endDateSelected && { color: "#94A3B8" }]}>
                    {endDateSelected ? formatDate(endDate) : "End Date"}
                  </Text>
                  <Ionicons name="calendar-outline" size={20} color="#64748B" />
                </Pressable>
              </View>
            )}
            {isSingleDayLeave ? (
              <Text style={styles.totalDaysText}>1 day only</Text>
            ) : startDateSelected && endDateSelected ? (
              <Text style={styles.totalDaysText}>{totalDays} day{totalDays === 1 ? "" : "s"} total</Text>
            ) : null}
            {selectedLeaveType && lockedToToday && isDateNonWorking(todayStart) && (
              <Text style={styles.nonWorkingWarningText}>
                Today is your day off / a non-working day — {selectedLeaveType.name} can't be filed until your next working day.
              </Text>
            )}
            {maxEndDate && !isSingleDayLeave && (
              <Text style={styles.totalDaysText}>
                {remainingDaysFor(selectedLeaveType!)} day{remainingDaysFor(selectedLeaveType!) === 1 ? "" : "s"} available for {selectedLeaveType!.name} — end date can't go past {formatDate(maxEndDate)}
              </Text>
            )}

            <CalendarPickerModal
              visible={isStartPickerVisible}
              title="Select Start Date"
              selectedDate={startDateSelected ? startDate : undefined}
              // A same-day-only type must be picked as exactly today, but a
              // multi-day "can't file in advance" type (e.g. a multi-day
              // sick/emergency leave, if configured that way) is deliberately
              // left open below today — that's the only way to file it after
              // it already happened. Every other type is present/future only.
              minimumDate={lockedToToday ? (isSingleDayLeave ? todayStart : undefined) : todayStart}
              maximumDate={lockedToToday ? todayStart : undefined}
              isDateDisabled={isDateAlreadyFiledForType}
              isDateNonWorking={isDateNonWorking}
              onSelect={handleStartDateConfirm}
              onClose={() => setStartPickerVisibility(false)}
            />

            <CalendarPickerModal
              visible={isEndPickerVisible}
              title="Select End Date"
              selectedDate={endDateSelected ? endDate : undefined}
              minimumDate={startDateSelected ? startDate : todayStart}
              maximumDate={maxEndDate}
              isDateDisabled={isDateAlreadyFiledForType}
              isDateNonWorking={isDateNonWorking}
              onSelect={handleEndDateConfirm}
              onClose={() => setEndPickerVisibility(false)}
            />

            <Text style={styles.label}>
              Supporting Document{selectedLeaveType?.requiresDocument ? " (required)" : " (optional)"}
            </Text>
            {attachment ? (
              <View style={styles.attachmentChip}>
                <Ionicons
                  name={attachment.mimeType.startsWith("image/") ? "image-outline" : "document-outline"}
                  size={18}
                  color="#1680D8"
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.attachmentName} numberOfLines={1}>{attachment.name}</Text>
                  <Text style={styles.attachmentSize}>{formatBytes(attachment.sizeBytes)}</Text>
                </View>
                <Pressable onPress={() => setAttachment(null)} style={styles.attachmentRemove}>
                  <Ionicons name="close" size={16} color="#64748B" />
                </Pressable>
              </View>
            ) : (
              <Pressable style={styles.attachmentPicker} onPress={pickAttachment} disabled={isPickingFile}>
                {isPickingFile ? (
                  <ActivityIndicator size="small" color="#1680D8" />
                ) : (
                  <Ionicons name="attach-outline" size={20} color="#1680D8" />
                )}
                <Text style={styles.attachmentPickerText}>
                  {isPickingFile ? "Opening…" : "Tap to attach a photo or PDF"}
                </Text>
              </Pressable>
            )}
            {attachmentError && <Text style={styles.attachmentErrorText}>{attachmentError}</Text>}

            <Text style={styles.label}>Reason</Text>
            <View style={styles.textAreaContainer}>
              <TextInput
                placeholder="Enter reason"
                multiline
                value={reason}
                onChangeText={setReason}
                style={styles.textAreaInput}
              />
            </View>

            <Pressable style={styles.button} onPress={handleSubmit}>
              <Text style={styles.buttonText}>Submit Leave Request</Text>
            </Pressable>
          </View>
        </View>
      )}

      <Modal visible={showPending} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <BlurView
            intensity={45}
            tint="dark"
            experimentalBlurMethod="dimezisBlurView"
            style={StyleSheet.absoluteFillObject}
          />
          <View style={styles.modalCard}>
            {expandedRequest ? (
              <>
                <Pressable style={styles.backRow} onPress={() => setExpandedRequestId(null)}>
                  <Ionicons name="chevron-back" size={16} color="#1680D8" />
                  <Text style={styles.backText}>All requests</Text>
                </Pressable>
                <Text style={styles.modalTitle}>Leave Request Details</Text>
                <AestheticScrollView style={{ maxHeight: 320 }}>
                  {(() => {
                    const request = expandedRequest;
                    const tone = statusTone(request.status);
                    const canShowCancelSection =
                      request.status === "PENDING" ||
                      request.status === "SUPERVISOR_APPROVED" ||
                      request.status === "APPROVED";
                    // Server-computed (see getCancellationEligibility in
                    // leave.service.ts) — covers the cutoff window and the
                    // leave type's cancellationAllowed flag so the button
                    // here is disabled with a real reason instead of just
                    // failing after the fact.
                    const cancellation = request.cancellation ?? { allowed: true };
                    // Once a supervisor denies a cancellation request, the
                    // leave reverts to plain APPROVED — this note is the
                    // only trace it ever had a cancellation attempt, so it's
                    // what makes that outcome visible here instead of the
                    // request silently looking untouched. Cancel stays
                    // disabled from here on (cancellation.allowed already
                    // reflects this — see getCancellationEligibility).
                    const cancellationDenied =
                      request.status === "APPROVED"
                        ? [...(request.notes ?? [])].reverse().find((n) => n.type === "CANCELLATION_DENIED")
                        : undefined;
                    return (
                      <View style={styles.requestCard}>
                        <Text style={styles.requestTitle}>{request.leaveType.name}</Text>
                        <Text>
                          {new Date(request.startDate).toLocaleDateString()} - {new Date(request.endDate).toLocaleDateString()}
                        </Text>
                        {request.attachmentName && (
                          <View style={styles.requestAttachmentRow}>
                            <Ionicons name="attach-outline" size={13} color="#64748B" />
                            <Text style={styles.requestAttachmentText}>{request.attachmentName}</Text>
                          </View>
                        )}
                        <Text style={[styles.pendingText, { color: tone.color, backgroundColor: tone.bg }]} numberOfLines={1}>
                          {statusLabel(request.status)}
                        </Text>
                        {request.status === "NEEDS_REVISION" && (() => {
                          const requirementNote = [...(request.notes ?? [])].reverse().find((n) => n.type === "REJECTED");
                          return (
                            <View style={styles.resubmitSection}>
                              {requirementNote?.requirementDetails && (
                                <Text style={styles.requirementNoteText}>
                                  Requirement needed: {requirementNote.requirementDetails}
                                </Text>
                              )}

                              {resubmitAttachment ? (
                                <View style={styles.attachmentChip}>
                                  <Ionicons
                                    name={resubmitAttachment.mimeType.startsWith("image/") ? "image-outline" : "document-outline"}
                                    size={18}
                                    color="#1680D8"
                                  />
                                  <View style={{ flex: 1 }}>
                                    <Text style={styles.attachmentName} numberOfLines={1}>{resubmitAttachment.name}</Text>
                                    <Text style={styles.attachmentSize}>{formatBytes(resubmitAttachment.sizeBytes)}</Text>
                                  </View>
                                  <Pressable onPress={() => setResubmitAttachment(null)} style={styles.attachmentRemove}>
                                    <Ionicons name="close" size={16} color="#64748B" />
                                  </Pressable>
                                </View>
                              ) : (
                                <Pressable style={styles.attachmentPicker} onPress={pickResubmitAttachment} disabled={isPickingResubmitFile}>
                                  {isPickingResubmitFile ? (
                                    <ActivityIndicator size="small" color="#1680D8" />
                                  ) : (
                                    <Ionicons name="attach-outline" size={20} color="#1680D8" />
                                  )}
                                  <Text style={styles.attachmentPickerText}>
                                    {isPickingResubmitFile ? "Opening…" : "Tap to attach the requirement"}
                                  </Text>
                                </Pressable>
                              )}
                              {resubmitAttachmentError && <Text style={styles.attachmentErrorText}>{resubmitAttachmentError}</Text>}

                              <View style={styles.textAreaContainer}>
                                <TextInput
                                  placeholder="Optional note to the reviewer"
                                  multiline
                                  value={resubmitNote}
                                  onChangeText={setResubmitNote}
                                  style={styles.textAreaInput}
                                />
                              </View>

                              <Pressable
                                style={styles.button}
                                onPress={() => handleResubmitRequest(request.id)}
                              >
                                <Text style={styles.buttonText}>Resubmit Request</Text>
                              </Pressable>
                            </View>
                          );
                        })()}
                        {cancellationDenied && (
                          <View style={styles.cancellationDeniedNote}>
                            <Text style={styles.cancellationDeniedTitle}>
                              Cancellation denied by your supervisor — this leave remains approved.
                            </Text>
                            {cancellationDenied.message && (
                              <Text style={styles.cancellationDeniedText}>{cancellationDenied.message}</Text>
                            )}
                          </View>
                        )}
                        {canShowCancelSection && (
                          <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: "#E2E8F0" }}>
                            <Pressable
                              style={[styles.cancelLeaveButton, !cancellation.allowed && styles.cancelLeaveButtonDisabled]}
                              onPress={() => { setConfirmCancelId(request.id); setCancelReasonText(""); }}
                              disabled={!cancellation.allowed}
                            >
                              <Ionicons
                                name="close-circle-outline"
                                size={16}
                                color={cancellation.allowed ? "#DC2626" : "#94A3B8"}
                              />
                              <Text style={[styles.cancelLeaveButtonText, !cancellation.allowed && styles.cancelLeaveButtonTextDisabled]}>
                                Cancel Leave
                              </Text>
                            </Pressable>
                            {!cancellation.allowed && cancellation.reason && (
                              <View style={styles.cancelNote}>
                                <Ionicons name="alert-circle-outline" size={14} color="#92400E" />
                                <Text style={styles.cancelNoteText}>{cancellation.reason}</Text>
                              </View>
                            )}
                          </View>
                        )}
                      </View>
                    );
                  })()}
                </AestheticScrollView>
              </>
            ) : (
              <>
                <Text style={styles.modalTitle}>My Leave Requests</Text>

                <SegmentedControl
                  segments={[
                    { key: "current", label: `Current (${currentRequests.length})` },
                    { key: "past", label: `Past (${pastRequests.length})` },
                  ]}
                  value={requestsListTab}
                  onChange={(key) => setRequestsListTab(key as "current" | "past")}
                  style={styles.requestsTabSwitcher}
                />

                <View style={styles.statusFilterRow}>
                  {STATUS_FILTERS.map((filter) => {
                    const active = requestsStatusFilter === filter.key;
                    return (
                      <Pressable
                        key={filter.key}
                        style={[styles.statusFilterChip, active && styles.statusFilterChipActive]}
                        onPress={() => setRequestsStatusFilter(active ? "ALL" : filter.key)}
                      >
                        <Text
                          style={[styles.statusFilterChipText, active && styles.statusFilterChipTextActive]}
                          numberOfLines={1}
                          adjustsFontSizeToFit
                          minimumFontScale={0.8}
                        >
                          {filter.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                <View style={styles.filedDateRow}>
                  <Pressable style={styles.filedDateBox} onPress={() => setRequestsFromPickerVisibility(true)}>
                    <Text
                      style={[styles.filedDateText, !requestsDateFrom && styles.filedDateTextPlaceholder]}
                      numberOfLines={1}
                    >
                      {requestsDateFrom ? formatDate(requestsDateFrom) : "Filed from"}
                    </Text>
                    <Ionicons name="calendar-outline" size={14} color="#64748B" />
                  </Pressable>
                  <Pressable style={styles.filedDateBox} onPress={() => setRequestsToPickerVisibility(true)}>
                    <Text
                      style={[styles.filedDateText, !requestsDateTo && styles.filedDateTextPlaceholder]}
                      numberOfLines={1}
                    >
                      {requestsDateTo ? formatDate(requestsDateTo) : "Filed to"}
                    </Text>
                    <Ionicons name="calendar-outline" size={14} color="#64748B" />
                  </Pressable>
                  {(requestsDateFrom || requestsDateTo) && (
                    <Pressable
                      style={styles.dateFilterClear}
                      onPress={() => {
                        setRequestsDateFrom(null);
                        setRequestsDateTo(null);
                      }}
                    >
                      <Ionicons name="close" size={16} color="#94A3B8" />
                    </Pressable>
                  )}
                </View>

                <AestheticScrollView style={{ maxHeight: 280 }}>
                  {(requestsListTab === "current" ? currentRequests : pastRequests).length === 0 ? (
                    <Text style={styles.modalEmptyText}>
                      {requestsDateFrom || requestsDateTo || requestsStatusFilter !== "ALL"
                        ? "No requests match these filters."
                        : requestsListTab === "current"
                          ? "No ongoing or upcoming filed leave."
                          : "No past leave requests."}
                    </Text>
                  ) : (
                    (requestsListTab === "current" ? currentRequests : pastRequests).map((request) => {
                      const tone = statusTone(request.status);
                      return (
                        <Pressable
                          key={request.id}
                          style={styles.summaryCard}
                          onPress={() => {
                            setExpandedRequestId(request.id);
                            requestsCache.refresh().catch(() => undefined);
                          }}
                        >
                          <View style={styles.summaryTopRow}>
                            <Text style={[styles.requestTitle, { flex: 1 }]} numberOfLines={1}>
                              {request.leaveType.name}
                            </Text>
                            <Text
                              style={[styles.pendingText, { marginTop: 0, fontSize: 10, color: tone.color, backgroundColor: tone.bg }]}
                              numberOfLines={1}
                            >
                              {statusLabel(request.status)}
                            </Text>
                          </View>
                          <Text>
                            {new Date(request.startDate).toLocaleDateString()} - {new Date(request.endDate).toLocaleDateString()}
                          </Text>
                        </Pressable>
                      );
                    })
                  )}
                </AestheticScrollView>
              </>
            )}
            <Pressable
              style={styles.closeButton}
              onPress={() => {
                setShowPending(false);
                setExpandedRequestId(null);
              }}
            >
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <CalendarPickerModal
        visible={isRequestsFromPickerVisible}
        title="Filed From"
        selectedDate={requestsDateFrom ?? undefined}
        maximumDate={requestsDateTo ?? todayStart}
        onSelect={(value) => {
          setRequestsDateFrom(value);
          setRequestsFromPickerVisibility(false);
        }}
        onClose={() => setRequestsFromPickerVisibility(false)}
      />

      <CalendarPickerModal
        visible={isRequestsToPickerVisible}
        title="Filed To"
        selectedDate={requestsDateTo ?? undefined}
        minimumDate={requestsDateFrom ?? undefined}
        maximumDate={todayStart}
        onSelect={(value) => {
          setRequestsDateTo(value);
          setRequestsToPickerVisibility(false);
        }}
        onClose={() => setRequestsToPickerVisibility(false)}
      />

      <Modal visible={!!confirmCancelId} transparent animationType="fade">
        <View style={styles.confirmOverlay}>
          <View style={styles.confirmCard}>
            <Text style={styles.modalTitle}>Cancel this leave request?</Text>
            <Text style={{ color: "#475569", fontSize: 14 }}>
              This action cannot be undone. Your supervisor will need to approve the cancellation.
            </Text>
            <TextInput
              value={cancelReasonText}
              onChangeText={setCancelReasonText}
              placeholder="Why are you cancelling this leave?"
              multiline
              style={styles.cancelReasonInput}
            />
            <View style={styles.confirmActions}>
              <Pressable style={styles.confirmKeepButton} onPress={() => setConfirmCancelId(null)}>
                <Text style={styles.confirmKeepText}>No, Keep It</Text>
              </Pressable>
              <Pressable
                style={[styles.confirmCancelButton, !cancelReasonText.trim() && styles.confirmCancelButtonDisabled]}
                disabled={!cancelReasonText.trim()}
                onPress={() => {
                  if (confirmCancelId) handleCancel(confirmCancelId, cancelReasonText.trim());
                  setConfirmCancelId(null);
                }}
              >
                <Text style={styles.confirmCancelText}>Yes, Cancel</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <ResultModal
        visible={!!resultModal}
        status={resultModal?.status ?? "info"}
        title={resultModal?.title ?? ""}
        message={resultModal?.message ?? ""}
        onClose={() => setResultModal(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#FFFFFF"
  },
  submissionAlertBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    marginHorizontal: 16,
    marginTop: 8,
    backgroundColor: "#FEF2F2",
    borderWidth: 1,
    borderColor: "#FCA5A5",
    borderRadius: 12,
    padding: 12,
  },
  submissionAlertTitle: {
    color: "#B91C1C",
    fontWeight: "700",
    fontSize: 13,
  },
  submissionAlertMessage: {
    color: "#991B1B",
    fontSize: 12,
    marginTop: 2,
  },
  tabSwitcher: {
    marginHorizontal: 16,
    marginTop: 4,
    marginBottom: 4,
  },
  tabContentPad: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: SCREEN_HEIGHT < 700 ? 10 : 16,
  },
  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 18,
    paddingHorizontal: 18,
    paddingTop: SCREEN_HEIGHT < 700 ? 12 : 16,
    paddingBottom: SCREEN_HEIGHT < 700 ? 12 : 16,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    zIndex: 1,
  },
  formHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#062B59",
  },
  label: {
    fontWeight: "600",
    color: "#475569",
    fontSize: 13,
    marginTop: SCREEN_HEIGHT < 700 ? 4 : 8,
    marginBottom: 2,
  },
  pendingNoticeText: {
    color: "#64748B",
    fontSize: 12,
    marginTop: 8,
    marginBottom: 2,
    lineHeight: 16,
  },

  dropdownWrapper: {
    position: "relative",
    zIndex: 10,
  },
  dropdownButton: {
    height: SCREEN_HEIGHT < 700 ? 40 : 46,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 12,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#FFFFFF",
  },
  dropdownText: {
    fontSize: 14
  },
  inlineDropdownContainer: {
    position: "absolute",
    backgroundColor: "#FFFFFF",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    maxHeight: 200,
    zIndex: 50,
    elevation: 5,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.15,
    shadowRadius: 5,
    overflow: "hidden",
  },
  searchBarWrapper: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: "#E2E8F0",
    paddingHorizontal: 10,
    backgroundColor: "#F8FAFC",
    borderTopLeftRadius: 11,
    borderTopRightRadius: 11,
  },
  searchIcon: {
    marginRight: 6,
  },
  inlineSearchInput: {
    flex: 1,
    height: 40,
    fontSize: 14,
    color: "#000000",
  },
  inlineItem: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#F1F5F9",
  },
  inlineItemText: {
    fontSize: 14,
    color: "#334155",
  },
  inlineItemDisabled: {
    backgroundColor: "#F8FAFC",
  },
  disabledItemText: {
    color: "#CBD5E1",
  },
  selectedItemText: {
    color: "#062B59",
    fontWeight: "700",
  },
  noResultsBox: {
    padding: 16,
    alignItems: "center",
  },
  noResultsText: {
    color: "#94A3B8",
    fontSize: 14,
  },

  dateRow: { flexDirection: "row", gap: 10 },
  dateBox: { flex: 1, height: SCREEN_HEIGHT < 700 ? 40 : 46, borderWidth: 1, borderColor: "#E2E8F0", borderRadius: 12, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: "#FFFFFF" },
  dateText: { fontSize: 14 },
  totalDaysText: {
    marginTop: 4,
    fontSize: 11.5,
    fontWeight: "600",
    color: "#1680D8",
  },
  nonWorkingWarningText: {
    marginTop: 4,
    fontSize: 11.5,
    fontWeight: "600",
    color: "#B45309",
  },

  attachmentPicker: {
    height: SCREEN_HEIGHT < 700 ? 40 : 46,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: "#BFDBFE",
    borderRadius: 12,
    backgroundColor: "#F8FAFF",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  attachmentPickerText: {
    color: "#1680D8",
    fontSize: 13,
    fontWeight: "600",
  },
  attachmentChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    height: 46,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 12,
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 12,
  },
  attachmentName: {
    fontSize: 13,
    fontWeight: "600",
    color: "#062B59",
  },
  attachmentSize: {
    fontSize: 11,
    color: "#94A3B8",
    marginTop: 1,
  },
  attachmentRemove: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: "#F1F5F9",
    alignItems: "center",
    justifyContent: "center",
  },
  attachmentErrorText: {
    marginTop: 6,
    fontSize: 12,
    color: "#DC2626",
    fontWeight: "600",
  },

  textAreaContainer: {
    height: SCREEN_HEIGHT < 700 ? 56 : 72,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 12,
    backgroundColor: "#FFFFFF",
    overflow: "hidden",
    marginVertical: 4,
  },
  textAreaInput: {
    flex: 1,
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 8,
    textAlignVertical: "top",
  },
  button: {
    height: SCREEN_HEIGHT < 700 ? 42 : 48,
    borderRadius: 14,
    backgroundColor: "#062B59",
    justifyContent: "center",
    alignItems: "center",
    marginTop: SCREEN_HEIGHT < 700 ? 8 : 12,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: {
    color: "#FFFFFF",
    fontWeight: "700"
  },
  // No dimmed backdrop — just the floating card. The shadow/border below is
  // what gives it definition against the page instead of a dim overlay.
  modalOverlay: { flex: 1, backgroundColor: "transparent", justifyContent: "center", alignItems: "center" },
  modalCard: {
    width: "88%", maxHeight: "80%", backgroundColor: "#FFFFFF", borderRadius: 18, padding: 20,
    borderWidth: 1, borderColor: "#E2E8F0",
    shadowColor: "#062B59", shadowOpacity: 0.18, shadowRadius: 24, shadowOffset: { width: 0, height: 12 }, elevation: 12,
  },
  backRow: { flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 10 },
  backText: { color: "#1680D8", fontWeight: "700", fontSize: 13 },
  summaryCard: { backgroundColor: "#F8FAFC", borderRadius: 12, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: "#E2E8F0" },
  summaryTopRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  confirmOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "center", alignItems: "center" },
  confirmCard: { width: "80%", backgroundColor: "#FFFFFF", borderRadius: 18, padding: 20 },
  confirmActions: { flexDirection: "row", gap: 10, marginTop: 18 },
  confirmKeepButton: { flex: 1, backgroundColor: "#F1F5F9", borderRadius: 12, padding: 12 },
  confirmKeepText: { color: "#334155", textAlign: "center", fontWeight: "700" },
  confirmCancelButton: { flex: 1, backgroundColor: "#DC2626", borderRadius: 12, padding: 12 },
  confirmCancelButtonDisabled: { backgroundColor: "#FCA5A5" },
  confirmCancelText: { color: "#FFFFFF", textAlign: "center", fontWeight: "700" },
  cancelReasonInput: {
    borderWidth: 1, borderColor: "#E2E8F0", borderRadius: 10,
    padding: 10, fontSize: 13, minHeight: 70, textAlignVertical: "top",
    marginTop: 12, color: "#0F172A",
  },
  modalTitle: { fontSize: 18, fontWeight: "700", marginBottom: 16, color: "#062B59" },
  modalEmptyText: { color: "#94A3B8", fontSize: 13, textAlign: "center", paddingVertical: 12 },
  requestsTabSwitcher: {
    marginBottom: 10,
  },
  statusFilterRow: { flexDirection: "row", gap: 5, marginBottom: 10 },
  filedDateRow: { flexDirection: "row", gap: 8, marginBottom: 12 },
  filedDateBox: {
    flex: 1,
    height: 40,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 10,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#FFFFFF",
  },
  filedDateText: { fontSize: 12.5, fontWeight: "600", color: "#0F172A" },
  filedDateTextPlaceholder: { color: "#94A3B8", fontWeight: "500" },
  // flex: 1 each — same mechanism as SegmentedControl's own buttons — so all
  // four always sit on one line regardless of screen width, and the same
  // navy-active/grey-inactive colors as every other pill on this screen
  // (Balance/Request/Undertime, Current/Past) instead of a third color.
  statusFilterChip: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 7,
    paddingHorizontal: 4,
    borderRadius: 999,
    backgroundColor: "#F1F5F9",
  },
  statusFilterChipActive: { backgroundColor: "#062B59" },
  statusFilterChipText: { color: "#64748B", fontSize: 10.5, fontWeight: "700" },
  statusFilterChipTextActive: { color: "#FFFFFF" },
  dateFilterClear: {
    alignItems: "center",
    justifyContent: "center",
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#F1F5F9",
  },
  requestCard: { backgroundColor: "#F8FAFC", borderRadius: 12, padding: 14, marginBottom: 12 },
  requestTitle: { fontWeight: "700", marginBottom: 4, flexShrink: 1 },
  requestAttachmentRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  requestAttachmentText: { fontSize: 12, color: "#64748B" },
  pendingText: { fontWeight: "700", marginTop: 8, alignSelf: "flex-start", fontSize: 11, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, overflow: "hidden" },
  cancelLeaveButton: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7,
    borderWidth: 1, borderColor: "#FCA5A5", backgroundColor: "#FEF2F2",
    borderRadius: 10, paddingVertical: 10,
  },
  cancelLeaveButtonDisabled: { borderColor: "#E2E8F0", backgroundColor: "#F8FAFC" },
  cancelLeaveButtonText: { color: "#DC2626", fontWeight: "700", fontSize: 13 },
  cancelLeaveButtonTextDisabled: { color: "#94A3B8" },
  cancelNote: {
    flexDirection: "row", alignItems: "flex-start", gap: 6, marginTop: 8,
    backgroundColor: "#FFFBEB", borderWidth: 1, borderColor: "#FEF3C7", borderRadius: 8, padding: 9,
  },
  cancelNoteText: { flex: 1, color: "#92400E", fontSize: 11.5, lineHeight: 16 },
  resubmitSection: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: "#E2E8F0",
    gap: 8,
  },
  requirementNoteText: {
    fontSize: 12.5,
    fontWeight: "700",
    color: "#92400E",
    backgroundColor: "#FEF3C7",
    borderRadius: 8,
    padding: 9,
  },
  cancellationDeniedNote: {
    marginTop: 8,
    backgroundColor: "#FEF2F2",
    borderWidth: 1,
    borderColor: "#FCA5A5",
    borderRadius: 8,
    padding: 9,
  },
  cancellationDeniedTitle: { color: "#B91C1C", fontSize: 12, fontWeight: "700" },
  cancellationDeniedText: { color: "#B91C1C", fontSize: 12, marginTop: 3 },
  closeButton: { backgroundColor: "#062B59", borderRadius: 12, padding: 12, marginTop: 12 },
  closeText: { color: "#FFFFFF", textAlign: "center", fontWeight: "700" },
});
