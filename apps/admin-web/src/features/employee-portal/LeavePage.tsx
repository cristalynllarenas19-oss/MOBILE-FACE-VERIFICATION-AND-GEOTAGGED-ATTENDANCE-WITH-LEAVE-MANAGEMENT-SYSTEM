

import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Calendar, CalendarClock, Check, CheckCircle, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Clock, FileText, Lightbulb, Lock as LockIcon, Paperclip, Plane, Search, Stethoscope, Timer, Wallet, X, XCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import "./EmployeePortal.css";
import {
  LeaveType, LeaveBalance, LeaveRequest, UndertimeEligibility, UndertimeFiling, MySchedule, AttendanceHistoryRecord,
  getLeaveTypes, getLeaveBalances, getLeaveRequests, createLeaveRequest, createLeaveRequests, cancelLeaveRequest, resubmitLeaveRequest, requestLeaveExtension,
  getUndertimeEligibility, getUndertimeFilings, fileUndertime, getMySchedules, getAttendanceHistory,
  filedMinutes, getMyProfile,
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

type RequestStatusFilter = "ALL" | "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED" | "LAPSED";

// Same neutral pill style as every other filter chip here (Filed From/To
// below) — a permanent per-status color made the row read as decoration
// rather than a set of toggles (mirrors employee-mobile's LeaveScreen.tsx).
const STATUS_FILTERS: { key: Exclude<RequestStatusFilter, "ALL">; label: string }[] = [
  { key: "PENDING", label: "Pending" },
  { key: "APPROVED", label: "Approved" },
  { key: "REJECTED", label: "Rejected" },
  { key: "CANCELLED", label: "Cancelled" },
  { key: "LAPSED", label: "Lapsed" },
];

// Only the statuses a request on that tab can actually have — an Active
// request is never Rejected/Cancelled/Lapsed, and a Past one is never
// Pending, so those chips could only ever produce an empty list (mirrors
// employee-mobile's LeaveScreen.tsx).
const STATUS_FILTERS_BY_TAB: Record<"current" | "past", Exclude<RequestStatusFilter, "ALL">[]> = {
  current: ["PENDING", "APPROVED"],
  past: ["APPROVED", "REJECTED", "CANCELLED", "LAPSED"],
};

// A request in any of these still covers its dates, so no other leave (of
// any type) can be filed over them. Mirrors leave.service.ts's create().
const BLOCKING_LEAVE_STATUSES: string[] = [
  "PENDING",
  "SUPERVISOR_APPROVED",
  "NEEDS_REVISION",
  "APPROVED",
  "CANCELLATION_PENDING",
];

// Buckets a request's raw status into one of the five filter chips — same
// grouping as statusTone below (mirrors employee-mobile's LeaveScreen.tsx).
function statusFilterBucket(status: string): Exclude<RequestStatusFilter, "ALL"> | null {
  if (status === "APPROVED" || status === "SUPERVISOR_APPROVED") return "APPROVED";
  if (status === "REJECTED") return "REJECTED";
  if (status === "CANCELLED") return "CANCELLED";
  if (status === "LAPSED") return "LAPSED";
  if (status === "PENDING" || status === "NEEDS_REVISION" || status === "CANCELLATION_PENDING") return "PENDING";
  return null;
}

function statusTone(s: string) {
  if (s === "APPROVED" || s === "SUPERVISOR_APPROVED") return { color: "#15803D", bg: "#DCFCE7" };
  if (s === "REJECTED") return { color: "#B91C1C", bg: "#FEE2E2" };
  // Darker red than REJECTED, not a different color family — still reads as
  // "not approved" but distinct in shade from an outright rejection.
  if (s === "CANCELLED") return { color: "#7F1D1D", bg: "#FEE2E2" };
  // Neutral grey, not red — nobody rejected it; it simply ran out of time.
  if (s === "LAPSED") return { color: "#475569", bg: "#E2E8F0" };
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
// Every status pill on this page is one fixed size, sized to fit the
// longest label ("LAPSED - REPORTED TO WORK") — same as the Leave
// Management and Reports tables — so a column of them lines up.
const STATUS_PILL_SIZE: CSSProperties = {
  width: 178, boxSizing: "border-box", justifyContent: "center", textAlign: "center", whiteSpace: "nowrap",
};

// A lapsed request always says which kind: the employee came to work on
// those days anyway, or nobody decided in time and the days stand as absent.
function statusLabel(s: string, lapseReason?: string | null) {
  if (s === "LAPSED") return lapseReason === "REPORTED_FOR_WORK" ? "LAPSED - REPORTED TO WORK" : "LAPSED - ABSENT";
  if (s === "SUPERVISOR_APPROVED") return "APPROVED";
  // Reads clearer as "PENDING CANCELLATION" than a plain underscore swap
  // ("CANCELLATION PENDING") — same wording used on the mobile app and the
  // supervisor's review screen so an employee and their supervisor always
  // see the same status for this request.
  if (s === "CANCELLATION_PENDING") return "PENDING CANCELLATION";
  return s.replace(/_/g, " ");
}

function minutesLabel(minutes: number) {
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function lateMinutesLabel(minutes: number) {
  return `${minutesLabel(minutes)} undertime`;
}

function ordinal(day: number) {
  const suffixes = ["th", "st", "nd", "rd"];
  const v = day % 100;
  return `${day}${suffixes[(v - 20) % 10] ?? suffixes[v] ?? suffixes[0]}`;
}

function ordinalDaysOfMonth(days: number[]) {
  return days.map(ordinal).join(" or ");
}

// Same visual language as components/ui/LeaveTimeline.tsx (label, node/line
// rail, tone colors/symbols) but with its own tiny step-builder — undertime's
// Filed/Review/Approved/Rejected vocabulary doesn't fit LeaveTimeline's
// leave-specific action union, so this mirrors the style rather than the
// component.
type UndertimeTimelineTone = "done" | "current" | "danger";
type UndertimeTimelineStep = { key: string; tone: UndertimeTimelineTone; title: string; when: string; detail: string };

const UNDERTIME_TIMELINE_TONE_STYLE: Record<UndertimeTimelineTone, { bg: string; fg: string; border: string; line: string }> = {
  done: { bg: "#1680D8", fg: "#FFFFFF", border: "#1680D8", line: "#1680D8" },
  current: { bg: "#E6F2FC", fg: "#1680D8", border: "#1680D8", line: "#E2E8F0" },
  danger: { bg: "#FEE2E2", fg: "#B91C1C", border: "#FEE2E2", line: "#E2E8F0" },
};
const UNDERTIME_TIMELINE_TONE_SYMBOL: Record<UndertimeTimelineTone, string> = {
  done: "✓",
  current: "···",
  danger: "×",
};

function formatUndertimeTimelineDate(iso: string) {
  const date = new Date(iso);
  return (
    date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    ", " +
    date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  );
}

function buildUndertimeTimelineSteps(filing: UndertimeFiling): UndertimeTimelineStep[] {
  const steps: UndertimeTimelineStep[] = [
    {
      key: "filed",
      tone: "done",
      title: "Filed",
      when: formatUndertimeTimelineDate(filing.createdAt),
      detail: `Submitted.${filing.reason ? ` "${filing.reason}"` : ""}`,
    },
  ];
  if (filing.reviewedAt) {
    // Same "Approved/Rejected by {name}." format as the leave request
    // timeline (LeaveTimeline.tsx's eventToStep).
    const reviewerEmployee = filing.reviewer?.employee;
    const by = reviewerEmployee ? ` by ${reviewerEmployee.firstName} ${reviewerEmployee.lastName}` : "";
    steps.push({
      key: "reviewed",
      tone: filing.status === "REJECTED" ? "danger" : "done",
      title: filing.status === "APPROVED" ? "Approved" : filing.status === "REJECTED" ? "Rejected" : "Reviewed",
      when: formatUndertimeTimelineDate(filing.reviewedAt),
      detail: filing.status === "REJECTED"
        ? `Rejected${by}.${filing.remarks ? ` "${filing.remarks}"` : ""}`
        : `Approved${by}.`,
    });
  } else {
    steps.push({ key: "review-current", tone: "current", title: "Review", when: "In progress", detail: "Awaiting review from the supervisor or HR." });
  }
  return steps;
}

function fmtBytes(b: number) {
  if (b < 1024)         return `${b} B`;
  if (b < 1024 * 1024)  return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

// The specific document HR expects for a leave type, shown as a note under
// the attachment picker. Types not listed here get no note.
function requiredDocumentFor(name?: string) {
  const normalized = (name ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (normalized === "sick leave") return "Medical Certificate";
  if (normalized === "bereavement leave") return "Death Certificate";
  return null;
}

// Leave types an employee is nudged to use first, in this order, before she
// files Maternity Leave. Matched by name — they're GENERAL-kind types, so
// there's no LeaveTypeKind to key on. Vacation keeps its usual blue (see
// lib/leaveTypeColors). Mirrors mobile's LeaveScreen.
const MATERNITY_ALTERNATIVES: { name: string; Icon: LucideIcon; color: string; bg: string }[] = [
  { name: "vacation leave", Icon: Plane, color: "#3B82F6", bg: "#EFF6FF" },
  { name: "sick leave", Icon: Stethoscope, color: "#16A34A", bg: "#ECFDF3" },
  { name: "leave without pay", Icon: Wallet, color: "#D97706", bg: "#FFFBEB" },
];

function maternityAlternativeStyle(t: LeaveType) {
  return MATERNITY_ALTERNATIVES.find((alt) => alt.name === t.name.trim().toLowerCase()) ?? MATERNITY_ALTERNATIVES[0];
}

function attachmentSrc(mimeType: string | null | undefined, data: string | null | undefined) {
  if (!mimeType || !data) return null;
  return `data:${mimeType};base64,${data}`;
}

type LeaveDocument = {
  key: string;
  label: string;
  createdAt: string;
  mimeType: string | null | undefined;
  data: string | null | undefined;
  name: string | null | undefined;
  kind: "submission" | "cancellation";
};

// A request can cycle through reject -> resubmit any number of times; the
// backend only keeps the latest attachment on the request row itself, but
// archives every prior round as a RESUBMITTED note (see resubmit() in
// leave.service.ts), so the full document trail is reconstructed here from
// that note history instead of only ever showing the single current file.
// `createdAt` lets LeaveTimeline line each document up with the step it
// actually belongs to by timestamp rather than by position — a request
// resubmitted before the archiving behavior above shipped is missing the
// original round's document, and matching by position alone would misattach
// the one document it does have. Mirrors employee-mobile's LeaveScreen.tsx
// getRequestDocuments.
// Every calendar day of a leave (local midnights), inclusive.
function leaveDaysOf(r: { startDate: string; endDate: string }) {
  const start = new Date(r.startDate);
  const end = new Date(r.endDate);
  const days: Date[] = [];
  for (
    let day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    day <= new Date(end.getFullYear(), end.getMonth(), end.getDate());
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
  ) {
    days.push(day);
  }
  return days;
}

// The local-midnight times of the days the employee already timed in on.
function workedDayTimes(r: LeaveRequest) {
  return new Set(
    (r.cancellation?.workedDates ?? []).map((iso) => {
      const d = new Date(iso);
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    }),
  );
}

function getRequestDocuments(r: LeaveRequest): LeaveDocument[] {
  return [...getSubmissionDocuments(r), ...getCancellationDocuments(r)];
}

// A 30-day Maternity Leave extension is filed under the Maternity Leave type
// itself (see requestExtension in leave.service.ts) — titled as such.
function leaveRequestTitle(r: LeaveRequest) {
  return r.extensionOfId ? `${r.leaveType.name} Extension (30 days, without pay)` : r.leaveType.name;
}

// A supporting document sent with a cancellation, kept on its CANCELLED note
// (see cancel() in leave.service.ts) — labelled separately so it never shifts
// the Document 1 / Document 2 / … numbering of the filing rounds.
function getCancellationDocuments(r: LeaveRequest): LeaveDocument[] {
  return (r.notes ?? [])
    .filter((n) => n.type === "CANCELLED" && n.attachmentName)
    .map((n) => ({
      key: n.id,
      label: "Cancellation Document",
      createdAt: n.createdAt,
      mimeType: n.attachmentMimeType,
      data: n.attachmentData,
      name: n.attachmentName,
      kind: "cancellation" as const,
    }));
}

function getSubmissionDocuments(r: LeaveRequest): LeaveDocument[] {
  const resubmissionNotes = (r.notes ?? [])
    .filter((n) => n.type === "RESUBMITTED" && n.attachmentName)
    .slice()
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  if (resubmissionNotes.length > 0) {
    return resubmissionNotes.map((n, index) => ({
      key: n.id,
      label: `Document ${index + 1}`,
      createdAt: n.createdAt,
      mimeType: n.attachmentMimeType,
      data: n.attachmentData,
      name: n.attachmentName,
      kind: "submission" as const,
    }));
  }

  if (r.attachmentName) {
    return [{ key: "current", label: "Document 1", createdAt: r.createdAt, mimeType: r.attachmentMimeType, data: r.attachmentData, name: r.attachmentName, kind: "submission" }];
  }

  return [];
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
  // Same cache key as AttendancePage/SettingsPage, so no extra fetch.
  const profileCache = useCachedData(CACHE_KEYS.myProfile, getMyProfile);
  // Not entitled to leave (e.g. Probationary) = no active leave type lists
  // this employee's employment status — the same check the backend makes on
  // every request. Stays enabled until both the profile and leave types are
  // known, so a slow load never locks out an entitled employee.
  const employmentStatus = profileCache.data?.employmentStatus;
  // Whether this leave type covers the employee's employment status (e.g.
  // Regular-only types are off for a Probationary employee). Unknown = allowed.
  const isLeaveTypeApplicable = (type: LeaveType) =>
    !employmentStatus || !type.applicableStatuses || type.applicableStatuses.includes(employmentStatus);
  const canRequestLeave =
    leaveTypes.length === 0 || leaveTypes.some((type) => type.isActive !== false && isLeaveTypeApplicable(type));
  // A disabled Request tab falls back to Balance, even if it was already open.
  const shownTab: Tab = tab === "request" && !canRequestLeave ? "balance" : tab;
  const balances = balancesCache.data ?? [];
  const requests = requestsCache.data ?? [];
  const undertimeEligibility = undertimeEligibilityCache.data;
  const undertimeFilings = undertimeFilingsCache.data ?? [];
  const mySchedules = mySchedulesCache.data ?? [];
  // Same cache key as the DTR/Attendance pages, so a day the employee just
  // timed in on shows up here as unfilable — see isDateWorked.
  const attendanceCache = useCachedData<AttendanceHistoryRecord[]>(
    user.employeeId ? CACHE_KEYS.attendanceHistory(user.employeeId) : null,
    () => getAttendanceHistory(user.employeeId!),
  );
  const attendanceRecords = attendanceCache.data;
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
    setRequestsStatusFilter("ALL");
    setRequestsDateFrom("");
    setRequestsDateTo("");
    requestsCache.refresh().catch(() => undefined);
  }
  const [resultModal,  setResultModal]   = useState<{ ok: boolean; title: string; msg: string } | null>(null);
  const [maternityPrompt, setMaternityPrompt] = useState<{ maternity: LeaveType; alternatives: LeaveType[] } | null>(null);
  const [focusedRequestId, setFocusedRequestId] = useState<string | null>(null);
  // Cancel is a destructive, irreversible action — clicking Cancel opens this
  // confirm step instead of cancelling immediately. The backend requires a
  // reason (see leave.service.ts's cancel()), so it's collected right here.
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);
  const [cancelReasonText, setCancelReasonText] = useState("");
  // Optional supporting document for a cancellation (see the cancel modal).
  const [cancelFile, setCancelFile] = useState<{ name: string; mimeType: string; sizeBytes: number; base64: string } | null>(null);
  const [cancelFileErr, setCancelFileErr] = useState<string | null>(null);
  const cancelFileRef = useRef<HTMLInputElement>(null);
  // The days ticked for cancellation (local-midnight times) — every day the
  // employee hasn't timed in on, until they untick some to keep them.
  const [cancelDayTimes, setCancelDayTimes] = useState<number[]>([]);
  // The approved Maternity Leave whose 30-day extension is being requested
  // (see the extension modal), and the reason typed for it.
  const [extendTargetId, setExtendTargetId] = useState<string | null>(null);
  const [extendReasonText, setExtendReasonText] = useState("");
  const [isExtending, setIsExtending] = useState(false);

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

  // Undertime filing — a 3-step wizard (pick day -> reason -> review), same
  // shape as the mobile app's LeaveScreen.tsx, each step's Next gated on that
  // step's own requirement.
  const [undertimeReason,      setUndertimeReason]      = useState("");
  const [selectedLateRecordId, setSelectedLateRecordId] = useState<string | null>(null);
  const [isFilingUndertime,    setIsFilingUndertime]    = useState(false);
  const [isSubmittingLeave,    setIsSubmittingLeave]    = useState(false);
  const [undertimeErr,         setUndertimeErr]         = useState<string | null>(null);
  const [undertimeStep,        setUndertimeStep]        = useState<1 | 2 | 3>(1);

  // Filing history — a button + filter modal (status chips, filed-from/to
  // calendar range) instead of an always-inline list, mirroring "My Leave
  // Requests" above and employee-mobile's LeaveScreen.tsx.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyStatusFilter, setHistoryStatusFilter] = useState<"ALL" | "PENDING" | "APPROVED" | "REJECTED">("ALL");
  const [historyDateFrom, setHistoryDateFrom] = useState("");
  const [historyDateTo, setHistoryDateTo] = useState("");
  const [expandedHistoryFilingId, setExpandedHistoryFilingId] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);

  const selectedLateRecordForReview = undertimeEligibility?.lateRecords.find((r) => r.id === selectedLateRecordId) ?? null;

  const visibleHistoryFilings = undertimeFilings.filter((f) => {
    if (historyStatusFilter !== "ALL" && f.status !== historyStatusFilter) return false;
    const recordDate = f.attendanceRecord ? new Date(f.attendanceRecord.attendanceDate) : new Date(f.filingDate);
    if (historyDateFrom) {
      const [y, m, d] = historyDateFrom.split("-").map(Number);
      if (recordDate < new Date(y, m - 1, d)) return false;
    }
    if (historyDateTo) {
      const [y, m, d] = historyDateTo.split("-").map(Number);
      if (recordDate > new Date(y, m - 1, d, 23, 59, 59, 999)) return false;
    }
    return true;
  });
  const expandedHistoryFiling = undertimeFilings.find((f) => f.id === expandedHistoryFilingId) ?? null;
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

  // The status chips only ever filter the tab being viewed (see the
  // requestsListTab checks below), so the other tab's count stays its true
  // total instead of dropping to whatever happens to match this tab's chip.
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
      .filter((r) => requestsListTab !== "current" || matchesStatusFilter(r))
      .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
  }, [requests, requestsDateFrom, requestsDateTo, requestsStatusFilter, requestsListTab]);

  // History — everything not currently active, most-recently-filed first
  // (mirrors admin-web's own Leave History tab).
  const pastRequests = useMemo(() => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    return requests
      .filter((r) => !isCurrentLeaveRequest(r, todayStart))
      .filter(matchesDateFilter)
      .filter((r) => requestsListTab !== "past" || matchesStatusFilter(r))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [requests, requestsDateFrom, requestsDateTo, requestsStatusFilter, requestsListTab]);
  const statusFilterChips: { key: RequestStatusFilter; label: string }[] = [
    { key: "ALL", label: "All" },
    ...STATUS_FILTERS.filter((filter) => STATUS_FILTERS_BY_TAB[requestsListTab].includes(filter.key)),
  ];
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

  // Same rules as the disabled dropdown entries.
  function isLeaveTypeSelectable(t: LeaveType) {
    return (
      isLeaveTypeApplicable(t) &&
      !isLeaveTypeExhausted(t) &&
      !isLeaveTypeAlreadyPending(t) &&
      !leaveTypeUnavailableTodayReason(t)
    );
  }

  // The Vacation Leave, Sick Leave and Leave Without Pay she can still file
  // right now — suggested before Maternity Leave.
  function maternityAlternatives() {
    return MATERNITY_ALTERNATIVES.flatMap(({ name }) =>
      leaveTypes.filter(
        (t) =>
          t.name.trim().toLowerCase() === name &&
          t.isActive &&
          (!t.requiresEhsActivation || t.ehsActivated) &&
          isLeaveTypeSelectable(t),
      ),
    );
  }

  // Picking Maternity Leave first suggests any of its alternatives that are
  // still available; she can switch to one or go ahead with Maternity Leave.
  function chooseLeaveType(t: LeaveType) {
    const alternatives = t.kind === "MATERNITY" ? maternityAlternatives() : [];
    if (alternatives.length > 0) setMaternityPrompt({ maternity: t, alternatives });
    else setLeaveTypeId(t.id);
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
    if (!isLeaveTypeApplicable(type)) {
      setResultModal({
        ok: false,
        title: "Not Entitled to Leave",
        msg: canRequestLeave
          ? `${type.name} isn't available for your employment status.`
          : "Your employment status isn't entitled to leave yet. Leave becomes available once you're a regular employee.",
      });
      return;
    }
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
    const unavailableTodayReason = leaveTypeUnavailableTodayReason(type);
    if (unavailableTodayReason) {
      setResultModal({
        ok: false,
        title: "Unavailable Today",
        msg: type.pastAbsenceFilingAllowed
          ? `${type.name} can only be filed for today or a past day you were absent, but ${unavailableTodayReason} and you have no absences left to file it for.`
          : `${type.name} can only be filed for today's date, but ${unavailableTodayReason}.`,
      });
      return;
    }
    chooseLeaveType(type);
    setTab("request");
  }

  function goToUndertimeStep2() {
    if (!selectedLateRecordId) return;
    setUndertimeStep(2);
  }
  function goToUndertimeStep3() {
    if (!undertimeReason.trim()) return;
    setUndertimeStep(3);
  }
  function goToPreviousUndertimeStep() {
    setUndertimeStep((step) => (step > 1 ? ((step - 1) as 1 | 2) : step));
  }

  async function handleFileUndertime() {
    const trimmedReason = undertimeReason.trim();
    if (!user.employeeId || !selectedLateRecordId || !trimmedReason) return;
    setIsFilingUndertime(true);
    setUndertimeErr(null);
    try {
      await fileUndertime(user.employeeId, selectedLateRecordId, trimmedReason);
      setUndertimeReason("");
      setSelectedLateRecordId(null);
      setUndertimeStep(1);
      await refreshAll();
      setResultModal({ ok: true, title: "Undertime Filed", msg: "Your undertime filing has been submitted for your supervisor's review." });
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
  function handleCancelFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setCancelFileErr(null);
    if (file.size > MAX_BYTES) { setCancelFileErr("File too large — maximum 5 MB."); return; }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const full   = ev.target?.result as string;
      const base64 = full.split(",")[1];
      setCancelFile({ name: file.name, mimeType: file.type || "application/octet-stream", sizeBytes: file.size, base64 });
    };
    reader.readAsDataURL(file);
  }

  function handleCancel(requestId: string, note: string, file: typeof cancelFile, dayTimes: number[]) {
    const target = requests.find((r) => r.id === requestId);
    if (!target) return;
    const newStatus = target.status === "APPROVED" ? "CANCELLATION_PENDING" : "CANCELLED";
    // Only some days picked: the backend splits the leave around them, so
    // the list only settles after the refresh below — no optimistic flip.
    const partial = dayTimes.length < leaveDaysOf(target).length;
    const dayLabel = `${dayTimes.length} day${dayTimes.length === 1 ? "" : "s"}`;

    if (!partial) {
      requestsCache.setData(requests.map((r) => (r.id === requestId ? { ...r, status: newStatus } : r)));
    }
    setResultModal({
      ok: true,
      title: newStatus === "CANCELLATION_PENDING" ? "Cancellation Requested" : "Leave Request Cancelled",
      msg:
        newStatus === "CANCELLATION_PENDING"
          ? `Your supervisor has been notified and will need to approve this cancellation${partial ? ` of ${dayLabel}` : ""}.`
          : partial
            ? `${dayLabel} of this leave ${dayTimes.length === 1 ? "has" : "have"} been cancelled.`
            : "This leave request has been cancelled.",
    });

    cancelLeaveRequest(
      requestId,
      note,
      file ? { attachmentName: file.name, attachmentMimeType: file.mimeType, attachmentData: file.base64 } : undefined,
      partial ? dayTimes.map((time) => new Date(time).toISOString()) : undefined,
    )
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

  // Not optimistic, unlike handleCancel — the extension is a brand-new
  // request the server creates (and may refuse, e.g. past the 45-day
  // deadline or overlapping another leave), so the modal waits for it.
  async function handleExtend(requestId: string, reason: string) {
    setIsExtending(true);
    try {
      await requestLeaveExtension(requestId, reason);
      await requestsCache.refresh();
      setExtendTargetId(null);
      setResultModal({
        ok: true,
        title: "Extension Requested",
        msg: "Your supervisor has been notified and will need to approve your 30-day extension.",
      });
    } catch (err) {
      setExtendTargetId(null);
      requestsCache.refresh().catch(() => undefined);
      setResultModal({
        ok: false,
        title: "Extension Not Requested",
        msg: err instanceof Error ? err.message : "Unable to request an extension for this leave.",
      });
    } finally {
      setIsExtending(false);
    }
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

  // Date ranges already filed (any non-cancelled/rejected status) under any
  // leave type — the calendar disables every individual day within them,
  // and handleSubmit's overlap check (mirroring the backend) is the
  // authoritative backstop regardless of what the UI shows.
  const blockedRanges = useMemo(() => {
    return requests
      .filter((r) => BLOCKING_LEAVE_STATUSES.includes(r.status))
      .map((r) => ({
        start: new Date(new Date(r.startDate).getFullYear(), new Date(r.startDate).getMonth(), new Date(r.startDate).getDate()),
        end: new Date(new Date(r.endDate).getFullYear(), new Date(r.endDate).getMonth(), new Date(r.endDate).getDate()),
        leaveTypeName: r.leaveType.name,
      }));
  }, [requests]);

  function isDateAlreadyFiled(date: Date) {
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const hit = blockedRanges.find((range) => day >= range.start && day <= range.end);
    return hit ? `Already filed (${hit.leaveTypeName})` : undefined;
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

  // A day the employee already timed in can't become a leave day — mirrors
  // the backend's check in leave.service.ts (create + approve) and
  // employee-mobile's LeaveScreen.tsx.
  const workedDayKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const record of attendanceRecords ?? []) {
      if (!record.timeInAt) continue;
      const d = new Date(record.attendanceDate);
      keys.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
    }
    return keys;
  }, [attendanceRecords]);

  function isDateWorked(date: Date) {
    return workedDayKeys.has(`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`)
      ? "You already have attendance on this day"
      : undefined;
  }

  // Past days the DTR shows as ABSENT — the history endpoint's synthetic rows:
  // a scheduled working day with no time-in and no leave covering it. A
  // pastAbsenceFilingAllowed type (Sick Leave) can be filed for any of these
  // on top of today — mirrors the backend's isAbsentDay (leave.service.ts)
  // and employee-mobile's LeaveScreen.tsx.
  const pastAbsentDayKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const record of attendanceRecords ?? []) {
      if (record.status !== "ABSENT") continue;
      const d = new Date(record.attendanceDate);
      if (d >= todayStart) continue;
      keys.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
    }
    return keys;
  }, [attendanceRecords, todayStart]);

  // Greys out every past day that isn't an absence, for a type that can only
  // be backfiled onto one.
  function isPastNonAbsence(date: Date) {
    return date < todayStart && !pastAbsentDayKeys.has(`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`);
  }

  function todayUnfileableReason() {
    if (isDateNonWorking(todayStart)) return "today is your day off / a non-working day";
    if (isDateWorked(todayStart)) return "you already have attendance today";
    return undefined;
  }

  // A !advanceFilingAllowed type (Sick Leave, Emergency Leave, Adverse
  // Weather Leave) can only ever be filed for today — so if today happens to
  // be this employee's day off, or they already timed in today, the type is
  // entirely unfilable right now, not just on some dates. Surfaced up front
  // (dropdown + Date section) instead of only failing at submit time. A
  // pastAbsenceFilingAllowed type stays available while there's a past
  // absence left to file it for.
  function leaveTypeUnavailableTodayReason(t: LeaveType) {
    if (t.advanceFilingAllowed !== false) return undefined;
    if (t.pastAbsenceFilingAllowed && pastAbsentDayKeys.size > 0) return undefined;
    return todayUnfileableReason();
  }

  // pastAbsenceFilingAllowed also opens past days the employee was absent
  // on. Sick Leave (today-only) becomes "today or a past absence", still
  // never a future date; Compassionate Leave (advance filing allowed) keeps
  // today/future and gains past absences on top.
  const allowsPastAbsence = selectedType?.pastAbsenceFilingAllowed === true;
  // Sick Leave is picked as a Start–End range like any other leave type,
  // but filed as one single-day request per working day in it (today and/or
  // past absences) — see sickLeaveDaysInRange and createLeaveRequests.
  // Mirrors employee-mobile's LeaveScreen.tsx.
  const multiDate =
    selectedType?.advanceFilingAllowed === false && allowsPastAbsence && Boolean(selectedType?.isSingleDayOnly);

  // The working days ("YYYY-MM-DD") of Sick Leave's Start–End range — each
  // becomes its own one-day request. Days off inside the range are skipped
  // rather than filed.
  function sickLeaveDaysInRange() {
    if (!startDate || !endDate) return [];
    const [sy, sm, sd] = startDate.split("-").map(Number);
    const [ey, em, ed] = endDate.split("-").map(Number);
    const end = new Date(ey, em - 1, ed);
    const days: string[] = [];
    for (let d = new Date(sy, sm - 1, sd); d <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
      if (isDateNonWorking(d)) continue;
      days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
    }
    return days;
  }
  const filingDays = multiDate ? sickLeaveDaysInRange().length : totalDays;

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
  // Sick/Compassionate Leave (allowsPastAbsence) also open past days, but
  // only the ones the employee was absent on (isPastNonAbsence greys out the
  // rest).
  const minStartDate = useMemo(() => {
    if (selectedType?.advanceFilingAllowed === false) {
      return selectedType.isSingleDayOnly && !allowsPastAbsence ? maxStartDate : undefined;
    }
    return allowsPastAbsence ? undefined : new Date().toISOString().slice(0, 10);
  }, [selectedType, maxStartDate, allowsPastAbsence]);

  // Single-day-only types (Emergency Leave) always mirror the end date to the
  // start date the moment either one is known. Sick Leave (multiDate) has its
  // own end date, which just defaults to the start date until one is picked.
  useEffect(() => {
    if (!startDate) return;
    if (selectedType?.isSingleDayOnly && !multiDate) setEndDate(startDate);
    else if (multiDate && (!endDate || endDate < startDate)) setEndDate(startDate);
  }, [selectedType?.isSingleDayOnly, multiDate, startDate]);

  // Clamp a previously-picked end date if switching leave type (or the
  // remaining balance) shrinks the allowed range below it.
  useEffect(() => {
    if (!maxEndDate || !endDate) return;
    if (endDate > maxEndDate) setEndDate(maxEndDate);
  }, [maxEndDate]);

  const isDocumentRequired =
    Boolean(selectedType?.requiresDocument) &&
    (selectedType?.supportingDocumentAfterDays == null || filingDays >= selectedType.supportingDocumentAfterDays);

  function resetForm() {
    setLeaveTypeId("");
    setReason("");
    setStartDate("");
    setEndDate("");
    setAttachment(null);
    setAttachErr(null);
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
    const sickLeaveDays = multiDate ? sickLeaveDaysInRange() : [];
    if (multiDate && sickLeaveDays.length === 0) {
      setResultModal({ ok: false, title: "Select Dates", msg: "Every day in that range is a day off. Please pick working days." });
      return;
    }
    // Each working day of a Sick Leave range is its own one-day request, so
    // each one goes through the same checks a single request would.
    const filingRanges = multiDate
      ? sickLeaveDays.map((iso) => {
          const [y, m, d] = iso.split("-").map(Number);
          return { start: new Date(y, m - 1, d), end: new Date(y, m - 1, d) };
        })
      : [{ start: new Date(startDate), end: new Date(endDate) }];
    for (const { start: requestedStart, end: requestedEnd } of filingRanges) {
      // Mirrors the backend's own-day-off check (leave.service.ts) — catches
      // dates set outside the calendar's disabled-day styling.
      const nonWorkingBoundary = isDateNonWorking(requestedStart)
        ? requestedStart
        : isDateNonWorking(requestedEnd)
          ? requestedEnd
          : null;
      if (nonWorkingBoundary) {
        setResultModal({
          ok: false,
          title: "Non-Working Day",
          msg: `${nonWorkingBoundary.toLocaleDateString()} is your day off / a non-working day. Leave can only be filed for a working day.`,
        });
        return;
      }
      // Mirrors the backend's worked-day check (leave.service.ts) — catches a
      // range that spans a worked day, or today on a locked-to-today type.
      for (
        let d = new Date(requestedStart.getFullYear(), requestedStart.getMonth(), requestedStart.getDate());
        d <= requestedEnd;
        d.setDate(d.getDate() + 1)
      ) {
        if (isDateWorked(d)) {
          setResultModal({
            ok: false,
            title: "Already Worked",
            msg: `You already have attendance on ${d.toLocaleDateString()}. Leave can't be filed for a day you worked.`,
          });
          return;
        }
      }
      // A past start date must be one the employee was absent on — mirrors
      // the backend's isAbsentDay.
      if (allowsPastAbsence && isPastNonAbsence(requestedStart)) {
        setResultModal({
          ok: false,
          title: "Not an Absence",
          msg: `${requestedStart.toLocaleDateString()} isn't an absence on your record. ${selectedType?.name} can only be filed for a past day you were absent.`,
        });
        return;
      }
      // Any date already covered by another filed request — any leave type,
      // pending or approved — is off-limits until that request is rejected or
      // cancelled. Mirrors the backend's check in leave.service.ts.
      const overlapping = requests.find(
        (r) =>
          BLOCKING_LEAVE_STATUSES.includes(r.status) &&
          new Date(r.startDate) <= requestedEnd &&
          new Date(r.endDate) >= requestedStart,
      );
      if (overlapping) {
        const filedAs =
          overlapping.status === "APPROVED" || overlapping.status === "CANCELLATION_PENDING" ? "approved" : "pending";
        setResultModal({
          ok: false,
          title: "Dates Unavailable",
          msg: `These dates overlap your ${filedAs} ${overlapping.leaveType.name} (${new Date(overlapping.startDate).toLocaleDateString()} - ${new Date(overlapping.endDate).toLocaleDateString()}). Cancel that request first if you need to change it.`,
        });
        return;
      }
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
      if (filingDays > remainingDays) {
        setResultModal({ ok: false, title: "Insufficient Balance", msg: `You have ${remainingDays} day(s) of ${selectedType.name} left, but requested ${filingDays}.` });
        return;
      }
    }

    // The checks above only mirror the backend using whatever is cached
    // locally (e.g. attendance history), so the server still has the final
    // say — wait for it before telling the employee it went through.
    const shared = {
      employeeId:         user.employeeId,
      leaveTypeId,
      reason:             reason.trim(),
      attachmentName:     attachment?.name,
      attachmentMimeType: attachment?.mimeType,
      attachmentData:     attachment?.base64,
    };

    setIsSubmittingLeave(true);
    try {
      if (multiDate) {
        await createLeaveRequests({ ...shared, dates: sickLeaveDays.map((d) => new Date(d).toISOString()) });
      } else {
        await createLeaveRequest({
          ...shared,
          startDate:          new Date(startDate).toISOString(),
          endDate:            new Date(endDate).toISOString(),
          totalDays,
        });
      }
      resetForm();
      setResultModal({ ok: true, title: "Leave Request Submitted", msg: "Your HR/Admin and supervisor have been notified. You'll be informed once it's reviewed." });
      // Only `requests` actually changed (the new request itself) — balances
      // don't move until this is approved, and leave types/undertime are
      // untouched by filing a leave request, so this doesn't refetch them.
      requestsCache.refresh().catch(() => undefined);
    } catch (err) {
      // Form is left filled in so the employee can adjust and retry.
      setResultModal({
        ok: false,
        title: "Leave Request Failed",
        msg: err instanceof Error ? err.message : "Your leave request did not go through. Please try again.",
      });
    } finally {
      setIsSubmittingLeave(false);
    }
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
          background: "#F8FAFC", border: "1px solid #E2E8F0", borderLeft: `4px solid ${tone.color}`, borderRadius: 14,
          padding: 14, marginBottom: 10, cursor: "pointer",
          boxShadow: "0 2px 6px rgba(11, 28, 51, 0.05)",
          transition: "background 0.15s ease",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "#EEF2F7"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "#F8FAFC"; }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
          <p style={{ fontWeight: 700, margin: 0, flex: 1, minWidth: 0 }}>
            {leaveRequestTitle(r)}
          </p>
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0,
            background: tone.bg, color: tone.color,
            fontWeight: 700, fontSize: 10,
            borderRadius: 999, padding: "4px 9px",
            ...STATUS_PILL_SIZE,
          }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: tone.color, flexShrink: 0 }} />
            {statusLabel(r.status, r.lapseReason)}
          </span>
        </div>
        <p style={{ display: "flex", alignItems: "center", gap: 6, color: "#64748B", fontWeight: 600, fontSize: 13, margin: "8px 0 0" }}>
          <Calendar size={13} color="#94A3B8" />
          {new Date(r.startDate).toLocaleDateString()} – {new Date(r.endDate).toLocaleDateString()}
        </p>
      </button>
    );
  }

  function renderRequestCard(r: LeaveRequest) {
    const needsRevision = r.status === "NEEDS_REVISION";
    const canShowCancelSection =
      !needsRevision && (r.status === "PENDING" || r.status === "SUPERVISOR_APPROVED" || r.status === "APPROVED");
    // Server-computed (see getCancellationEligibility in leave.service.ts) —
    // covers "not yet timed in on the leave's days" and the leave type's
    // cancellationAllowed flag
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
        <LeaveTimeline
          history={r.history}
          status={r.status}
          documents={getRequestDocuments(r).map((doc) => {
            const src = attachmentSrc(doc.mimeType, doc.data);
            return {
              label: doc.label,
              createdAt: doc.createdAt,
              kind: doc.kind,
              onPress: () => src && setPreviewAttachment({ src, name: doc.label, mimeType: doc.mimeType! }),
            };
          })}
        />

        {r.extension && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #E2E8F0" }}>
            <button
              onClick={() => {
                setExtendTargetId(r.id);
                setExtendReasonText("");
              }}
              disabled={!r.extension.allowed}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
                width: "100%", borderRadius: 10, padding: "10px 12px",
                fontWeight: 700, fontSize: 13,
                ...(r.extension.allowed
                  ? { border: "1px solid #BFDBFE", background: "#EFF6FF", color: "#1680D8", cursor: "pointer" }
                  : { border: "1px solid #E2E8F0", background: "#F8FAFC", color: "#94A3B8", cursor: "not-allowed" }),
              }}
            >
              <CalendarClock size={15} />
              Request 30-Day Extension
            </button>
            {r.extension.allowed ? (
              <p style={{ color: "#64748B", fontSize: 11.5, lineHeight: "16px", margin: "8px 0 0" }}>
                Without pay, for {new Date(r.extension.startDate).toLocaleDateString()} – {new Date(r.extension.endDate).toLocaleDateString()}.
                Must be requested by {new Date(r.extension.deadline).toLocaleDateString()} (45 days before your leave ends).
              </p>
            ) : r.extension.reason && (
              <div style={{
                display: "flex", alignItems: "flex-start", gap: 6, marginTop: 8,
                background: "#FFFBEB", border: "1px solid #FEF3C7", borderRadius: 8, padding: "8px 10px",
              }}>
                <AlertCircle size={13} color="#92400E" style={{ flexShrink: 0, marginTop: 1 }} />
                <p style={{ color: "#92400E", fontSize: 11.5, lineHeight: "16px", margin: 0 }}>{r.extension.reason}</p>
              </div>
            )}
          </div>
        )}

        {canShowCancelSection && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #E2E8F0" }}>
            <button
              onClick={() => {
                const worked = workedDayTimes(r);
                setConfirmCancelId(r.id);
                setCancelReasonText("");
                setCancelFile(null);
                setCancelFileErr(null);
                setCancelDayTimes(leaveDaysOf(r).map((d) => d.getTime()).filter((t) => !worked.has(t)));
              }}
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

      {/* Tab switcher */}
      <SegmentedControl
        segments={[
          { key: "balance", label: "Balance" },
          { key: "request", label: "Request", disabled: !canRequestLeave },
          { key: "undertime", label: "Undertime" },
        ]}
        value={shownTab}
        onChange={(key) => setTab(key as Tab)}
        style={{ marginBottom: canRequestLeave ? 16 : 8 }}
      />
      {!canRequestLeave && (
        <p style={{ margin: "0 0 16px", color: "#64748B", fontSize: 13, textAlign: "center" }}>
          You are not entitled to leave yet, so leave requests are unavailable.
        </p>
      )}

      {/* ── Balance tab ──────────────────────────────────────────────────────── */}
      {shownTab === "balance" && (
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
      {shownTab === "request" && (
        <div style={{ background: "#FFFFFF", borderRadius: 18, border: "1px solid #E2E8F0", padding: 20, boxShadow: "var(--emp-shadow-card)" }}>
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
                          const notApplicable = !isLeaveTypeApplicable(t);
                          const exhausted = !notApplicable && isLeaveTypeExhausted(t);
                          const alreadyPending = !notApplicable && isLeaveTypeAlreadyPending(t);
                          const unavailableToday =
                            !notApplicable && !exhausted && !alreadyPending ? leaveTypeUnavailableTodayReason(t) : undefined;
                          const disabled = notApplicable || exhausted || alreadyPending || Boolean(unavailableToday);
                          return (
                            <button
                              key={t.id}
                              disabled={disabled}
                              onClick={() => { chooseLeaveType(t); setDropOpen(false); setSearchLeave(""); }}
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
                              {notApplicable
                                ? " (regular employees only)"
                                : exhausted
                                ? t.requiresAdminGrant
                                  ? " (apply to HR/Admin first)"
                                  : " (no balance left)"
                                : alreadyPending
                                  ? " (already pending)"
                                  : unavailableToday
                                    ? isDateNonWorking(todayStart)
                                      ? " (today is a non-working day)"
                                      : " (already timed in today)"
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
            <label style={fldLbl}>
              {multiDate || !selectedType?.isSingleDayOnly ? "Leave Duration" : "Date"}
            </label>
            {selectedType?.isSingleDayOnly && !multiDate ? (
              <CalendarPicker
                value={startDate}
                onChange={setStartDate}
                min={minStartDate}
                max={maxStartDate}
                isDateDisabled={isDateAlreadyFiled}
                isDateNonWorking={isDateNonWorking}
                isDateWorked={isDateWorked}
                isDateOutOfRange={allowsPastAbsence ? isPastNonAbsence : undefined}
              />
            ) : (
              <div style={{ display: "flex", gap: 10 }}>
                <CalendarPicker
                  value={startDate}
                  onChange={setStartDate}
                  min={minStartDate}
                  max={maxStartDate}
                  isDateDisabled={isDateAlreadyFiled}
                  isDateNonWorking={isDateNonWorking}
                  isDateWorked={isDateWorked}
                  isDateOutOfRange={allowsPastAbsence ? isPastNonAbsence : undefined}
                  placeholder="Start date"
                />
                <CalendarPicker
                  value={endDate}
                  onChange={setEndDate}
                  min={startDate || minStartDate}
                  // Sick Leave's range can't run past today either.
                  max={multiDate && maxStartDate && (!maxEndDate || maxEndDate > maxStartDate) ? maxStartDate : maxEndDate}
                  isDateDisabled={isDateAlreadyFiled}
                  isDateNonWorking={isDateNonWorking}
                  isDateWorked={isDateWorked}
                  isDateOutOfRange={allowsPastAbsence ? isPastNonAbsence : undefined}
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
            {selectedType && selectedType.advanceFilingAllowed === false && allowsPastAbsence && todayUnfileableReason() && (
              <p style={{ fontSize: 11.5, fontWeight: 600, color: "#B45309", margin: "4px 0 0" }}>
                {`${todayUnfileableReason()!.replace(/^./, (c) => c.toUpperCase())} — pick the past days you were absent instead.`}
              </p>
            )}
            {selectedType && selectedType.advanceFilingAllowed === false && !allowsPastAbsence && isDateNonWorking(todayStart) && (
              <p style={{ fontSize: 11.5, fontWeight: 600, color: "#B45309", margin: "4px 0 0" }}>
                Today is your day off / a non-working day — {selectedType.name} can't be filed until your next working day.
              </p>
            )}
            {selectedType && selectedType.advanceFilingAllowed === false && !allowsPastAbsence && !isDateNonWorking(todayStart) && isDateWorked(todayStart) && (
              <p style={{ fontSize: 11.5, fontWeight: 600, color: "#B45309", margin: "4px 0 0" }}>
                You already have attendance today — {selectedType.name} can't be filed for a day you worked.
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
              {requiredDocumentFor(selectedType?.name) && (
                <span style={{ marginLeft: 8, fontSize: 11.5, fontWeight: 600, color: "#B45309" }}>
                  Note: Please attach a {requiredDocumentFor(selectedType?.name)}.
                </span>
              )}
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

            <button
              onClick={handleSubmit}
              disabled={isSubmittingLeave}
              style={{ ...primBtn, marginTop: 16, opacity: isSubmittingLeave ? 0.6 : 1, cursor: isSubmittingLeave ? "not-allowed" : "pointer" }}
            >
              {isSubmittingLeave ? "Submitting…" : "Submit Leave Request"}
            </button>
        </div>
      )}

      {/* ── Undertime tab ────────────────────────────────────────────────────── */}
      {shownTab === "undertime" && (
        <div style={{ background: "#FFFFFF", borderRadius: 18, border: "1px solid #E2E8F0", padding: 20, boxShadow: "var(--emp-shadow-card)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <div style={{ width: 28, height: 28, borderRadius: 8, background: "#CCFBF1", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <Timer size={16} color="#0D9488" />
            </div>
            <h3 style={{ color: "#062B59", fontSize: 18, fontWeight: 700, margin: 0 }}>File Undertime</h3>
          </div>

          {/* Everything here mirrors whatever the backend's eligibility check
              returns — the 8th/23rd filing days and the cutoff dates are not
              hardcoded on this page, only reflected from the API. */}
          {undertimeEligibility && (
            <p style={{ color: "#475569", fontSize: 13, marginTop: 0, marginBottom: 14, lineHeight: "18px" }}>
              <Calendar size={11} color="#94A3B8" style={{ verticalAlign: -1 }} />{" "}
              <strong style={{ color: "#334155", fontWeight: 700 }}>Cutoff</strong>:{" "}
              <strong style={{ color: "#0F172A", fontWeight: 600 }}>
                {new Date(undertimeEligibility.targetCutoff.start).toLocaleDateString()} – {new Date(undertimeEligibility.targetCutoff.end).toLocaleDateString()}
              </strong>
              .{" "}
              {!undertimeEligibility.isFilingDay ? (
                <>
                  Undertime can only be filed on the{" "}
                  <strong style={{ color: "#1680D8", fontWeight: 700 }}>
                    {ordinalDaysOfMonth(undertimeEligibility.filingDaysOfMonth)}
                  </strong>{" "}
                  of the month.
                </>
              ) : undertimeEligibility.existingFiling ? (
                "You've already filed undertime for this cutoff."
              ) : undertimeEligibility.lateRecords.length === 0 ? (
                <>
                  You have no late or early time-out attendance within this cutoff to file. Undertime can be filed on the{" "}
                  <strong style={{ color: "#1680D8", fontWeight: 700 }}>
                    {ordinalDaysOfMonth(undertimeEligibility.filingDaysOfMonth)}
                  </strong>{" "}
                  of the month.
                </>
              ) : (
                "Select one late or early time-out day below to file undertime for this cutoff."
              )}
            </p>
          )}

          {/* Fixed height, regardless of state — the card must never resize
              as the wizard moves between steps, resolves to a locked state,
              or has nothing to show. */}
          <div style={{ height: 310, overflow: "hidden", marginTop: 4 }}>
            {!undertimeEligibility ? null : undertimeEligibility.existingFiling ? (
              (() => {
                const filing = undertimeEligibility.existingFiling;
                const lockedTone =
                  filing.status === "APPROVED"
                    ? { bg: "#DCFCE7", color: "#15803D", title: "Approved for this cutoff" }
                    : filing.status === "REJECTED"
                      ? { bg: "#FEE2E2", color: "#B91C1C", title: "Rejected for this cutoff" }
                      : { bg: "#FEF3C7", color: "#B45309", title: "Awaiting your supervisor's review" };
                const lockedBody =
                  filing.status === "PENDING"
                    ? "This card will unlock again once the next filing window opens."
                    : `One filing is allowed per cutoff. You can file again once the next filing window opens — the ${ordinalDaysOfMonth(undertimeEligibility.filingDaysOfMonth)} of the month.`;
                return (
                  <div style={{ height: "100%" }}>
                    <div style={{ borderRadius: 12, padding: 10, background: lockedTone.bg }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <LockIcon size={16} color={lockedTone.color} />
                        <span style={{ fontSize: 12.5, fontWeight: 700, color: lockedTone.color }}>{lockedTone.title}</span>
                      </div>
                      <p style={{ fontSize: 11.5, color: lockedTone.color, margin: "4px 0 0", lineHeight: "15px" }}>{lockedBody}</p>
                      {filing.status === "REJECTED" && filing.remarks && (
                        <p style={{ fontSize: 11, color: lockedTone.color, margin: "4px 0 0", fontStyle: "italic" }}>Remarks: {filing.remarks}</p>
                      )}
                    </div>
                    {/* Frozen preview of the same wizard chrome (progress
                        steps + review card + button), dimmed and
                        non-interactive — this is "the filing UI," just
                        disabled, not a different, simplified summary. */}
                    <div style={{ opacity: 0.45, pointerEvents: "none" }}>
                      <div style={{ display: "flex", alignItems: "center", marginTop: 10, marginBottom: 4 }}>
                        {(["Pick Day", "Reason", "Review"] as const).map((label, index) => (
                          <div key={label} style={{ display: "flex", alignItems: "center", flex: index < 2 ? 1 : undefined }}>
                            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 64 }}>
                              <div style={{ width: 28, height: 28, borderRadius: 999, display: "flex", alignItems: "center", justifyContent: "center", background: "#062B59" }}>
                                <Check size={14} color="#FFFFFF" />
                              </div>
                              <span style={{ fontSize: 10, fontWeight: 700, marginTop: 5, textAlign: "center", color: "#062B59" }}>{label.toUpperCase()}</span>
                            </div>
                            {index < 2 && <div style={{ flex: 1, height: 2, marginBottom: 15, background: "#062B59" }} />}
                          </div>
                        ))}
                      </div>
                      <p style={{ color: "#062B59", fontSize: 14, fontWeight: 700, margin: "8px 0 6px" }}>Review</p>
                      <div style={{ border: "1px solid #E2E8F0", background: "#F8FAFC", borderRadius: 14, padding: 12 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, borderBottom: "1px solid #E2E8F0", marginBottom: 8, paddingBottom: 8 }}>
                          <span style={{ fontSize: 12, color: "#64748B", fontWeight: 600 }}>Late Day</span>
                          <span style={{ fontSize: 12, color: "#334155", fontWeight: 700 }}>
                            {filing.attendanceRecord
                              ? `${new Date(filing.attendanceRecord.attendanceDate).toLocaleDateString()} (${minutesLabel(filedMinutes(filing.attendanceRecord))})`
                              : "—"}
                          </span>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                          <span style={{ fontSize: 12, color: "#64748B", fontWeight: 600, whiteSpace: "nowrap" }}>Reason</span>
                          <span style={{ fontSize: 12, color: "#334155", fontWeight: 700, textAlign: "right" }}>{filing.reason ?? "—"}</span>
                        </div>
                      </div>
                      <button style={{ ...primBtn, marginTop: 16, background: "#94A3B8", cursor: "not-allowed" }}>Submit</button>
                    </div>
                  </div>
                );
              })()
            ) : undertimeEligibility.isFilingDay && undertimeEligibility.lateRecords.length > 0 ? (
              <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
                {/* Progress indicator */}
                <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
                  {(["Pick Day", "Reason", "Review"] as const).map((label, index) => {
                    const stepNumber = (index + 1) as 1 | 2 | 3;
                    const done = stepNumber < undertimeStep;
                    const current = stepNumber === undertimeStep;
                    return (
                      <div key={label} style={{ display: "flex", alignItems: "center", flex: stepNumber < 3 ? 1 : undefined }}>
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 64 }}>
                          <div
                            style={{
                              width: 28, height: 28, borderRadius: 999, display: "flex", alignItems: "center", justifyContent: "center",
                              background: done ? "#062B59" : current ? "#DC2777" : "#F1F5F9",
                            }}
                          >
                            {done ? (
                              <Check size={14} color="#FFFFFF" />
                            ) : (
                              <span style={{ fontSize: 13, fontWeight: 700, color: current ? "#FFFFFF" : "#94A3B8" }}>{stepNumber}</span>
                            )}
                          </div>
                          <span style={{ fontSize: 10, fontWeight: 700, marginTop: 5, textAlign: "center", color: done ? "#062B59" : current ? "#DC2777" : "#94A3B8" }}>
                            {label.toUpperCase()}
                          </span>
                        </div>
                        {stepNumber < 3 && (
                          <div style={{ flex: 1, height: 2, marginBottom: 15, background: stepNumber < undertimeStep ? "#062B59" : "#E2E8F0" }} />
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Each step fills the remaining height and pins its action
                    row to the bottom, so Next/Back/Submit sits at the same
                    vertical position across all three steps. */}
                <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
                  {undertimeStep === 1 && (
                    <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
                      <div style={{ flex: 1 }}>
                        <p style={{ color: "#062B59", fontSize: 15, fontWeight: 700, margin: "8px 0 6px" }}>Pick Your Late Day</p>
                        {undertimeEligibility.lateRecords.map((record) => {
                          const selected = selectedLateRecordId === record.id;
                          return (
                            <div
                              key={record.id}
                              onClick={() => setSelectedLateRecordId(record.id)}
                              style={{
                                display: "flex", alignItems: "center", justifyContent: "space-between",
                                padding: "10px 12px", borderRadius: 10, marginBottom: 6, cursor: "pointer",
                                border: `1px solid ${selected ? "#DC2777" : "#E2E8F0"}`,
                                background: selected ? "#FCE7F3" : "#FFFFFF",
                              }}
                            >
                              <span style={{ fontSize: 13, color: "#334155", fontWeight: selected ? 700 : 400 }}>
                                {new Date(record.attendanceDate).toLocaleDateString()} — {lateMinutesLabel(filedMinutes(record))}
                              </span>
                              {selected && <CheckCircle size={16} color="#DC2777" />}
                            </div>
                          );
                        })}
                      </div>
                      <button
                        disabled={!selectedLateRecordId}
                        onClick={goToUndertimeStep2}
                        style={{ ...primBtn, opacity: !selectedLateRecordId ? 0.6 : 1, cursor: !selectedLateRecordId ? "not-allowed" : "pointer" }}
                      >
                        Next
                      </button>
                    </div>
                  )}

                  {undertimeStep === 2 && (
                    <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
                      <div style={{ flex: 1 }}>
                        <p style={{ color: "#062B59", fontSize: 15, fontWeight: 700, margin: "8px 0 6px" }}>Add a Reason</p>
                        {selectedLateRecordForReview && (
                          <p style={{ color: "#64748B", fontSize: 13, margin: "0 0 10px" }}>
                            {new Date(selectedLateRecordForReview.attendanceDate).toLocaleDateString()} — {lateMinutesLabel(filedMinutes(selectedLateRecordForReview))}
                          </p>
                        )}
                        <label style={{ ...fldLbl, display: "inline-flex", alignItems: "baseline", gap: 4 }}>
                          Reason <span style={{ color: "#DC2626", fontWeight: 700 }}>*</span>
                        </label>
                        <textarea
                          value={undertimeReason}
                          onChange={(e) => setUndertimeReason(e.target.value)}
                          placeholder="Why are you filing undertime for this day?"
                          style={{ ...dateInp, height: 90, resize: "vertical", width: "100%", boxSizing: "border-box" }}
                        />
                        {undertimeErr && (
                          <p style={{ color: "#DC2626", fontSize: 12, marginTop: 8 }}>{undertimeErr}</p>
                        )}
                      </div>
                      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                        <button onClick={goToPreviousUndertimeStep} style={{ ...outlineBtn, flex: 1, width: "auto" }}>
                          Back
                        </button>
                        <button
                          disabled={!undertimeReason.trim()}
                          onClick={goToUndertimeStep3}
                          style={{ ...primBtn, flex: 1, width: "auto", opacity: !undertimeReason.trim() ? 0.6 : 1, cursor: !undertimeReason.trim() ? "not-allowed" : "pointer" }}
                        >
                          Next
                        </button>
                      </div>
                    </div>
                  )}

                  {undertimeStep === 3 && selectedLateRecordForReview && (
                    <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
                      <div style={{ flex: 1 }}>
                        <p style={{ color: "#062B59", fontSize: 15, fontWeight: 700, margin: "8px 0 10px" }}>Review &amp; Submit</p>
                        <div style={{ background: "#FDF2F8", border: "1px solid #FBCFE8", borderRadius: 14, padding: 14 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, borderBottom: "1px solid #FBCFE8", marginBottom: 8, paddingBottom: 8 }}>
                            <span style={{ fontSize: 12, color: "#9D174D", fontWeight: 600 }}>Late Day</span>
                            <span style={{ fontSize: 12, color: "#831843", fontWeight: 700 }}>
                              {new Date(selectedLateRecordForReview.attendanceDate).toLocaleDateString()} ({minutesLabel(filedMinutes(selectedLateRecordForReview))})
                            </span>
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                            <span style={{ fontSize: 12, color: "#9D174D", fontWeight: 600, whiteSpace: "nowrap" }}>Reason</span>
                            <span style={{ fontSize: 12, color: "#831843", fontWeight: 700, textAlign: "right" }}>{undertimeReason}</span>
                          </div>
                        </div>
                        {undertimeErr && (
                          <p style={{ color: "#DC2626", fontSize: 12, marginTop: 8 }}>{undertimeErr}</p>
                        )}
                      </div>
                      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                        <button onClick={goToPreviousUndertimeStep} disabled={isFilingUndertime} style={{ ...outlineBtn, flex: 1, width: "auto" }}>
                          Back
                        </button>
                        <button
                          disabled={isFilingUndertime}
                          onClick={handleFileUndertime}
                          style={{ ...primBtn, flex: 1, width: "auto", opacity: isFilingUndertime ? 0.6 : 1, cursor: isFilingUndertime ? "not-allowed" : "pointer" }}
                        >
                          {isFilingUndertime ? "Filing…" : "Submit"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                <CalendarClock size={28} color="#CBD5E1" />
                <p style={{ color: "#94A3B8", fontSize: 13, marginTop: 8 }}>Nothing to file right now.</p>
              </div>
            )}
          </div>

          <button
            onClick={() => setHistoryOpen(true)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6, width: "100%",
              background: "#F8FAFF", border: "1px solid #BFDBFE", borderRadius: 10, padding: "10px 0",
              marginTop: 20, cursor: "pointer", color: "#1680D8", fontSize: 12, fontWeight: 700,
            }}
          >
            <Calendar size={14} color="#1680D8" /> View My Undertime Request
          </button>
        </div>
      )}

      {/* ── Undertime filing history modal ──────────────────────────────────── */}
      {historyOpen && (
        <div style={overlayNoBg}>
          <div className="emp-scroll-thin" style={modalCardFloating}>
            {expandedHistoryFiling ? (
              <>
                <button
                  type="button"
                  onClick={() => setExpandedHistoryFilingId(null)}
                  style={{
                    display: "flex", alignItems: "center", gap: 4,
                    border: "none", background: "none", cursor: "pointer",
                    padding: 0, marginBottom: 10,
                    color: "#1680D8", fontWeight: 700, fontSize: 13,
                  }}
                >
                  <ChevronLeft size={16} color="#1680D8" />
                  All filings
                </button>
                <h3 style={{ color: "#062B59", fontWeight: 700, marginBottom: 14 }}>Undertime Filing Details</h3>
                {(() => {
                  const filing = expandedHistoryFiling;
                  const tone = statusTone(filing.status);
                  const steps = buildUndertimeTimelineSteps(filing);
                  return (
                    <div style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 12, padding: 14 }}>
                      <p style={{ fontWeight: 700, margin: "0 0 3px", color: "#062B59" }}>
                        {filing.attendanceRecord ? lateMinutesLabel(filedMinutes(filing.attendanceRecord)) : "Undertime"}
                      </p>
                      <p style={{ color: "#475569", fontSize: 13, margin: "0 0 8px" }}>
                        {new Date(
                          filing.attendanceRecord ? filing.attendanceRecord.attendanceDate : filing.filingDate
                        ).toLocaleDateString()}
                      </p>
                      <span style={{ display: "inline-flex", alignItems: "center", fontSize: 10, fontWeight: 700, padding: "4px 9px", borderRadius: 999, color: tone.color, background: tone.bg, ...STATUS_PILL_SIZE }}>
                        {statusLabel(filing.status)}
                      </span>
                      {/* Same visual language as components/ui/LeaveTimeline.tsx
                          — a dedicated step-builder rather than reusing that
                          component, since its action vocabulary is leave-specific. */}
                      <div style={{ marginTop: 14, padding: "12px 0 0", borderTop: "1px solid #E2E8F0" }}>
                        <p style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, color: "#94A3B8", margin: "0 0 10px" }}>
                          APPROVAL PROGRESS
                        </p>
                        {steps.map((step, index) => {
                          const toneStyle = UNDERTIME_TIMELINE_TONE_STYLE[step.tone];
                          return (
                            <div key={step.key} style={{ display: "flex", gap: 10, paddingBottom: 14 }}>
                              <div style={{ width: 18, position: "relative" }}>
                                <div
                                  style={{
                                    width: 18, height: 18, borderRadius: 9, flexShrink: 0, position: "relative", zIndex: 1,
                                    display: "flex", alignItems: "center", justifyContent: "center",
                                    background: toneStyle.bg, border: `2px solid ${toneStyle.border}`,
                                    color: toneStyle.fg, fontSize: 10, fontWeight: 700, lineHeight: 1,
                                  }}
                                >
                                  {UNDERTIME_TIMELINE_TONE_SYMBOL[step.tone]}
                                </div>
                                {index < steps.length - 1 && (
                                  <div style={{ position: "absolute", top: 18, bottom: -14, left: 8, width: 2, background: toneStyle.line }} />
                                )}
                              </div>
                              <div style={{ flex: 1, paddingTop: 1 }}>
                                <div style={{ fontSize: 10.5, color: "#94A3B8", marginBottom: 2 }}>{step.when}</div>
                                <div style={{ fontSize: 12.5, fontWeight: 700, color: "#0F172A" }}>{step.title}</div>
                                {!!step.detail && (
                                  <p style={{ fontSize: 11.5, margin: "2px 0 0", lineHeight: "15px", color: step.tone === "danger" ? toneStyle.fg : "#64748B" }}>
                                    {step.detail}
                                  </p>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
              </>
            ) : (
              <>
                <h3 style={{ color: "#062B59", fontWeight: 700, marginBottom: 14 }}>My Undertime Request</h3>

                <div style={{ display: "flex", gap: 5, marginBottom: 10 }}>
                  <button
                    type="button"
                    onClick={() => setHistoryStatusFilter("ALL")}
                    style={{
                      flex: 1, border: "none", borderRadius: 999, padding: "7px 4px", cursor: "pointer",
                      fontSize: 11, fontWeight: 700,
                      background: historyStatusFilter === "ALL" ? "#062B59" : "#F1F5F9",
                      color: historyStatusFilter === "ALL" ? "#FFFFFF" : "#64748B",
                    }}
                  >
                    All
                  </button>
                  {(["PENDING", "APPROVED", "REJECTED"] as const).map((key) => {
                    const active = historyStatusFilter === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setHistoryStatusFilter(key)}
                        style={{
                          flex: 1, border: "none", borderRadius: 999, padding: "7px 4px", cursor: "pointer",
                          fontSize: 11, fontWeight: 700,
                          background: active ? "#062B59" : "#F1F5F9",
                          color: active ? "#FFFFFF" : "#64748B",
                        }}
                      >
                        {key.charAt(0) + key.slice(1).toLowerCase()}
                      </button>
                    );
                  })}
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <CalendarPicker
                    value={historyDateFrom}
                    onChange={setHistoryDateFrom}
                    max={historyDateTo || undefined}
                    placeholder="Filed from"
                  />
                  <CalendarPicker
                    value={historyDateTo}
                    onChange={setHistoryDateTo}
                    min={historyDateFrom || undefined}
                    placeholder="Filed to"
                    align="right"
                  />
                  {(historyDateFrom || historyDateTo) && (
                    <button
                      type="button"
                      onClick={() => {
                        setHistoryDateFrom("");
                        setHistoryDateTo("");
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

                <div className="emp-scroll-thin" style={{ height: 280, overflowY: "auto" }}>
                  {visibleHistoryFilings.length === 0 ? (
                    <p style={{ color: "#94A3B8", fontSize: 13, textAlign: "center" }}>
                      {historyDateFrom || historyDateTo || historyStatusFilter !== "ALL"
                        ? "No filings match these filters."
                        : "No undertime filings yet."}
                    </p>
                  ) : (
                    visibleHistoryFilings.map((filing) => {
                      const tone = statusTone(filing.status);
                      return (
                        <button
                          key={filing.id}
                          type="button"
                          onClick={() => setExpandedHistoryFilingId(filing.id)}
                          style={{
                            display: "block", width: "100%", textAlign: "left",
                            background: "#F8FAFC", border: "1px solid #E2E8F0", borderLeft: `4px solid ${tone.color}`, borderRadius: 14,
                            padding: 14, marginBottom: 10, cursor: "pointer",
                            boxShadow: "0 2px 6px rgba(11, 28, 51, 0.05)",
                            transition: "background 0.15s ease",
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = "#EEF2F7"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = "#F8FAFC"; }}
                        >
                          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                            <p style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, fontSize: 13, color: "#94A3B8", margin: 0 }}>
                              <Calendar size={13} color="#94A3B8" />
                              {new Date(
                                filing.attendanceRecord ? filing.attendanceRecord.attendanceDate : filing.filingDate
                              ).toLocaleDateString()}
                            </p>
                            <span style={{
                              display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0,
                              background: tone.bg, color: tone.color,
                              fontWeight: 700, fontSize: 10,
                              borderRadius: 999, padding: "4px 9px",
                              ...STATUS_PILL_SIZE,
                            }}>
                              <span style={{ width: 6, height: 6, borderRadius: "50%", background: tone.color, flexShrink: 0 }} />
                              {statusLabel(filing.status)}
                            </span>
                          </div>
                          {filing.attendanceRecord && (
                            <p style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, fontSize: 15, color: tone.color, margin: "4px 0 0" }}>
                              <Clock size={14} color={tone.color} />
                              {lateMinutesLabel(filedMinutes(filing.attendanceRecord))}
                            </p>
                          )}
                          <p style={{ color: "#94A3B8", fontSize: 12.5, margin: "8px 0 0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {filing.reason ?? ""}
                          </p>
                        </button>
                      );
                    })
                  )}
                </div>
              </>
            )}
            {!expandedHistoryFiling && (
              <button onClick={() => setHistoryOpen(false)} style={{ ...primBtn, marginTop: 10 }}>
                Close
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Pending requests modal ───────────────────────────────────────────── */}
      {showPending && (
        <div style={overlayNoBg}>
          <div className="emp-scroll-thin" style={modalCardFloating}>
            <h3 style={{ color: "#062B59", fontWeight: 700, marginBottom: 14 }}>My Leave Requests</h3>

            <SegmentedControl
              segments={[
                { key: "current", label: `Active (${currentRequests.length})` },
                { key: "past", label: `Past (${pastRequests.length})` },
              ]}
              value={requestsListTab}
              onChange={(key) => {
                // Each tab has its own set of status chips, so a chip picked
                // on one may not exist on the other.
                setRequestsListTab(key as "current" | "past");
                setRequestsStatusFilter("ALL");
              }}
              style={{ marginBottom: 16 }}
            />

            {/* Same navy-active/grey-inactive colors as every other pill on
                this page (Balance/Request/Undertime, Active/Past) instead of
                a third color. All + the statuses that apply to this tab,
                three per row so none of them is squeezed. Six half-chip
                columns with every chip spanning two, so a short last row
                (Past's Cancelled/Lapsed) keeps the same chip size and can
                start half a chip in — centered under the row above instead
                of stretching or leaving an empty cell (same as
                employee-mobile). */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 6, marginBottom: 10 }}>
              {statusFilterChips.map((filter, index) => {
                const active = requestsStatusFilter === filter.key;
                const lastRowCount = statusFilterChips.length % 3;
                const startsShortLastRow = lastRowCount > 0 && index === statusFilterChips.length - lastRowCount;
                return (
                  <button
                    key={filter.key}
                    type="button"
                    onClick={() => setRequestsStatusFilter(filter.key)}
                    style={{
                      gridColumn: startsShortLastRow ? `${4 - lastRowCount} / span 2` : "span 2",
                      border: "none", borderRadius: 999, padding: "7px 4px", cursor: "pointer",
                      fontSize: 11, fontWeight: 700,
                      background: active ? "#062B59" : "#F1F5F9",
                      color: active ? "#FFFFFF" : "#64748B",
                    }}
                  >
                    {filter.label}
                  </button>
                );
              })}
              {/* Active only fills one row of chips where Past fills two —
                  this invisible chip holds the second row open so the card
                  stays the same height (and so doesn't shift) when switching
                  tabs. */}
              {requestsListTab === "current" && (
                <button
                  type="button"
                  disabled
                  aria-hidden
                  tabIndex={-1}
                  style={{
                    gridColumn: "1 / -1", visibility: "hidden", border: "none", borderRadius: 999, padding: "7px 4px",
                    fontSize: 11, fontWeight: 700,
                  }}
                >
                  &nbsp;
                </button>
              )}
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

            <div className="emp-scroll-thin" style={{ height: 280, overflowY: "auto" }}>
              {(requestsListTab === "current" ? currentRequests : pastRequests).length === 0 ? (
                <p style={{ color: "#94A3B8", fontSize: 13, textAlign: "center" }}>
                  {requestsDateFrom || requestsDateTo || requestsStatusFilter !== "ALL"
                    ? "No requests match these filters."
                    : requestsListTab === "current"
                      ? "No active leave requests."
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
          {/* The scrollbar used to belong to this outer shell directly (same
              element as the rounded border + padding), so it rendered flush
              against the card's outer edge instead of inset within it —
              visibly crossing the rounded corner and overlapping the close
              button. Splitting scrolling into an inner panel (padding lives
              here, scrollbar renders at *its* edge, inset by that padding)
              and keeping this outer shell un-scrolled mirrors how
              employee-mobile's AestheticScrollView sits inside its card. */}
          <div style={{ ...modalCardFloating, padding: 0, overflowY: "hidden", display: "flex", flexDirection: "column" }}>
            {/* Back row, title, and close button stay put while the request
                details below scroll — a fixed header, not part of the
                scrollable panel. */}
            <div style={{ position: "relative", padding: "20px 20px 14px" }}>
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
              <h3 style={{ color: "#062B59", fontWeight: 700, margin: "0 0 12px" }}>Leave Request Details</h3>
              {/* Which request this is stays visible too, not just the
                  generic page title above — same reasoning as the back
                  row/title: it's orientation, not scrollable detail. */}
              <div style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 12, padding: 14 }}>
                <p style={{ fontWeight: 700, margin: "0 0 3px", color: "#062B59" }}>{leaveRequestTitle(focusedRequest)}</p>
                <p style={{ color: "#475569", fontSize: 13, margin: "0 0 8px" }}>
                  {new Date(focusedRequest.startDate).toLocaleDateString()} – {new Date(focusedRequest.endDate).toLocaleDateString()}
                </p>
                <span style={{
                  display: "inline-flex", alignItems: "center",
                  background: statusTone(focusedRequest.status).bg, color: statusTone(focusedRequest.status).color,
                  fontWeight: 700, fontSize: 10,
                  borderRadius: 999, padding: "4px 9px",
                  ...STATUS_PILL_SIZE,
                }}>
                  {statusLabel(focusedRequest.status, focusedRequest.lapseReason)}
                </span>
              </div>
            </div>
            <div className="emp-scroll-thin" style={{ padding: "0 20px 20px", overflowY: "auto", flex: 1, minHeight: 0 }}>
              {renderRequestCard(focusedRequest)}
            </div>
          </div>
        </div>
      )}

      {/* ── Maternity Leave extension request ───────────────────────────────── */}
      {extendTargetId && (() => {
        const target = requests.find((r) => r.id === extendTargetId);
        if (!target?.extension) return null;
        const canSubmit = !!extendReasonText.trim() && !isExtending;
        return (
          <div style={overlayS}>
            <div style={{ ...modalCard, maxWidth: 380, textAlign: "center" }}>
              <button type="button" onClick={() => setExtendTargetId(null)} style={modalCloseBtn} aria-label="Close">
                <X size={15} color="#64748B" />
              </button>
              <h3 style={{ color: "#062B59", fontWeight: 700, marginBottom: 8 }}>Extend your {target.leaveType.name}?</h3>
              <p style={{ color: "#475569", fontSize: 14, lineHeight: "20px", marginBottom: 14 }}>
                This requests 30 more days without pay, from{" "}
                <strong>{new Date(target.extension.startDate).toLocaleDateString()}</strong> to{" "}
                <strong>{new Date(target.extension.endDate).toLocaleDateString()}</strong>. Your supervisor or HR will need to approve it.
              </p>
              <textarea
                value={extendReasonText}
                onChange={(e) => setExtendReasonText(e.target.value)}
                placeholder="Why do you need the extension?"
                rows={3}
                style={{
                  width: "100%", border: "1px solid #E2E8F0", borderRadius: 10,
                  padding: "10px 12px", fontSize: 13, resize: "vertical",
                  boxSizing: "border-box", fontFamily: "inherit", outline: "none",
                  textAlign: "left",
                }}
              />
              <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                <button
                  onClick={() => setExtendTargetId(null)}
                  style={{ ...primBtn, flex: 1, background: "#F1F5F9", color: "#334155" }}
                >
                  Not Now
                </button>
                <button
                  onClick={() => handleExtend(target.id, extendReasonText.trim())}
                  disabled={!canSubmit}
                  style={{ ...primBtn, flex: 1, opacity: canSubmit ? 1 : 0.6, cursor: canSubmit ? "pointer" : "not-allowed" }}
                >
                  {isExtending ? "Requesting…" : "Request Extension"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Cancel confirmation ──────────────────────────────────────────────── */}
      {confirmCancelId && (
        <div style={overlayS}>
          <div style={{ ...modalCard, maxWidth: 360, textAlign: "center" }}>
            <button type="button" onClick={() => setConfirmCancelId(null)} style={modalCloseBtn} aria-label="Close">
              <X size={15} color="#64748B" />
            </button>
            <h3 style={{ color: "#062B59", fontWeight: 700, marginBottom: 8 }}>Cancel this leave request?</h3>
            <p style={{ color: "#475569", fontSize: 14, lineHeight: "20px", marginBottom: 14 }}>
              This action cannot be undone. Your supervisor will need to approve the cancellation.
            </p>
            {(() => {
              const target = requests.find((r) => r.id === confirmCancelId);
              if (!target) return null;
              const days = leaveDaysOf(target);
              if (days.length < 2) return null;
              const worked = workedDayTimes(target);
              return (
                <>
                  <label style={{ ...fldLbl, marginTop: 0, fontSize: 13, textAlign: "left" }}>Days to cancel</label>
                  <div
                    className="emp-scroll-thin"
                    style={{ maxHeight: 180, overflowY: "auto", border: "1px solid #E2E8F0", borderRadius: 10, marginBottom: 12, textAlign: "left" }}
                  >
                    {days.map((day) => {
                      const time = day.getTime();
                      const timedIn = worked.has(time);
                      return (
                        <label
                          key={time}
                          style={{
                            display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
                            fontSize: 13, fontWeight: 600, color: timedIn ? "#CBD5E1" : "#334155",
                            cursor: timedIn ? "not-allowed" : "pointer",
                          }}
                        >
                          <input
                            type="checkbox"
                            disabled={timedIn}
                            checked={cancelDayTimes.includes(time)}
                            onChange={() =>
                              setCancelDayTimes((current) =>
                                current.includes(time) ? current.filter((t) => t !== time) : [...current, time].sort((a, b) => a - b),
                              )
                            }
                            style={{ accentColor: "#DC2626", width: 16, height: 16 }}
                          />
                          <span style={{ flex: 1 }}>
                            {day.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
                          </span>
                          {timedIn && <span style={{ fontSize: 11, color: "#94A3B8" }}>Timed in</span>}
                        </label>
                      );
                    })}
                  </div>
                </>
              );
            })()}
            <textarea
              value={cancelReasonText}
              onChange={(e) => setCancelReasonText(e.target.value)}
              placeholder="Why are you cancelling this leave?"
              rows={3}
              style={{
                width: "100%", border: "1px solid #E2E8F0", borderRadius: 10,
                padding: "10px 12px", fontSize: 13, resize: "vertical",
                boxSizing: "border-box", fontFamily: "inherit", outline: "none",
                marginBottom: 12, textAlign: "left",
              }}
            />
            <label style={{ ...fldLbl, marginTop: 0, fontSize: 13, textAlign: "left" }}>Supporting Document (optional)</label>
            {cancelFile ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid #E2E8F0", borderRadius: 12, padding: "8px 12px", textAlign: "left" }}>
                <Paperclip size={15} color="#1680D8" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontWeight: 600, fontSize: 13, color: "#062B59", margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {cancelFile.name}
                  </p>
                  <p style={{ color: "#94A3B8", fontSize: 11, margin: 0 }}>{fmtBytes(cancelFile.sizeBytes)}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setCancelFile(null)}
                  style={{ border: "none", background: "#F1F5F9", borderRadius: 13, width: 26, height: 26, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                >
                  <X size={14} color="#64748B" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => cancelFileRef.current?.click()}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                  width: "100%", height: 42,
                  border: "1.5px dashed #BFDBFE", borderRadius: 12,
                  background: "#F8FAFF", cursor: "pointer",
                  color: "#1680D8", fontSize: 13, fontWeight: 600,
                }}
              >
                <Paperclip size={16} color="#1680D8" />
                Attach a photo or PDF
              </button>
            )}
            {cancelFileErr && <p style={{ color: "#DC2626", fontSize: 12, fontWeight: 600, margin: "4px 0 0", textAlign: "left" }}>{cancelFileErr}</p>}
            <input ref={cancelFileRef} type="file" accept="image/*,.pdf" style={{ display: "none" }} onChange={handleCancelFileChange} />
            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button
                onClick={() => setConfirmCancelId(null)}
                style={{ ...primBtn, flex: 1, background: "#F1F5F9", color: "#334155" }}
              >
                No, Keep It
              </button>
              <button
                onClick={() => {
                  handleCancel(confirmCancelId, cancelReasonText.trim(), cancelFile, cancelDayTimes);
                  setCancelFile(null);
                  setConfirmCancelId(null);
                }}
                disabled={!cancelReasonText.trim() || cancelDayTimes.length === 0}
                style={{
                  ...primBtn, flex: 1,
                  background: cancelReasonText.trim() && cancelDayTimes.length > 0 ? "#DC2626" : "#FCA5A5",
                  cursor: cancelReasonText.trim() && cancelDayTimes.length > 0 ? "pointer" : "not-allowed",
                }}
              >
                Yes, Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Maternity Leave alternatives prompt ─────────────────────────────── */}
      {maternityPrompt && (
        <div style={overlayS} onClick={() => setMaternityPrompt(null)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="maternity-prompt-title"
            onClick={(e) => e.stopPropagation()}
            style={{ ...modalCard, maxWidth: 400, padding: 24, textAlign: "center", boxShadow: "0 8px 20px rgba(0,0,0,0.2)" }}
          >
            <button type="button" onClick={() => setMaternityPrompt(null)} style={modalCloseBtn} aria-label="Close">
              <X size={15} color="#64748B" />
            </button>
            <div style={{ ...iconCircle("#FFFBEB"), width: 64, height: 64, marginBottom: 14 }}>
              <Lightbulb size={30} color="#D97706" />
            </div>
            <h3 id="maternity-prompt-title" style={{ color: "#062B59", fontSize: 18, fontWeight: 700, margin: "0 0 6px" }}>
              Before filing {maternityPrompt.maternity.name}
            </h3>
            <p style={{ color: "#475569", fontSize: 14, lineHeight: "20px", margin: 0 }}>
              You still have other leave you can file. Consider using it first — your {maternityPrompt.maternity.name} will
              still be available.
            </p>
            <p style={{ margin: "18px 0 8px", textAlign: "left", fontSize: 11, fontWeight: 700, letterSpacing: 0.6, color: "#94A3B8" }}>
              FILE THIS INSTEAD
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {maternityPrompt.alternatives.map((t) => {
                const remaining = remainingDaysFor(t);
                const alt = maternityAlternativeStyle(t);
                return (
                  <button
                    key={t.id}
                    type="button"
                    className="maternity-alt"
                    onClick={() => { setLeaveTypeId(t.id); setMaternityPrompt(null); }}
                    style={{ "--alt-color": alt.color, "--alt-bg": alt.bg } as CSSProperties}
                  >
                    <span
                      style={{
                        width: 40, height: 40, borderRadius: 12, flexShrink: 0,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        background: alt.bg,
                      }}
                    >
                      <alt.Icon size={20} color={alt.color} />
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", color: "#062B59", fontSize: 15, fontWeight: 700 }}>{t.name}</span>
                      <span style={{ display: "block", color: "#64748B", fontSize: 12, marginTop: 2 }}>
                        {t.isUnlimitedDays
                          ? "No day limit"
                          : remaining > 0
                            ? `${remaining} day${remaining === 1 ? "" : "s"} remaining`
                            : "Can be filed without pay"}
                      </span>
                    </span>
                    <ChevronRight size={18} color="#94A3B8" />
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => { setLeaveTypeId(maternityPrompt.maternity.id); setMaternityPrompt(null); }}
              style={{ ...outlineBtn, height: 46, marginTop: 18, border: "1px solid #CBD5E1", color: "#334155" }}
            >
              Continue with {maternityPrompt.maternity.name}
            </button>
          </div>
        </div>
      )}

      {/* ── Result modal ─────────────────────────────────────────────────────── */}
      {resultModal && (
        <div style={overlayS}>
          <div style={{ ...modalCard, textAlign: "center" }}>
            <button type="button" onClick={() => setResultModal(null)} style={modalCloseBtn} aria-label="Close">
              <X size={15} color="#64748B" />
            </button>
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
const outlineBtn: CSSProperties = {
  display: "block", width: "100%", height: 50,
  borderRadius: 14, border: "1px solid #E2E8F0",
  background: "#FFFFFF", color: "#475569",
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
  position: "relative",
  width: "100%", maxWidth: 420,
  maxHeight: "85vh", overflowY: "auto",
  background: "#fff", borderRadius: 20, padding: 20,
};
const modalCloseBtn: CSSProperties = {
  position: "absolute", top: 12, right: 12,
  width: 28, height: 28, borderRadius: "50%",
  border: "none", background: "#F1F5F9",
  display: "flex", alignItems: "center", justifyContent: "center",
  cursor: "pointer", zIndex: 1,
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
