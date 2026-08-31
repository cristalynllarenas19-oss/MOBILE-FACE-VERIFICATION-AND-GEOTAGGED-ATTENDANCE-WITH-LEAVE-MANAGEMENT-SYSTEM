

import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle, ChevronDown, ChevronLeft, ChevronUp, FileText, Paperclip, Search, X, XCircle } from "lucide-react";
import "./EmployeePortal.css";
import {
  LeaveType, LeaveBalance, LeaveRequest, UndertimeEligibility, UndertimeFiling, MySchedule,
  getLeaveTypes, getLeaveBalances, getLeaveRequests, createLeaveRequest, cancelLeaveRequest, resubmitLeaveRequest,
  getUndertimeEligibility, getUndertimeFilings, fileUndertime, getMySchedules,
} from "./api";
import { LeaveBalanceChart } from "./components/LeaveBalanceChart";
import { CalendarPicker } from "./components/CalendarPicker";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { LeaveTimeline } from "../../components/ui/LeaveTimeline";
import type { AuthUser } from "../../lib/api";
import { CACHE_KEYS, useCachedData } from "../../lib/dataCache";

type Props = {
  user: AuthUser;
  initialFocusRequestId?: string;
  onFocusRequestHandled?: () => void;
};
type Tab   = "balance" | "request" | "undertime";

const MAX_BYTES = 5 * 1024 * 1024;

type RequestStatusFilter = "ALL" | "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";

// Same neutral pill style as every other filter chip here (Filed From/To
// below) — a permanent per-status color made the row read as decoration
// rather than a set of toggles (mirrors employee-mobile's LeaveScreen.tsx).
const STATUS_FILTERS: { key: Exclude<RequestStatusFilter, "ALL">; label: string }[] = [
  { key: "PENDING", label: "Pending" },
  { key: "APPROVED", label: "Approved" },
  { key: "REJECTED", label: "Rejected" },
  { key: "CANCELLED", label: "Cancelled" },
];

// Buckets a request's raw status into one of the four filter chips — same
// grouping as statusTone below (mirrors employee-mobile's LeaveScreen.tsx).
function statusFilterBucket(status: string): Exclude<RequestStatusFilter, "ALL"> | null {
  if (status === "APPROVED" || status === "SUPERVISOR_APPROVED") return "APPROVED";
  if (status === "REJECTED") return "REJECTED";
  if (status === "CANCELLED") return "CANCELLED";
  if (status === "PENDING" || status === "NEEDS_REVISION" || status === "CANCELLATION_PENDING") return "PENDING";
  return null;
}

function statusTone(s: string) {
  if (s === "APPROVED" || s === "SUPERVISOR_APPROVED") return { color: "#15803D", bg: "#DCFCE7" };
  if (s === "REJECTED") return { color: "#B91C1C", bg: "#FEE2E2" };
  // Darker red than REJECTED, not a different color family — still reads as
  // "not approved" but distinct in shade from an outright rejection.
  if (s === "CANCELLED") return { color: "#7F1D1D", bg: "#FEE2E2" };
  // Same amber pill as plain Pending, but red text — this is the one that
  // needs the employee to act (resubmit), so it should still stand out from
  // a plain "awaiting someone else" Pending. Matches the My Leave Balance
  // card's pending pill (components/LeaveBalanceChart.tsx).
  if (s === "NEEDS_REVISION") return { color: "#EF4444", bg: "#FEF3C7" };
  return { color: "#B45309", bg: "#FEF3C7" };
}

// SUPERVISOR_APPROVED only exists on legacy rows from the old two-step
// approval flow — approval is single-step now, so it reads as plain
// "Approved" here, same as admin-web's Leave Management page and the mobile
// app (keeps the label consistent across every surface that shows it).
function statusLabel(s: string) {
  if (s === "SUPERVISOR_APPROVED") return "APPROVED";
  // Reads clearer as "PENDING CANCELLATION" than a plain underscore swap
  // ("CANCELLATION PENDING") — same wording used on the mobile app and the
  // supervisor's review screen so an employee and their supervisor always
  // see the same status for this request.
  if (s === "CANCELLATION_PENDING") return "PENDING CANCELLATION";
  return s.replace(/_/g, " ");
}

