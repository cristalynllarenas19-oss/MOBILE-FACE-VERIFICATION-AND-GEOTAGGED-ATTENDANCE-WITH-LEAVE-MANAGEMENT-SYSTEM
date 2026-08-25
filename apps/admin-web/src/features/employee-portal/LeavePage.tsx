

import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle, ChevronDown, ChevronUp, FileText, Paperclip, Search, X } from "lucide-react";
import "./EmployeeLeavePage.css";
import "./EmployeePortal.css";
import {
  LeaveType, LeaveBalance, LeaveRequest, UndertimeEligibility, UndertimeFiling,
  getLeaveTypes, getLeaveBalances, getLeaveRequests, createLeaveRequest, cancelLeaveRequest, resubmitLeaveRequest,
  getUndertimeEligibility, getUndertimeFilings, fileUndertime,
} from "./api";
import { LeaveBalanceChart } from "./components/LeaveBalanceChart";
import type { AuthUser } from "../../lib/api";
import { CACHE_KEYS, useCachedData } from "../../lib/dataCache";

type Props = {
  user: AuthUser;
  initialFocusRequestId?: string;
  onFocusRequestHandled?: () => void;
};
type Tab   = "balance" | "request" | "undertime";

const MAX_BYTES = 5 * 1024 * 1024;

function statusTone(s: string) {
  if (s === "APPROVED" || s === "SUPERVISOR_APPROVED") return { color: "#15803D", bg: "#DCFCE7" };
  if (s === "REJECTED"  || s === "CANCELLED")           return { color: "#B91C1C", bg: "#FEE2E2" };
  return { color: "#B45309", bg: "#FEF3C7" };
}