function fmtBytes(b: number) {
  if (b < 1024)         return `${b} B`;
  if (b < 1024 * 1024)  return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function attachmentSrc(mimeType: string | null | undefined, data: string | null | undefined) {
  if (!mimeType || !data) return null;
  return `data:${mimeType};base64,${data}`;
}

export function LeavePage({ user, initialFocusRequestId, onFocusRequestHandled }: Props) {
  const [tab,          setTab]          = useState<Tab>("balance");

  // Stale-while-revalidate — same cache keys App.tsx prefetches after
  // sign-in, so this page (and admin-web's own Leave Management page, for
  // leaveTypes) renders instantly from cache while a fresh copy loads
  // silently in the background.
  const leaveTypesCache = useCachedData<LeaveType[]>(CACHE_KEYS.leaveTypes, getLeaveTypes);
  const balancesCache = useCachedData<LeaveBalance[]>(
    user.employeeId ? CACHE_KEYS.leaveBalances(user.employeeId) : null,
    () => getLeaveBalances(user.employeeId!),
  );
  const requestsCache = useCachedData<LeaveRequest[]>(
    user.employeeId ? CACHE_KEYS.leaveRequests(user.employeeId) : null,
    () => getLeaveRequests(user.employeeId!),
  );
  const undertimeEligibilityCache = useCachedData<UndertimeEligibility>(
    user.employeeId ? CACHE_KEYS.undertimeEligibility(user.employeeId) : null,
    () => getUndertimeEligibility(user.employeeId!),
  );
  const undertimeFilingsCache = useCachedData<UndertimeFiling[]>(
    user.employeeId ? CACHE_KEYS.undertimeFilings(user.employeeId) : null,
    () => getUndertimeFilings(user.employeeId!),
  );
  // Own schedule assignment(s) — drives the calendar's day-off/non-working
  // classification below (see isDateNonWorking).
  const mySchedulesCache = useCachedData<MySchedule[]>(
    user.employeeId ? CACHE_KEYS.mySchedules(user.employeeId) : null,
    () => getMySchedules(),
  );
  const leaveTypes = leaveTypesCache.data ?? [];
  const balances = balancesCache.data ?? [];
  const requests = requestsCache.data ?? [];
  const undertimeEligibility = undertimeEligibilityCache.data;
  const undertimeFilings = undertimeFilingsCache.data ?? [];
  const mySchedules = mySchedulesCache.data ?? [];
  const loadingData = leaveTypesCache.isLoading || balancesCache.isLoading || requestsCache.isLoading;

  async function refreshAll() {
    await Promise.all([
      leaveTypesCache.refresh(),
      balancesCache.refresh(),
      requestsCache.refresh(),
      undertimeEligibilityCache.refresh(),
      undertimeFilingsCache.refresh(),
    ]);
  }

  // There's no push/WebSocket infra in this app — a supervisor's approve/
  // reject only lands here on the next fetch. Polling this often while the
  // page is mounted is the pragmatic way to make that feel near-instant
  // without adding real-time transport.
  const refreshAllRef = useRef(refreshAll);
  refreshAllRef.current = refreshAll;
  useEffect(() => {
    const interval = setInterval(() => { refreshAllRef.current().catch(() => undefined); }, 3000);
    // Browsers throttle setInterval in a background tab, so a status change
    // that landed while this tab wasn't focused could sit unnoticed well
    // past the poll interval — catch up the moment the tab is looked at
    // again instead of waiting out whatever's left of a throttled timer.
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshAllRef.current().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  // Request form
  const [leaveTypeId,   setLeaveTypeId]   = useState("");
  const [searchLeave,   setSearchLeave]   = useState("");
  const [dropOpen,      setDropOpen]      = useState(false);
  const [startDate,     setStartDate]     = useState("");
  const [endDate,       setEndDate]       = useState("");
  const [reason,        setReason]        = useState("");
  const [attachment,    setAttachment]    = useState<{
    name: string; mimeType: string; sizeBytes: number; base64: string;
  } | null>(null);
  const [attachErr,     setAttachErr]     = useState<string | null>(null);
  const [extensionRequested, setExtensionRequested] = useState(false);

  // Modals
  const [showPending,  setShowPending]   = useState(false);
  // "My Leave Requests" modal — Current (anything still awaiting a decision,
  // or approved and not yet finished) vs Past (cancelled, rejected, or an
  // approved leave whose dates are already over). Defaults to Current since
  // that's what an employee opens this for most of the time — including
  // right after requesting a cancellation, so that request stays visible
  // instead of appearing to vanish.
  const [requestsListTab, setRequestsListTab] = useState<"current" | "past">("current");
  // Filed-date range — two calendars (from/to), same pattern as the Start
  // Date/End Date pickers on the Request tab above.
  const [requestsDateFrom, setRequestsDateFrom] = useState("");
  const [requestsDateTo, setRequestsDateTo] = useState("");
  const [requestsStatusFilter, setRequestsStatusFilter] = useState<RequestStatusFilter>("ALL");
  // Opening the requests list is exactly when a stale status is most
  // visible and most annoying — force a fresh fetch right away instead of
  // waiting for the next poll tick. Only `requests` is shown in this modal,
  // so only that cache needs refetching here.
  function openPendingModal() {
    setShowPending(true);
    setRequestsListTab("current");
    setRequestsDateFrom("");
    setRequestsDateTo("");
    requestsCache.refresh().catch(() => undefined);
  }
  const [resultModal,  setResultModal]   = useState<{ ok: boolean; title: string; msg: string } | null>(null);
  // Sticks around (independent of resultModal, which the user may have
  // already dismissed by the time a background submission actually fails)
  // until explicitly closed, and shows on every tab so a failed leave
  // request filed optimistically is never silently missed.
  const [submissionAlert, setSubmissionAlert] = useState<{ title: string; msg: string } | null>(null);
  const [focusedRequestId, setFocusedRequestId] = useState<string | null>(null);
  // Cancel is a destructive, irreversible action — clicking Cancel opens this
  // confirm step instead of cancelling immediately. The backend requires a
  // reason (see leave.service.ts's cancel()), so it's collected right here.
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);
  const [cancelReasonText, setCancelReasonText] = useState("");

  // Inline "attach requirement & resubmit" — shown unconditionally on a
  // NEEDS_REVISION request's detail view (mirrors employee-mobile's
  // LeaveScreen.tsx, which never gates this behind a separate toggle).
  const [resubmitNote,    setResubmitNote]    = useState("");
  const [resubmitFile,    setResubmitFile]    = useState<{ name: string; mimeType: string; sizeBytes: number; base64: string } | null>(null);
  const [resubmitErr,     setResubmitErr]     = useState<string | null>(null);
  const [isResubmitting,  setIsResubmitting]  = useState(false);

  // Lets the employee view a submitted attachment (their own initial upload
  // or a resubmitted requirement) full-size instead of only seeing its file name.
  const [previewAttachment, setPreviewAttachment] = useState<{ src: string; name: string; mimeType: string } | null>(null);

  // Undertime filing
  const [undertimeReason,      setUndertimeReason]      = useState("");
  const [isFilingUndertime,    setIsFilingUndertime]    = useState(false);
  const [undertimeErr,         setUndertimeErr]         = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);

  const selectedType    = leaveTypes.find((t) => t.id === leaveTypeId);
  const filteredTypes   = leaveTypes
    .filter((t) => t.isActive)
    .filter((t) => !t.requiresEhsActivation || t.ehsActivated)
    .filter((t) => t.name.toLowerCase().includes(searchLeave.toLowerCase()));
  const pendingRequests = useMemo(
    () => requests.filter((r) => r.status === "PENDING" || r.status === "SUPERVISOR_APPROVED" || r.status === "NEEDS_REVISION"),
    [requests],
  );
  // Of pendingRequests, how many specifically need the employee to act
  // (resubmit) rather than just wait on someone else's decision — drives the
  // "My Leave Balance" card's pending pill so it reads "Needs Revision"
  // instead of a generic "Pending" when that's what's actually happening.
  // Kept in lockstep with employee-mobile's LeaveScreen.tsx.
  const needsRevisionCount = useMemo(
    () => requests.filter((r) => r.status === "NEEDS_REVISION").length,
    [requests],
  );
  // A request is "current" if it's still awaiting a decision (including a
  // pending self-cancellation — CANCELLATION_PENDING — so requesting a
  // cancellation never makes the request appear to vanish from this list) or
  // it's APPROVED and its leave period hasn't finished yet. Everything else
  // (CANCELLED, REJECTED, or an APPROVED leave whose dates are already over)
  // is "past". Together these two are every request the employee has ever
  // filed — the split is purely by date/finality, not a separate filter.
  function isCurrentLeaveRequest(r: LeaveRequest, todayStart: Date) {
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

  function dateKey(value: string) {
    const d = new Date(value);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function matchesStatusFilter(r: LeaveRequest) {
    if (requestsStatusFilter === "ALL") return true;
    return statusFilterBucket(r.status) === requestsStatusFilter;
  }

  // dateKey and the from/to values are both "YYYY-MM-DD", so plain string
  // comparison sorts the same as chronological order.
  function matchesDateFilter(r: LeaveRequest) {
    const filed = dateKey(r.createdAt);
    if (requestsDateFrom && filed < requestsDateFrom) return false;
    if (requestsDateTo && filed > requestsDateTo) return false;
    return true;
  }

  const currentRequests = useMemo(() => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    return requests
      .filter((r) => isCurrentLeaveRequest(r, todayStart))
      .filter(matchesDateFilter)
      .filter(matchesStatusFilter)
      .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
  }, [requests, requestsDateFrom, requestsDateTo, requestsStatusFilter]);

  // History — everything not currently active, most-recently-filed first
  // (mirrors admin-web's own Leave History tab).
  const pastRequests = useMemo(() => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    return requests
      .filter((r) => !isCurrentLeaveRequest(r, todayStart))
      .filter(matchesDateFilter)
      .filter(matchesStatusFilter)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [requests, requestsDateFrom, requestsDateTo, requestsStatusFilter]);
  const focusedRequest = useMemo(
    () => requests.find((r) => r.id === focusedRequestId),
    [requests, focusedRequestId],
  );

  const remainingByLeaveType = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of balances) map.set(b.leaveTypeId, b.remainingDays);
    return map;
  }, [balances]);

  function remainingDaysFor(t: LeaveType) {
    const remaining = remainingByLeaveType.get(t.id);
    if (remaining !== undefined) return remaining;
    return t.requiresAdminGrant ? 0 : Number(t.defaultDays);
  }

  function isLeaveTypeExhausted(t: LeaveType) {
    if (t.allowWithoutPay || t.isUnlimitedDays) return false;
    return remainingDaysFor(t) <= 0;
  }

  // Mirrors the backend's same-type check (leave.service.ts) — a leave type
  // with an active request can't be selected again until that one is
  // resolved, but other types remain requestable.
  function isLeaveTypeAlreadyPending(t: LeaveType) {
    return pendingRequests.some((r) => r.leaveType.id === t.id);
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

  // "Request" button on a balance row: jump to the Request tab with that
  // leave type already selected, unless it can't be requested — same rules
  // as the disabled dropdown entries in the Request form (mirrors mobile's
  // LeaveScreen.handleRequestFromBalance).
  function handleRequestFromBalance(id: string) {
    const type = leaveTypes.find((t) => t.id === id);
    if (!type || !type.isActive) return;
    if (isLeaveTypeExhausted(type)) {
      setResultModal({
        ok: false,
        title: type.requiresAdminGrant ? "Not Yet Granted" : "No Balance Left",
        msg: type.requiresAdminGrant
          ? `${type.name} must be granted by HR/Admin before you can request it. Please apply to HR/Admin first.`
          : `You have no remaining ${type.name} days to request.`,
      });
      return;
    }
    if (isLeaveTypeUnavailableToday(type)) {
      setResultModal({
        ok: false,
        title: "Non-Working Day",
        msg: `${type.name} can only be filed for today's date, but today is your day off / a non-working day.`,
      });
      return;
    }
    setLeaveTypeId(id);
    setTab("request");
  }

  async function handleFileUndertime() {
    if (!user.employeeId) return;
    setIsFilingUndertime(true);
    setUndertimeErr(null);
    try {
      await fileUndertime(user.employeeId, undertimeReason.trim() || undefined);
      setUndertimeReason("");
      await refreshAll();
      setResultModal({ ok: true, title: "Undertime Filed", msg: "Your undertime filing for today has been recorded." });
    } catch (err) {
      setUndertimeErr(err instanceof Error ? err.message : "Unable to file undertime.");
    } finally { setIsFilingUndertime(false); }
  }

  const focusRefreshAttempted = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!initialFocusRequestId || loadingData) return;
    const request = requests.find((r) => r.id === initialFocusRequestId);
    setTab("request");
    if (request) {
      setFocusedRequestId(request.id);
      onFocusRequestHandled?.();
      return;
    }
    // The request may be too new for whatever's currently cached (e.g. a
    // just-filed/just-cancelled leave that triggered this very
    // notification) — force one immediate refetch instead of jumping
    // straight to "not found", then give up only if it's still missing.
    if (focusRefreshAttempted.current !== initialFocusRequestId) {
      focusRefreshAttempted.current = initialFocusRequestId;
      requestsCache.refresh().catch(() => undefined);
      return;
    }
    setResultModal({
      ok: false,
      title: "Leave Request Not Found",
      msg: "This notification is linked to a leave request that could not be loaded.",
    });
    onFocusRequestHandled?.();
  }, [initialFocusRequestId, loadingData, requests, onFocusRequestHandled]);

  // Optimistic — the frontend already knows the outcome (mirrors
  // leave.service.ts's cancel(): an APPROVED request can't cancel outright,
  // it drops to CANCELLATION_PENDING until a Supervisor/Admin decides;
  // anything else not yet committed goes straight to CANCELLED) — so the
  // confirmation modal closes and the new status shows immediately instead
  // of the employee waiting on the round trip, and the request to the
  // supervisor goes out in the background. Only `requests` actually changes
  // here (balance is untouched either way — see cancel()'s comments), so
  // this refreshes just that cache instead of refetching everything.
  //
  // Deliberately does NOT close the request detail (focusedRequestId) — the
  // employee stays right where they were and sees the request's own status
  // flip to "Pending Cancellation"/"Cancelled" in place, instead of being
  // bounced back out to the list.
  function handleCancel(requestId: string, note: string) {
    const target = requests.find((r) => r.id === requestId);
    if (!target) return;
    const newStatus = target.status === "APPROVED" ? "CANCELLATION_PENDING" : "CANCELLED";

    requestsCache.setData(requests.map((r) => (r.id === requestId ? { ...r, status: newStatus } : r)));
    setResultModal({
      ok: true,
      title: newStatus === "CANCELLATION_PENDING" ? "Cancellation Requested" : "Leave Request Cancelled",
      msg:
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
          ok: false,
          title: "Cancellation Failed",
          msg: err instanceof Error ? err.message : "Unable to cancel this leave request.",
        });
      });
  }

  // Clears the resubmit form whenever a different request's detail view is
  // opened, so switching between requests never leaks one's draft
  // attachment/note into another's inline section below.
  useEffect(() => {
    setResubmitNote("");
    setResubmitFile(null);
    setResubmitErr(null);
  }, [focusedRequestId]);

  function handleResubmitFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setResubmitErr(null);
    if (file.size > MAX_BYTES) { setResubmitErr("File too large — maximum 5 MB."); return; }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const full   = ev.target?.result as string;
      const base64 = full.split(",")[1];
      setResubmitFile({ name: file.name, mimeType: file.type || "application/octet-stream", sizeBytes: file.size, base64 });
    };
    reader.readAsDataURL(file);
  }

  async function handleResubmit(requestId: string) {
    if (!resubmitFile) { setResubmitErr("Please attach the requested requirement before resubmitting."); return; }
    setIsResubmitting(true);
    try {
      await resubmitLeaveRequest(requestId, {
        note: resubmitNote.trim() || undefined,
        attachmentName: resubmitFile.name,
        attachmentMimeType: resubmitFile.mimeType,
        attachmentData: resubmitFile.base64,
      });
      // Only `requests` actually changed (status PENDING again) — the other
      // four caches (leave types, balances, undertime) are untouched by a
      // resubmit, so refetching them here would just be wasted round trips.
      await requestsCache.refresh();
    } catch (err) {
      setResubmitErr(err instanceof Error ? err.message : "Failed to resubmit leave request.");
    } finally { setIsResubmitting(false); }
  }

  const totalDays = useMemo(() => {
    if (!startDate || !endDate) return 0;
    return Math.max(1, Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86_400_000) + 1);
  }, [startDate, endDate]);

  // The date range a request can span cannot exceed the leave type's
  // remaining allotment (e.g. Vacation Leave with 15 days left caps the end
  // date 15 days after the start date) — unlimited/without-pay types are
  // exempt, same as the balance check in handleSubmit below.
  const maxEndDate = useMemo(() => {
    if (!selectedType || !startDate) return undefined;
    if (selectedType.allowWithoutPay || selectedType.isUnlimitedDays) return undefined;
    const remaining = remainingDaysFor(selectedType);
    const max = new Date(startDate);
    max.setDate(max.getDate() + Math.max(0, remaining - 1));
    return max.toISOString().slice(0, 10);
  }, [selectedType, startDate, remainingByLeaveType]);

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
  // the backend uses. Mirrors employee-mobile's LeaveScreen.tsx.
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

  const todayStart = useMemo(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }, []);

  // A !advanceFilingAllowed type (Sick Leave, Emergency Leave, Adverse
  // Weather Leave) can only ever be filed for today — so if today happens to
  // be this employee's day off, the type is entirely unfilable right now,
  // not just on some dates. Surfaced up front (dropdown + Date section)
  // instead of only failing at submit time.
  function isLeaveTypeUnavailableToday(t: LeaveType) {
    return t.advanceFilingAllowed === false && Boolean(isDateNonWorking(todayStart));
  }

  // Leave types with advanceFilingAllowed === false (Sick Leave) cannot be
  // filed for a future date — driven by the selected type's own config so
  // this isn't a rule baked into the frontend, it just mirrors whatever HR
  // set on the Leave Types admin page. The backend enforces this
  // independently in leave.service.ts; this only improves the picking UX.
  const maxStartDate = useMemo(() => {
    if (selectedType?.advanceFilingAllowed === false) return new Date().toISOString().slice(0, 10);
    return undefined;
  }, [selectedType]);
  // Same-day types (Sick/Emergency/Adverse Weather Leave) pin the start date
  // to exactly today — min and max both equal today, so it can't be backfiled
  // to a past date either. A multi-day !advanceFilingAllowed type only gets
  // the max (today-or-earlier is fine for those, so it can still be filed
  // after the fact). Every other type is present/future only — no past dates.
  const minStartDate = useMemo(() => {
    if (selectedType?.advanceFilingAllowed === false) {
      return selectedType.isSingleDayOnly ? maxStartDate : undefined;
    }
    return new Date().toISOString().slice(0, 10);
  }, [selectedType, maxStartDate]);

  // Single-day-only types (Sick Leave, Emergency Leave) always mirror the end
  // date to the start date the moment either one is known.
  useEffect(() => {
    if (selectedType?.isSingleDayOnly && startDate) setEndDate(startDate);
  }, [selectedType?.isSingleDayOnly, startDate]);

  // Clamp a previously-picked end date if switching leave type (or the
  // remaining balance) shrinks the allowed range below it.
  useEffect(() => {
    if (!maxEndDate || !endDate) return;
    if (endDate > maxEndDate) setEndDate(maxEndDate);
  }, [maxEndDate]);

  const isDocumentRequired =
    Boolean(selectedType?.requiresDocument) &&
    (selectedType?.supportingDocumentAfterDays == null || totalDays >= selectedType.supportingDocumentAfterDays);

  function resetForm() {
    setLeaveTypeId("");
    setReason("");
    setStartDate("");
    setEndDate("");
    setAttachment(null);
    setAttachErr(null);
    setExtensionRequested(false);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // reset so the same file can be re-selected
    if (!file) return;
    setAttachErr(null);
    if (file.size > MAX_BYTES) { setAttachErr("File too large — maximum 5 MB."); return; }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const full   = ev.target?.result as string;
      const base64 = full.split(",")[1];
      setAttachment({ name: file.name, mimeType: file.type || "application/octet-stream", sizeBytes: file.size, base64 });
    };
    reader.readAsDataURL(file);
  }

  async function handleSubmit() {
    if (!user.employeeId) {
      setResultModal({ ok: false, title: "Missing Profile", msg: "Your account is not linked to an employee record." });
      return;
    }
    if (!leaveTypeId) {
      setResultModal({ ok: false, title: "Select Leave Type", msg: "Please choose a leave type before submitting." });
      return;
    }
    if (!startDate || !endDate) {
      setResultModal({ ok: false, title: "Select Dates", msg: "Please choose both a start and end date." });
      return;
    }
    if (!reason.trim()) {
      setResultModal({ ok: false, title: "Reason Required", msg: "Please provide a reason for your leave." });
      return;
    }
    // Mirrors the backend's own-day-off check (leave.service.ts) — catches
    // dates set outside the calendar's disabled-day styling.
    const requestedStartDate = new Date(startDate);
    const requestedEndDate = new Date(endDate);
    const nonWorkingBoundary = isDateNonWorking(requestedStartDate)
      ? requestedStartDate
      : isDateNonWorking(requestedEndDate)
        ? requestedEndDate
        : null;
    if (nonWorkingBoundary) {
      setResultModal({
        ok: false,
        title: "Non-Working Day",
        msg: `${nonWorkingBoundary.toLocaleDateString()} is your day off / a non-working day. Leave can only be filed for a working day.`,
      });
      return;
    }
    // Mirrors the backend's check (leave.service.ts) so the error shows up
    // immediately instead of after a round trip — same type is blocked
    // regardless of dates, a different type is always fine.
    const pendingOfSameType = pendingRequests.find((r) => r.leaveType.id === leaveTypeId);
    if (pendingOfSameType) {
      setResultModal({
        ok: false,
        title: "Already Pending",
        msg: `You already have a ${selectedType?.name} request awaiting review. Please wait until it is approved, rejected, or cancelled before filing another for this leave type.`,
      });
      return;
    }
    // Any date already covered by an APPROVED request of this *same* leave
    // type is off-limits until that request is cancelled. Mirrors the
    // backend's check in leave.service.ts.
    const requestedStart = new Date(startDate);
    const requestedEnd = new Date(endDate);
    const overlappingApproved = requests.find(
      (r) =>
        r.leaveType.id === leaveTypeId &&
        r.status === "APPROVED" &&
        new Date(r.startDate) <= requestedEnd &&
        new Date(r.endDate) >= requestedStart,
    );
    if (overlappingApproved) {
      setResultModal({
        ok: false,
        title: "Dates Unavailable",
        msg: `These dates overlap your approved ${selectedType?.name} (${new Date(overlappingApproved.startDate).toLocaleDateString()} - ${new Date(overlappingApproved.endDate).toLocaleDateString()}). Cancel that request first if you need to change it.`,
      });
      return;
    }
    if (isDocumentRequired && !attachment) {
      setResultModal({ ok: false, title: "Document Required", msg: `${selectedType?.name} requires a supporting document. Please attach one before submitting.` });
      return;
    }
    if (selectedType && !selectedType.allowWithoutPay && !selectedType.isUnlimitedDays) {
      const remainingDays = remainingDaysFor(selectedType);
      if (selectedType.requiresAdminGrant && remainingDays <= 0) {
        setResultModal({ ok: false, title: "Not Yet Granted", msg: `${selectedType.name} must be granted by HR/Admin before you can request it. Please apply to HR/Admin first.` });
        return;
      }
      if (remainingDays <= 0) {
        setResultModal({ ok: false, title: "No Remaining Balance", msg: "You have no remaining balance for this leave type." });
        return;
      }
      if (totalDays > remainingDays) {
        setResultModal({ ok: false, title: "Insufficient Balance", msg: `You have ${remainingDays} day(s) of ${selectedType.name} left, but requested ${totalDays}.` });
        return;
      }
    }

    // All the validation above (including the same-type-pending check)
    // already mirrors what the backend will enforce, so the request is
    // effectively guaranteed to succeed — confirm immediately and let the
    // actual submission finish in the background instead of making the
    // employee wait on the round trip.
    const payload = {
      employeeId:         user.employeeId,
      leaveTypeId,
      startDate:          new Date(startDate).toISOString(),
      endDate:            new Date(endDate).toISOString(),
      totalDays,
      reason:             reason.trim(),
      attachmentName:     attachment?.name,
      attachmentMimeType: attachment?.mimeType,
      attachmentData:     attachment?.base64,
      extensionRequested: selectedType?.kind === "MATERNITY" ? extensionRequested : undefined,
    };

    resetForm();
    setResultModal({ ok: true, title: "Leave Request Submitted", msg: "Your HR/Admin and supervisor have been notified. You'll be informed once it's reviewed." });

    createLeaveRequest(payload)
      // Only `requests` actually changed (the new request itself) — balances
      // don't move until this is approved, and leave types/undertime are
      // untouched by filing a leave request, so this doesn't refetch them.
      .then(() => requestsCache.refresh())
      .catch((err) => {
        // The "Submitted" modal above has likely already been dismissed by
        // now, so a transient modal here isn't enough — this sticks around
        // (see submissionAlert) until the employee explicitly closes it.
        setSubmissionAlert({
          title: "Leave Request Failed",
          msg: `Your ${selectedType?.name ?? "leave"} request did not go through: ${err instanceof Error ? err.message : "please try again."}`,
        });
        // Best-effort — if this also fails (e.g. still offline), the cached
        // pending list simply stays as it was; the alert above is what
        // actually informs the employee either way.
        requestsCache.refresh().catch(() => undefined);
      });
  }

  // Compact, clickable row for the "My Leave Requests" list — tapping opens
  // the full detail view (renderRequestCard, via focusedRequestId) where the
  // Cancel button actually lives.
  function renderRequestSummary(r: LeaveRequest) {
    const tone = statusTone(r.status);
    return (
      <button
        key={r.id}
        type="button"
        onClick={() => {
          setFocusedRequestId(r.id);
          requestsCache.refresh().catch(() => undefined);
        }}
        style={{
          display: "block", width: "100%", textAlign: "left",
          background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 12,
          padding: 14, marginBottom: 10, cursor: "pointer",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <p style={{
            fontWeight: 700, margin: 0, flex: 1, minWidth: 0,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>
            {r.leaveType.name}
          </p>
          <span style={{
            display: "inline-block", flexShrink: 0, whiteSpace: "nowrap",
            background: tone.bg, color: tone.color,
            fontWeight: 700, fontSize: 10,
            borderRadius: 999, padding: "3px 7px",
          }}>
            {statusLabel(r.status)}
          </span>
        </div>
        <p style={{ color: "#475569", fontSize: 13, margin: "4px 0 0" }}>
          {new Date(r.startDate).toLocaleDateString()} – {new Date(r.endDate).toLocaleDateString()}
        </p>
      </button>
    );
  }

  function renderRequestCard(r: LeaveRequest) {
    const tone = statusTone(r.status);
    const needsRevision = r.status === "NEEDS_REVISION";
    const canShowCancelSection =
      !needsRevision && (r.status === "PENDING" || r.status === "SUPERVISOR_APPROVED" || r.status === "APPROVED");
    // Server-computed (see getCancellationEligibility in leave.service.ts) —
    // covers the cutoff window and the leave type's cancellationAllowed flag
    // so the button here is disabled with a real reason instead of just
    // failing after the fact. Falls back to "always allowed" for the rare
    // case this field is missing (e.g. a stale cached response).
    const cancellation = r.cancellation ?? { allowed: true };
    const lastRejection = needsRevision
      ? [...(r.notes ?? [])].reverse().find((n) => n.type === "REJECTED")
      : undefined;
    // Once a supervisor denies a cancellation request, the leave reverts to
    // plain APPROVED — this note is the only trace that it ever had a
    // cancellation attempt, so it's what makes that outcome visible here
    // instead of the request silently looking untouched. Cancel stays
    // disabled from here on (see cancellation.allowed, which the backend's
    // getCancellationEligibility already refuses once this note exists).
    const cancellationDenied =
      r.status === "APPROVED" ? [...(r.notes ?? [])].reverse().find((n) => n.type === "CANCELLATION_DENIED") : undefined;
    return (
      <div key={r.id} style={{ background: "#F8FAFC", borderRadius: 12, padding: 14, marginBottom: 10 }}>
        <p style={{ fontWeight: 700, marginBottom: 3 }}>{r.leaveType.name}</p>
        <p style={{ color: "#475569", fontSize: 13, marginBottom: 3 }}>
          {new Date(r.startDate).toLocaleDateString()} – {new Date(r.endDate).toLocaleDateString()}
        </p>
        {r.attachmentName && (
          attachmentSrc(r.attachmentMimeType, r.attachmentData) ? (
            <button
              type="button"
              onClick={() =>
                setPreviewAttachment({
                  src: attachmentSrc(r.attachmentMimeType, r.attachmentData)!,
                  name: r.attachmentName!,
                  mimeType: r.attachmentMimeType!,
                })
              }
              title={r.attachmentName}
              style={{
                display: "block", width: "100%", textAlign: "left",
                border: "none", background: "none", padding: 0, cursor: "pointer",
                color: "#1680D8", fontSize: 12, fontWeight: 600, margin: "3px 0",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}
            >
              📎 {r.attachmentName}
            </button>
          ) : (
            <p
              title={r.attachmentName}
              style={{
                color: "#64748B", fontSize: 12, margin: "3px 0",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}
            >
              📎 {r.attachmentName}
            </p>
          )
        )}
        {lastRejection && (
          <div style={{ background: "#FEF3C7", border: "1px solid #FCD34D", borderRadius: 8, padding: "8px 10px", margin: "6px 0" }}>
            {lastRejection.message && (
              <p style={{ color: "#92400E", fontSize: 12, margin: 0 }}>{lastRejection.message}</p>
            )}
            {lastRejection.requirementDetails && (
              <p style={{ color: "#92400E", fontSize: 12, margin: "3px 0 0", fontWeight: 700 }}>
                Requirement needed: {lastRejection.requirementDetails}
              </p>
            )}
          </div>
        )}
        {cancellationDenied && (
          <div style={{ background: "#FEF2F2", border: "1px solid #FCA5A5", borderRadius: 8, padding: "8px 10px", margin: "6px 0" }}>
            <p style={{ color: "#B91C1C", fontSize: 12, margin: 0, fontWeight: 700 }}>
              Cancellation denied by your supervisor — this leave remains approved.
            </p>
            {cancellationDenied.message && (
              <p style={{ color: "#B91C1C", fontSize: 12, margin: "3px 0 0" }}>{cancellationDenied.message}</p>
            )}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
          <span style={{
            display: "inline-block",
            background: tone.bg, color: tone.color,
            fontWeight: 700, fontSize: 11,
            borderRadius: 999, padding: "3px 8px",
          }}>
            {statusLabel(r.status)}
          </span>
        </div>

        <LeaveTimeline history={r.history} status={r.status} />

        {canShowCancelSection && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #E2E8F0" }}>
            <button
              onClick={() => { setConfirmCancelId(r.id); setCancelReasonText(""); }}
              disabled={!cancellation.allowed}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
                width: "100%", borderRadius: 10, padding: "10px 12px",
                fontWeight: 700, fontSize: 13,
                ...(cancellation.allowed
                  ? { border: "1px solid #FCA5A5", background: "#FEF2F2", color: "#DC2626", cursor: "pointer" }
                  : { border: "1px solid #E2E8F0", background: "#F8FAFC", color: "#94A3B8", cursor: "not-allowed" }),
              }}
            >
              <XCircle size={15} />
              Cancel Leave
            </button>
            {!cancellation.allowed && cancellation.reason && (
              <div style={{
                display: "flex", alignItems: "flex-start", gap: 6, marginTop: 8,
                background: "#FFFBEB", border: "1px solid #FEF3C7", borderRadius: 8, padding: "8px 10px",
              }}>
                <AlertCircle size={13} color="#92400E" style={{ flexShrink: 0, marginTop: 1 }} />
                <p style={{ color: "#92400E", fontSize: 11.5, lineHeight: "16px", margin: 0 }}>{cancellation.reason}</p>
              </div>
            )}
          </div>
        )}

        {needsRevision && (
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #E2E8F0" }}>
            {resubmitFile ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid #E2E8F0", borderRadius: 10, padding: "8px 10px", background: "#FFFFFF" }}>
                <Paperclip size={14} color="#1680D8" />
                <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: "#062B59", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {resubmitFile.name}
                </span>
                <button
                  onClick={() => setResubmitFile(null)}
                  style={{ border: "none", background: "#F1F5F9", borderRadius: 11, width: 22, height: 22, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                >
                  <X size={12} color="#64748B" />
                </button>
              </div>
            ) : (
              <label
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                  width: "100%", height: 40,
                  border: "1.5px dashed #BFDBFE", borderRadius: 10,
                  background: "#F8FAFF", cursor: "pointer",
                  color: "#1680D8", fontSize: 12, fontWeight: 600,
                  position: "relative", overflow: "hidden",
                }}
              >
                <Paperclip size={14} color="#1680D8" />
                Attach the requested requirement
                <input
                  type="file"
                  accept="image/*,.pdf"
                  style={hiddenFileInput}
                  onChange={handleResubmitFileChange}
                />
              </label>
            )}
            {resubmitErr && <p style={{ color: "#DC2626", fontSize: 11, fontWeight: 600, marginTop: 4 }}>{resubmitErr}</p>}
            <textarea
              value={resubmitNote}
              onChange={(e) => setResubmitNote(e.target.value)}
              placeholder="Optional note to the reviewer"
              rows={2}
              style={{
                width: "100%", border: "1px solid #E2E8F0", borderRadius: 10,
                padding: "8px 10px", fontSize: 12, resize: "vertical",
                boxSizing: "border-box", fontFamily: "inherit", outline: "none",
                marginTop: 8,
              }}
            />
            <button
              onClick={() => handleResubmit(r.id)}
              disabled={isResubmitting}
              style={{
                ...primBtn, height: 38, fontSize: 12, marginTop: 8,
                opacity: isResubmitting ? 0.7 : 1, cursor: isResubmitting ? "not-allowed" : "pointer",
              }}
            >
              {isResubmitting ? "Resubmitting…" : "Resubmit Request"}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="emp-form-page">
      <h2 className="emp-page-title">Leave</h2>

      {submissionAlert && (
        <div style={{
          display: "flex", alignItems: "flex-start", gap: 10,
          background: "#FEF2F2", border: "1px solid #FCA5A5", borderRadius: 12,
          padding: 12, marginBottom: 14,
        }}>
          <AlertCircle size={18} color="#B91C1C" style={{ flexShrink: 0, marginTop: 1 }} />
          <div style={{ flex: 1 }}>
            <p style={{ color: "#B91C1C", fontWeight: 700, fontSize: 13, margin: 0 }}>{submissionAlert.title}</p>
            <p style={{ color: "#991B1B", fontSize: 12, margin: "2px 0 0" }}>{submissionAlert.msg}</p>
          </div>
          <button
            type="button"
            onClick={() => setSubmissionAlert(null)}
            style={{ border: "none", background: "none", cursor: "pointer", padding: 0, display: "flex" }}
          >
            <X size={16} color="#B91C1C" />
          </button>
        </div>
      )}

      {/* Tab switcher */}
      <SegmentedControl
        segments={[
          { key: "balance", label: "Balance" },
          { key: "request", label: "Request" },
          { key: "undertime", label: "Undertime" },
        ]}
        value={tab}
        onChange={(key) => setTab(key as Tab)}
        style={{ marginBottom: 16 }}
      />

      {/* ── Balance tab ──────────────────────────────────────────────────────── */}
      {tab === "balance" && (
        <LeaveBalanceChart
          balances={visibleBalances}
          loading={loadingData}
          pendingCount={pendingRequests.length}
          needsRevisionCount={needsRevisionCount}
          onPressPending={openPendingModal}
          onPressViewAll={openPendingModal}
          onRequest={handleRequestFromBalance}
        />
      )}

      {/* ── Request tab ──────────────────────────────────────────────────────── */}
      {tab === "request" && (
        <div style={{ background: "#FFFFFF", borderRadius: 18, border: "1px solid #E2E8F0", padding: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
              <FileText size={28} color="#DC2777" />
              <h3 style={{ color: "#062B59", fontSize: 18, fontWeight: 700, margin: 0 }}>Leave Request</h3>
            </div>

            {pendingRequests.length > 0 && (
              <button
                type="button"
                onClick={openPendingModal}
                style={{
                  display: "block", width: "100%", textAlign: "left", border: "none", cursor: "pointer",
                  background: "#EFF6FF", borderRadius: 10, padding: "10px 12px",
                  color: "#1680D8", fontSize: 13, lineHeight: "18px", marginBottom: 16,
                }}
              >
                You have {pendingRequests.length} leave request{pendingRequests.length === 1 ? "" : "s"} awaiting review (click to view). You can still file for a different leave type.
              </button>
            )}

            {/* Leave type searchable dropdown */}
            <label style={fldLbl}>Leave Type</label>
            <div style={{ position: "relative", zIndex: dropOpen ? 20 : 1, marginBottom: dropOpen ? 204 : 0 }}>
              <button
                onClick={() => { setDropOpen(!dropOpen); setSearchLeave(""); }}
                style={{ ...dropBtn, borderColor: dropOpen ? "#062B59" : "#E2E8F0" }}
              >
                <span style={{ color: leaveTypeId ? "#0F172A" : "#94A3B8", fontSize: 14 }}>
                  {selectedType?.name || (loadingData ? "Loading…" : "Select Leave Type")}
                </span>
                {dropOpen ? <ChevronUp size={18} color="#64748B" /> : <ChevronDown size={18} color="#64748B" />}
              </button>

              {dropOpen && (
                <div style={dropPanel}>
                  <div style={searchRow}>
                    <Search size={14} color="#94A3B8" />
                    <input
                      autoFocus
                      placeholder="Search leave type…"
                      value={searchLeave}
                      onChange={(e) => setSearchLeave(e.target.value)}
                      style={searchInp}
                    />
                  </div>
                  <div className="emp-scroll-thin" style={{ maxHeight: 158, overflowY: "auto" }}>
                    {filteredTypes.length === 0
                      ? <p style={{ padding: 14, textAlign: "center", color: "#94A3B8", fontSize: 13, margin: 0 }}>No leave types found</p>
                      : filteredTypes.map((t) => {
                          const exhausted = isLeaveTypeExhausted(t);
                          const alreadyPending = isLeaveTypeAlreadyPending(t);
                          const unavailableToday = !exhausted && !alreadyPending && isLeaveTypeUnavailableToday(t);
                          const disabled = exhausted || alreadyPending || unavailableToday;
                          return (
                            <button
                              key={t.id}
                              disabled={disabled}
                              onClick={() => { setLeaveTypeId(t.id); setDropOpen(false); setSearchLeave(""); }}
                              style={{
                                display: "block", width: "100%", textAlign: "left",
                                padding: "11px 14px", border: "none",
                                borderBottom: "1px solid #F1F5F9",
                                background: disabled ? "#F8FAFC" : "none",
                                cursor: disabled ? "not-allowed" : "pointer",
                                color:      disabled ? "#CBD5E1" : leaveTypeId === t.id ? "#062B59" : "#334155",
                                fontWeight: leaveTypeId === t.id ? 700 : 400,
                                fontSize: 14,
                              }}
                            >
                              {t.name}{t.requiresDocument ? (t.supportingDocumentAfterDays ? ` (document required after ${t.supportingDocumentAfterDays}+ days)` : " (document required)") : ""}
                              {exhausted
                                ? t.requiresAdminGrant
                                  ? " (apply to HR/Admin first)"
                                  : " (no balance left)"
                                : alreadyPending
                                  ? " (already pending)"
                                  : unavailableToday
                                    ? " (today is a non-working day)"
                                    : ""}
                            </button>
                          );
                        })
                    }
                  </div>
                </div>
              )}
            </div>

            {/* Dates */}
            <label style={fldLbl}>{selectedType?.isSingleDayOnly ? "Date" : "Leave Duration"}</label>
            {selectedType?.isSingleDayOnly ? (
              <CalendarPicker
                value={startDate}
                onChange={setStartDate}
                min={minStartDate}
                max={maxStartDate}
                isDateDisabled={isDateAlreadyFiledForType}
                isDateNonWorking={isDateNonWorking}
              />
            ) : (
              <div style={{ display: "flex", gap: 10 }}>
                <CalendarPicker
                  value={startDate}
                  onChange={setStartDate}
                  min={minStartDate}
                  max={maxStartDate}
                  isDateDisabled={isDateAlreadyFiledForType}
                  isDateNonWorking={isDateNonWorking}
                  placeholder="Start date"
                />
                <CalendarPicker
                  value={endDate}
                  onChange={setEndDate}
                  min={startDate || minStartDate}
                  max={maxEndDate}
                  isDateDisabled={isDateAlreadyFiledForType}
                  isDateNonWorking={isDateNonWorking}
                  placeholder="End date"
                  align="right"
                />
              </div>
            )}
            {startDate && endDate && !selectedType?.isSingleDayOnly && (
              <p style={{ fontSize: 12, fontWeight: 600, color: "#1680D8", margin: "5px 0 0" }}>
                {totalDays} day{totalDays === 1 ? "" : "s"} total
              </p>
            )}
            {selectedType && selectedType.advanceFilingAllowed === false && isDateNonWorking(todayStart) && (
              <p style={{ fontSize: 11.5, fontWeight: 600, color: "#B45309", margin: "4px 0 0" }}>
                Today is your day off / a non-working day — {selectedType.name} can't be filed until your next working day.
              </p>
            )}
            {maxEndDate && !selectedType?.isSingleDayOnly && (
              <p style={{ fontSize: 11, color: "#94A3B8", margin: "4px 0 0" }}>
                {remainingDaysFor(selectedType!)} day{remainingDaysFor(selectedType!) === 1 ? "" : "s"} available for {selectedType!.name} — end date can't go past {maxEndDate}.
              </p>
            )}

            {/* Attachment */}
            <label style={fldLbl}>
              Supporting Document{isDocumentRequired ? " (required)" : " (optional)"}
            </label>
            {attachment ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid #E2E8F0", borderRadius: 12, padding: "10px 12px" }}>
                <Paperclip size={16} color="#1680D8" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontWeight: 600, fontSize: 13, color: "#062B59", margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {attachment.name}
                  </p>
                  <p style={{ color: "#94A3B8", fontSize: 11, margin: 0 }}>{fmtBytes(attachment.sizeBytes)}</p>
                </div>
                <button
                  onClick={() => setAttachment(null)}
                  style={{ border: "none", background: "#F1F5F9", borderRadius: 13, width: 26, height: 26, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                >
                  <X size={14} color="#64748B" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => fileRef.current?.click()}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                  width: "100%", height: 48,
                  border: "1.5px dashed #BFDBFE", borderRadius: 12,
                  background: "#F8FAFF", cursor: "pointer",
                  color: "#1680D8", fontSize: 13, fontWeight: 600,
                }}
              >
                <Paperclip size={18} color="#1680D8" />
                Tap to attach a photo or PDF
              </button>
            )}
            {attachErr && <p style={{ color: "#DC2626", fontSize: 12, fontWeight: 600, marginTop: 4 }}>{attachErr}</p>}
            <input ref={fileRef} type="file" accept="image/*,.pdf" style={{ display: "none" }} onChange={handleFileChange} />

            {/* Reason */}
            <label style={fldLbl}>Reason</label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Enter reason"
              rows={4}
              style={{
                width: "100%", border: "1px solid #E2E8F0", borderRadius: 12,
                padding: "10px 14px", fontSize: 14, resize: "vertical",
                boxSizing: "border-box", fontFamily: "inherit", outline: "none",
              }}
            />

            {selectedType?.kind === "MATERNITY" && (
              <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={extensionRequested}
                  onChange={(e) => setExtensionRequested(e.target.checked)}
                />
                <span style={{ fontSize: 13, color: "#475569" }}>Request 30-day extension without pay</span>
              </label>
            )}

            <button
              onClick={handleSubmit}
              style={{ ...primBtn, marginTop: 16 }}
            >
              Submit Leave Request
            </button>
        </div>
      )}

      {/* ── Undertime tab ────────────────────────────────────────────────────── */}
      {tab === "undertime" && (
        <div style={{ background: "#FFFFFF", borderRadius: 18, border: "1px solid #E2E8F0", padding: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <FileText size={28} color="#DC2777" />
            <h3 style={{ color: "#062B59", fontSize: 18, fontWeight: 700, margin: 0 }}>File Undertime</h3>
          </div>

          {/* Everything here mirrors whatever the backend's eligibility check
              returns — the 8th/23rd filing days and the 3-per-month cap are
              not hardcoded on this page, only reflected from the API. */}
          {undertimeEligibility && (
            <p style={{ color: "#475569", fontSize: 13, marginTop: 0, marginBottom: 14, lineHeight: "18px" }}>
              {undertimeEligibility.filedThisMonth}/{undertimeEligibility.maxFilingsPerMonth} filed this month.{" "}
              {undertimeEligibility.alreadyFiledToday
                ? "You've already filed undertime today."
                : !undertimeEligibility.isFilingDay
                  ? `Undertime can only be filed on the ${undertimeEligibility.filingDaysOfMonth.join(" or ")} of the month.`
                  : undertimeEligibility.remaining <= 0
                    ? "You've reached this month's filing limit."
                    : "You're eligible to file undertime today."}
            </p>
          )}

          <label style={fldLbl}>Reason (optional)</label>
          <textarea
            value={undertimeReason}
            onChange={(e) => setUndertimeReason(e.target.value)}
            placeholder="Optional note for this filing"
            style={{ ...dateInp, height: 70, resize: "vertical", width: "100%", boxSizing: "border-box" }}
          />

          {undertimeErr && (
            <p style={{ color: "#DC2626", fontSize: 12, marginTop: 8 }}>{undertimeErr}</p>
          )}

          <button
            disabled={isFilingUndertime || !undertimeEligibility?.eligible}
            onClick={handleFileUndertime}
            style={{
              ...primBtn,
              marginTop: 16,
              opacity: isFilingUndertime || !undertimeEligibility?.eligible ? 0.6 : 1,
              cursor: isFilingUndertime || !undertimeEligibility?.eligible ? "not-allowed" : "pointer",
            }}
          >
            {isFilingUndertime ? "Filing…" : "File Undertime for Today"}
          </button>

          <p style={{ color: "#062B59", fontSize: 13, fontWeight: 700, marginTop: 22, marginBottom: 8 }}>
            This Month's Filings
          </p>
          {undertimeFilings.length === 0 ? (
            <p style={{ color: "#94A3B8", fontSize: 13 }}>No undertime filings yet.</p>
          ) : (
            undertimeFilings.map((f) => (
              <div key={f.id} style={{ background: "#F8FAFC", borderRadius: 12, padding: 12, marginBottom: 8 }}>
                <p style={{ fontWeight: 700, margin: 0, fontSize: 13 }}>{new Date(f.filingDate).toLocaleDateString()}</p>
                {f.reason && <p style={{ color: "#64748B", fontSize: 12, margin: "3px 0 0" }}>{f.reason}</p>}
              </div>
            ))
          )}
        </div>
      )}

      {/* ── Pending requests modal ───────────────────────────────────────────── */}
      {showPending && (
        <div style={overlayNoBg}>
          <div className="emp-scroll-thin" style={modalCardFloating}>
            <h3 style={{ color: "#062B59", fontWeight: 700, marginBottom: 14 }}>My Leave Requests</h3>

            <SegmentedControl
              segments={[
                { key: "current", label: `Current (${currentRequests.length})` },
                { key: "past", label: `Past (${pastRequests.length})` },
              ]}
              value={requestsListTab}
              onChange={(key) => setRequestsListTab(key as "current" | "past")}
              style={{ marginBottom: 16 }}
            />

            {/* Same navy-active/grey-inactive colors as every other pill on
                this page (Balance/Request/Undertime, Current/Past) instead of
                a third color; flex:1 keeps all four on one line. */}
            <div style={{ display: "flex", gap: 5, marginBottom: 10 }}>
              {STATUS_FILTERS.map((filter) => {
                const active = requestsStatusFilter === filter.key;
                return (
                  <button
                    key={filter.key}
                    type="button"
                    onClick={() => setRequestsStatusFilter(active ? "ALL" : filter.key)}
                    style={{
                      flex: 1, border: "none", borderRadius: 999, padding: "7px 4px", cursor: "pointer",
                      fontSize: 11, fontWeight: 700,
                      background: active ? "#062B59" : "#F1F5F9",
                      color: active ? "#FFFFFF" : "#64748B",
                    }}
                  >
                    {filter.label}
                  </button>
                );
              })}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <CalendarPicker
                value={requestsDateFrom}
                onChange={setRequestsDateFrom}
                max={requestsDateTo || undefined}
                placeholder="Filed from"
              />
              <CalendarPicker
                value={requestsDateTo}
                onChange={setRequestsDateTo}
                min={requestsDateFrom || undefined}
                placeholder="Filed to"
                align="right"
              />
              {(requestsDateFrom || requestsDateTo) && (
                <button
                  type="button"
                  onClick={() => {
                    setRequestsDateFrom("");
                    setRequestsDateTo("");
                  }}
                  aria-label="Clear date filter"
                  style={{
                    border: "none", background: "#F1F5F9", borderRadius: 10, width: 32, height: 32,
                    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                  }}
                >
                  <X size={14} color="#64748B" />
                </button>
              )}
            </div>

            <div className="emp-scroll-thin" style={{ maxHeight: 280, overflowY: "auto" }}>
              {(requestsListTab === "current" ? currentRequests : pastRequests).length === 0 ? (
                <p style={{ color: "#94A3B8", fontSize: 13, textAlign: "center" }}>
                  {requestsDateFrom || requestsDateTo || requestsStatusFilter !== "ALL"
                    ? "No requests match these filters."
                    : requestsListTab === "current"
                      ? "No ongoing or upcoming filed leave."
                      : "No past leave requests."}
                </p>
              ) : (
                (requestsListTab === "current" ? currentRequests : pastRequests).map(renderRequestSummary)
              )}
            </div>
            <button onClick={() => setShowPending(false)} style={{ ...primBtn, marginTop: 10 }}>Close</button>
          </div>
        </div>
      )}

      {focusedRequest && (
        <div style={overlayNoBg}>
          <div className="emp-scroll-thin" style={modalCardFloating}>
            {/* Mirrors employee-mobile's LeaveScreen.tsx back row — this
                detail view is reached from the requests list, so "back" reads
                clearer here than a dead-end "Close". */}
            <button
              type="button"
              onClick={() => setFocusedRequestId(null)}
              style={{
                display: "flex", alignItems: "center", gap: 4,
                border: "none", background: "none", cursor: "pointer",
                padding: 0, marginBottom: 10,
                color: "#1680D8", fontWeight: 700, fontSize: 13,
              }}
            >
              <ChevronLeft size={16} color="#1680D8" />
              All requests
            </button>
            <h3 style={{ color: "#062B59", fontWeight: 700, marginBottom: 14 }}>Leave Request Details</h3>
            {renderRequestCard(focusedRequest)}
          </div>
        </div>
      )}

      {/* ── Cancel confirmation ──────────────────────────────────────────────── */}
      {confirmCancelId && (
        <div style={overlayS}>
          <div style={{ ...modalCard, maxWidth: 360, textAlign: "center" }}>
            <h3 style={{ color: "#062B59", fontWeight: 700, marginBottom: 8 }}>Cancel this leave request?</h3>
            <p style={{ color: "#475569", fontSize: 14, lineHeight: "20px", marginBottom: 14 }}>
              This action cannot be undone. Your supervisor will need to approve the cancellation.
            </p>
            <textarea
              value={cancelReasonText}
              onChange={(e) => setCancelReasonText(e.target.value)}
              placeholder="Why are you cancelling this leave?"
              rows={3}
              style={{
                width: "100%", border: "1px solid #E2E8F0", borderRadius: 10,
                padding: "10px 12px", fontSize: 13, resize: "vertical",
                boxSizing: "border-box", fontFamily: "inherit", outline: "none",
                marginBottom: 16, textAlign: "left",
              }}
            />
            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={() => setConfirmCancelId(null)}
                style={{ ...primBtn, flex: 1, background: "#F1F5F9", color: "#334155" }}
              >
                No, Keep It
              </button>
              <button
                onClick={() => {
                  handleCancel(confirmCancelId, cancelReasonText.trim());
                  setConfirmCancelId(null);
                }}
                disabled={!cancelReasonText.trim()}
                style={{
                  ...primBtn, flex: 1,
                  background: cancelReasonText.trim() ? "#DC2626" : "#FCA5A5",
                  cursor: cancelReasonText.trim() ? "pointer" : "not-allowed",
                }}
              >
                Yes, Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Result modal ─────────────────────────────────────────────────────── */}
      {resultModal && (
        <div style={overlayS}>
          <div style={{ ...modalCard, textAlign: "center" }}>
            {resultModal.ok
              ? <div style={iconCircle("#DCFCE7")}><CheckCircle size={40} color="#17A34A" /></div>
              : <div style={iconCircle("#FEE2E2")}><AlertCircle size={40} color="#DC2626" /></div>
            }
            <h3 style={{ color: "#062B59", fontWeight: 700, marginBottom: 8 }}>{resultModal.title}</h3>
            <p style={{ color: "#475569", fontSize: 14, lineHeight: "20px", marginBottom: 20 }}>{resultModal.msg}</p>
            <button
              onClick={() => setResultModal(null)}
              style={{ ...primBtn, background: resultModal.ok ? "#17A34A" : "#DC2626" }}
            >
              Done
            </button>
          </div>
        </div>
      )}

      {/* ── Attachment preview lightbox ─────────────────────────────────────── */}
      {previewAttachment && (
        <div
          role="presentation"
          onClick={() => setPreviewAttachment(null)}
          style={{
            position: "fixed", inset: 0, zIndex: 2100,
            display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
            background: "rgba(15, 23, 42, 0.82)", cursor: "zoom-out",
          }}
        >
          <button
            type="button"
            onClick={() => setPreviewAttachment(null)}
            aria-label="Close attachment preview"
            style={{
              position: "fixed", top: 20, right: 24, width: 40, height: 40,
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              border: "1px solid rgba(255,255,255,0.3)", borderRadius: 999,
              background: "rgba(255,255,255,0.1)", color: "#fff", cursor: "pointer",
            }}
          >
            <X size={20} />
          </button>
          {previewAttachment.mimeType.startsWith("image/") ? (
            <img
              src={previewAttachment.src}
              alt={previewAttachment.name}
              onClick={(e) => e.stopPropagation()}
              style={{
                maxWidth: "min(90vw, 900px)", maxHeight: "88vh",
                borderRadius: 10, boxShadow: "0 24px 60px rgba(0,0,0,0.4)", cursor: "default",
              }}
            />
          ) : (
            <iframe
              src={previewAttachment.src}
              title={previewAttachment.name}
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "min(92vw, 980px)", height: "min(88vh, 900px)",
                border: "none", borderRadius: 10, background: "#fff",
                boxShadow: "0 24px 60px rgba(0,0,0,0.4)", cursor: "default",
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const fldLbl: CSSProperties = {
  display: "block", fontWeight: 600, color: "#475569",
  fontSize: 14, marginBottom: 5, marginTop: 14,
};
const dropBtn: CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  width: "100%", height: 48, border: "1px solid #E2E8F0",
  borderRadius: 12, padding: "0 14px",
  background: "#FFFFFF", cursor: "pointer",
};
const dropPanel: CSSProperties = {
  position: "absolute", top: "100%", left: 0, right: 0,
  background: "#FFFFFF", border: "1px solid #E2E8F0",
  borderRadius: 12, overflow: "hidden",
  boxShadow: "0 4px 14px rgba(0,0,0,0.1)", zIndex: 50,
};
const searchRow: CSSProperties = {
  display: "flex", alignItems: "center",
  borderBottom: "1px solid #E2E8F0", padding: "0 10px",
  background: "#F8FAFC", gap: 6,
};
const searchInp: CSSProperties = {
  flex: 1, border: "none", outline: "none",
  padding: "10px 6px", fontSize: 13, background: "transparent",
};
const dateInp: CSSProperties = {
  flex: 1, height: 48, border: "1px solid #E2E8F0",
  borderRadius: 12, padding: "0 14px",
  fontSize: 14, background: "#FFFFFF", outline: "none",
};
const primBtn: CSSProperties = {
  display: "block", width: "100%", height: 50,
  borderRadius: 14, border: "none",
  background: "#062B59", color: "#FFFFFF",
  fontSize: 14, fontWeight: 700, cursor: "pointer",
};
const hiddenFileInput: CSSProperties = {
  position: "absolute",
  inset: 0,
  opacity: 0,
  cursor: "pointer",
};
const overlayS: CSSProperties = {
  position: "fixed", inset: 0,
  background: "rgba(6,43,89,0.55)", zIndex: 2000,
  display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
};
const modalCard: CSSProperties = {
  width: "100%", maxWidth: 420,
  maxHeight: "85vh", overflowY: "auto",
  background: "#fff", borderRadius: 20, padding: 20,
};
// Same positioning as overlayS but blurs the page behind it instead of
// dimming it with a flat color — matches the blur(2px) backdrop already used
// by the notification detail modal elsewhere in this app. modalCardFloating
// still adds its own shadow/border for contrast against the blurred page.
const overlayNoBg: CSSProperties = {
  ...overlayS,
  background: "rgba(15, 23, 42, 0.45)",
  backdropFilter: "blur(2px)",
  WebkitBackdropFilter: "blur(2px)",
};
const modalCardFloating: CSSProperties = {
  ...modalCard,
  border: "1px solid #E2E8F0",
  boxShadow: "0 12px 40px rgba(6,43,89,0.18)",
};
function iconCircle(bg: string): CSSProperties {
  return {
    width: 80, height: 80, borderRadius: "50%", background: bg,
    display: "flex", alignItems: "center", justifyContent: "center",
    margin: "0 auto 14px",
  };
}