function fmtBytes(b: number) {
  if (b < 1024)         return `${b} B`;
  if (b < 1024 * 1024)  return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
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
  const leaveTypes = leaveTypesCache.data ?? [];
  const balances = balancesCache.data ?? [];
  const requests = requestsCache.data ?? [];
  const undertimeEligibility = undertimeEligibilityCache.data;
  const undertimeFilings = undertimeFilingsCache.data ?? [];
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
  const [isSubmitting,  setIsSubmitting]  = useState(false);

  // Modals
  const [showPending,  setShowPending]   = useState(false);
  const [resultModal,  setResultModal]   = useState<{ ok: boolean; title: string; msg: string } | null>(null);
  const [cancellingId, setCancellingId]  = useState<string | null>(null);
  const [focusedRequestId, setFocusedRequestId] = useState<string | null>(null);

  // Inline "attach requirement & resubmit" — only one row can be expanded at a time.
  const [resubmittingId,  setResubmittingId]  = useState<string | null>(null);
  const [resubmitNote,    setResubmitNote]    = useState("");
  const [resubmitFile,    setResubmitFile]    = useState<{ name: string; mimeType: string; sizeBytes: number; base64: string } | null>(null);
  const [resubmitErr,     setResubmitErr]     = useState<string | null>(null);
  const [isResubmitting,  setIsResubmitting]  = useState(false);

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

  useEffect(() => {
    if (!initialFocusRequestId || loadingData) return;
    const request = requests.find((r) => r.id === initialFocusRequestId);
    setTab("request");
    if (request) {
      setFocusedRequestId(request.id);
      if (request.status === "NEEDS_REVISION") openResubmit(request.id);
    } else {
      setResultModal({
        ok: false,
        title: "Leave Request Not Found",
        msg: "This notification is linked to a leave request that could not be loaded.",
      });
    }
    onFocusRequestHandled?.();
  }, [initialFocusRequestId, loadingData, requests, onFocusRequestHandled]);

  async function handleCancel(requestId: string) {
    setCancellingId(requestId);
    try {
      await cancelLeaveRequest(requestId);
      await refreshAll();
    } catch (err) {
      setResultModal({
        ok: false,
        title: "Cancellation Failed",
        msg: err instanceof Error ? err.message : "Unable to cancel this leave request.",
      });
    } finally { setCancellingId(null); }
  }

  function openResubmit(requestId: string) {
    setResubmittingId(requestId);
    setResubmitNote("");
    setResubmitFile(null);
    setResubmitErr(null);
  }

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
      setResubmittingId(null);
      await refreshAll();
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

  // Leave types with advanceFilingAllowed === false (Sick Leave) cannot be
  // filed for a future date — driven by the selected type's own config so
  // this isn't a rule baked into the frontend, it just mirrors whatever HR
  // set on the Leave Types admin page. The backend enforces this
  // independently in leave.service.ts; this only improves the picking UX.
  const maxStartDate = useMemo(() => {
    if (selectedType?.advanceFilingAllowed === false) return new Date().toISOString().slice(0, 10);
    return undefined;
  }, [selectedType]);

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

    setIsSubmitting(true);
    try {
      await createLeaveRequest({
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
      });
      resetForm();
      await refreshAll();
      setResultModal({ ok: true, title: "Leave Request Submitted", msg: "Your HR/Admin and supervisor have been notified. You'll be informed once it's reviewed." });
    } catch (err) {
      setResultModal({ ok: false, title: "Submission Failed", msg: err instanceof Error ? err.message : "Please try again." });
    } finally { setIsSubmitting(false); }
  }

  function renderRequestCard(r: LeaveRequest) {
    const tone = statusTone(r.status);
    const needsRevision = r.status === "NEEDS_REVISION";
    // APPROVED is included here too — the server is the one that actually
    // enforces the cancellation grace window (and whether the leave has
    // already started), so the button is always offered and any rejection
    // (e.g. past the window) surfaces through handleCancel's error modal.
    const canCancel = r.status === "PENDING" || r.status === "SUPERVISOR_APPROVED" || r.status === "APPROVED";
    const lastRejection = needsRevision
      ? [...(r.notes ?? [])].reverse().find((n) => n.type === "REJECTED")
      : undefined;
    const isExpanded = resubmittingId === r.id;
    return (
      <div key={r.id} style={{ background: "#F8FAFC", borderRadius: 12, padding: 14, marginBottom: 10 }}>
        <p style={{ fontWeight: 700, marginBottom: 3 }}>{r.leaveType.name}</p>
        <p style={{ color: "#475569", fontSize: 13, marginBottom: 3 }}>
          {new Date(r.startDate).toLocaleDateString()} – {new Date(r.endDate).toLocaleDateString()}
        </p>
        {r.attachmentName && (
          <p style={{ color: "#64748B", fontSize: 12, margin: "3px 0" }}>📎 {r.attachmentName}</p>
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
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
          <span style={{
            display: "inline-block",
            background: tone.bg, color: tone.color,
            fontWeight: 700, fontSize: 11,
            borderRadius: 999, padding: "3px 8px",
          }}>
            {r.status.replace("_", " ")}
          </span>
          {needsRevision ? (
            <button
              onClick={() => (isExpanded ? setResubmittingId(null) : openResubmit(r.id))}
              style={{
                border: "1px solid #93C5FD", background: "#EFF6FF", color: "#1680D8",
                fontWeight: 700, fontSize: 11, borderRadius: 999, padding: "3px 10px",
                cursor: "pointer",
              }}
            >
              {isExpanded ? "Cancel" : "Attach & Resubmit"}
            </button>
          ) : canCancel ? (
            <button
              onClick={() => handleCancel(r.id)}
              disabled={cancellingId === r.id}
              style={{
                border: "1px solid #FCA5A5", background: "#FEF2F2", color: "#DC2626",
                fontWeight: 700, fontSize: 11, borderRadius: 999, padding: "3px 10px",
                cursor: cancellingId === r.id ? "not-allowed" : "pointer",
              }}
            >
              {cancellingId === r.id ? "Cancelling…" : "Cancel"}
            </button>
          ) : null}
        </div>

        {needsRevision && isExpanded && (
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
      <div className="leave-tab-switcher">
        {(["balance", "request", "undertime"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`leave-tab-btn${tab === t ? " is-active" : ""}`}
          >
            {t === "balance" ? "Balance" : t === "request" ? "Request" : "Undertime"}
          </button>
        ))}
      </div>

      {/* ── Balance tab ──────────────────────────────────────────────────────── */}
      {tab === "balance" && (
        <LeaveBalanceChart
          balances={visibleBalances}
          loading={loadingData}
          pendingCount={pendingRequests.length}
          onPressPending={() => setShowPending(true)}
          onRequest={handleRequestFromBalance}
        />
      )}

      {/* ── Request tab ──────────────────────────────────────────────────────── */}
      {tab === "request" && pendingRequests.length > 0 && (
        <div style={{ background: "#FFFFFF", borderRadius: 18, border: "1px solid #E2E8F0", padding: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <FileText size={28} color="#DC2777" />
            <h3 style={{ color: "#062B59", fontSize: 18, fontWeight: 700, margin: 0 }}>Leave Request</h3>
          </div>
          <p style={{ color: "#64748B", fontSize: 13, marginTop: 0, marginBottom: 14, lineHeight: "18px" }}>
            You have a leave request awaiting review. You can submit a new request once it's approved, rejected, or cancelled.
          </p>
          {pendingRequests.map(renderRequestCard)}
        </div>
      )}

      {tab === "request" && pendingRequests.length === 0 && (
        <div style={{ background: "#FFFFFF", borderRadius: 18, border: "1px solid #E2E8F0", padding: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
              <FileText size={28} color="#DC2777" />
              <h3 style={{ color: "#062B59", fontSize: 18, fontWeight: 700, margin: 0 }}>Leave Request</h3>
            </div>

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
                  <div style={{ maxHeight: 158, overflowY: "auto" }}>
                    {filteredTypes.length === 0
                      ? <p style={{ padding: 14, textAlign: "center", color: "#94A3B8", fontSize: 13, margin: 0 }}>No leave types found</p>
                      : filteredTypes.map((t) => {
                          const exhausted = isLeaveTypeExhausted(t);
                          return (
                            <button
                              key={t.id}
                              disabled={exhausted}
                              onClick={() => { setLeaveTypeId(t.id); setDropOpen(false); setSearchLeave(""); }}
                              style={{
                                display: "block", width: "100%", textAlign: "left",
                                padding: "11px 14px", border: "none",
                                borderBottom: "1px solid #F1F5F9",
                                background: exhausted ? "#F8FAFC" : "none",
                                cursor: exhausted ? "not-allowed" : "pointer",
                                color:      exhausted ? "#CBD5E1" : leaveTypeId === t.id ? "#062B59" : "#334155",
                                fontWeight: leaveTypeId === t.id ? 700 : 400,
                                fontSize: 14,
                              }}
                            >
                              {t.name}{t.requiresDocument ? (t.supportingDocumentAfterDays ? ` (document required after ${t.supportingDocumentAfterDays}+ days)` : " (document required)") : ""}
                              {exhausted
                                ? t.requiresAdminGrant
                                  ? " (apply to HR/Admin first)"
                                  : " (no balance left)"
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
              <input type="date" value={startDate} max={maxStartDate} onChange={(e) => setStartDate(e.target.value)} style={dateInp} />
            ) : (
              <div style={{ display: "flex", gap: 10 }}>
                <input type="date" value={startDate} max={maxStartDate} onChange={(e) => setStartDate(e.target.value)} style={dateInp} />
                <input type="date" value={endDate} min={startDate} max={maxEndDate} onChange={(e) => setEndDate(e.target.value)} style={dateInp} />
              </div>
            )}
            {startDate && endDate && !selectedType?.isSingleDayOnly && (
              <p style={{ fontSize: 12, fontWeight: 600, color: "#1680D8", margin: "5px 0 0" }}>
                {totalDays} day{totalDays === 1 ? "" : "s"} total
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
              disabled={isSubmitting}
              onClick={handleSubmit}
              style={{ ...primBtn, marginTop: 16, opacity: isSubmitting ? 0.7 : 1, cursor: isSubmitting ? "not-allowed" : "pointer" }}
            >
              {isSubmitting ? "Submitting…" : "Submit Leave Request"}
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
        <div style={overlayS}>
          <div style={modalCard}>
            <h3 style={{ color: "#062B59", fontWeight: 700, marginBottom: 14 }}>Pending Leave Requests</h3>
            <div style={{ maxHeight: 320, overflowY: "auto" }}>
              {pendingRequests.length === 0 ? (
                <p style={{ color: "#94A3B8", fontSize: 13, textAlign: "center" }}>No pending requests.</p>
              ) : pendingRequests.map(renderRequestCard)}
            </div>
            <button onClick={() => { setShowPending(false); setResubmittingId(null); }} style={{ ...primBtn, marginTop: 10 }}>Close</button>
          </div>
        </div>
      )}

      {focusedRequest && (
        <div style={overlayS}>
          <div style={modalCard}>
            <h3 style={{ color: "#062B59", fontWeight: 700, marginBottom: 14 }}>Leave Request Details</h3>
            {renderRequestCard(focusedRequest)}
            <button
              onClick={() => {
                setFocusedRequestId(null);
                setResubmittingId(null);
              }}
              style={{ ...primBtn, marginTop: 10 }}
            >
              Close
            </button>
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
function iconCircle(bg: string): CSSProperties {
  return {
    width: 80, height: 80, borderRadius: "50%", background: bg,
    display: "flex", alignItems: "center", justifyContent: "center",
    margin: "0 auto 14px",
  };
}
