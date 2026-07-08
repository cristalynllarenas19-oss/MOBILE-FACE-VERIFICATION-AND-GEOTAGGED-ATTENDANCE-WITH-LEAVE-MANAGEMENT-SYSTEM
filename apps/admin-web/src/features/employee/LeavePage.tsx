

import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle, ChevronDown, ChevronUp, FileText, Paperclip, Search, X } from "lucide-react";
import "./EmployeeLeavePage.css";
import "./EmployeePortal.css";
import {
  LeaveType, LeaveBalance, LeaveRequest,
  getLeaveTypes, getLeaveBalances, getLeaveRequests, createLeaveRequest, cancelLeaveRequest, resubmitLeaveRequest,
} from "./api";
import { LeaveBalanceChart } from "./components/LeaveBalanceChart";
import type { AuthUser } from "../../lib/api";

type Props = { user: AuthUser };
type Tab   = "balance" | "request";

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

export function LeavePage({ user }: Props) {
  const [tab,          setTab]          = useState<Tab>("balance");
  const [leaveTypes,   setLeaveTypes]   = useState<LeaveType[]>([]);
  const [balances,     setBalances]     = useState<LeaveBalance[]>([]);
  const [requests,     setRequests]     = useState<LeaveRequest[]>([]);
  const [loadingData,  setLoadingData]  = useState(true);

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

  // Inline "attach requirement & resubmit" — only one row can be expanded at a time.
  const [resubmittingId,  setResubmittingId]  = useState<string | null>(null);
  const [resubmitNote,    setResubmitNote]    = useState("");
  const [resubmitFile,    setResubmitFile]    = useState<{ name: string; mimeType: string; sizeBytes: number; base64: string } | null>(null);
  const [resubmitErr,     setResubmitErr]     = useState<string | null>(null);
  const [isResubmitting,  setIsResubmitting]  = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const resubmitFileRef = useRef<HTMLInputElement>(null);

  const selectedType    = leaveTypes.find((t) => t.id === leaveTypeId);
  const filteredTypes   = leaveTypes
    .filter((t) => !t.requiresEhsActivation || t.ehsActivated)
    .filter((t) => t.name.toLowerCase().includes(searchLeave.toLowerCase()));
  const pendingRequests = useMemo(
    () => requests.filter((r) => r.status === "PENDING" || r.status === "SUPERVISOR_APPROVED" || r.status === "NEEDS_REVISION"),
    [requests],
  );

  const remainingByLeaveType = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of balances) map.set(b.leaveTypeId, b.remainingDays);
    return map;
  }, [balances]);

  function isLeaveTypeExhausted(t: LeaveType) {
    if (t.allowWithoutPay || t.isUnlimitedDays) return false;
    const remaining = remainingByLeaveType.get(t.id);
    const effectiveRemaining = remaining !== undefined ? remaining : Number(t.defaultDays);
    return effectiveRemaining <= 0;
  }

  async function loadData() {
    setLoadingData(true);
    try {
      const types = await getLeaveTypes();
      setLeaveTypes(types);
      if (user.employeeId) {
        const [bal, reqs] = await Promise.all([
          getLeaveBalances(user.employeeId),
          getLeaveRequests(user.employeeId),
        ]);
        setBalances(bal);
        setRequests(reqs);
      }
    } catch { /* non-blocking */ } finally { setLoadingData(false); }
  }

  useEffect(() => { loadData(); }, [user.employeeId]);

  async function handleCancel(requestId: string) {
    setCancellingId(requestId);
    try {
      await cancelLeaveRequest(requestId);
      await loadData();
    } catch { /* non-blocking */ } finally { setCancellingId(null); }
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
      await loadData();
    } catch (err) {
      setResubmitErr(err instanceof Error ? err.message : "Failed to resubmit leave request.");
    } finally { setIsResubmitting(false); }
  }

  const totalDays = useMemo(() => {
    if (!startDate || !endDate) return 0;
    return Math.max(1, Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86_400_000) + 1);
  }, [startDate, endDate]);

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
      const balance = balances.find((b) => b.leaveTypeId === selectedType.id);
      const remainingDays = balance ? balance.remainingDays : Number(selectedType.defaultDays);
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
        extensionRequested: selectedType?.name === "Maternity Leave" ? extensionRequested : undefined,
      });
      resetForm();
      await loadData();
      setResultModal({ ok: true, title: "Leave Request Submitted", msg: "Your HR/Admin and supervisor have been notified. You'll be informed once it's reviewed." });
    } catch (err) {
      setResultModal({ ok: false, title: "Submission Failed", msg: err instanceof Error ? err.message : "Please try again." });
    } finally { setIsSubmitting(false); }
  }

  function renderRequestCard(r: LeaveRequest) {
    const tone = statusTone(r.status);
    const needsRevision = r.status === "NEEDS_REVISION";
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
          ) : (
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
          )}
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
              <button
                onClick={() => resubmitFileRef.current?.click()}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                  width: "100%", height: 40,
                  border: "1.5px dashed #BFDBFE", borderRadius: 10,
                  background: "#F8FAFF", cursor: "pointer",
                  color: "#1680D8", fontSize: 12, fontWeight: 600,
                }}
              >
                <Paperclip size={14} color="#1680D8" />
                Attach the requested requirement
              </button>
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
        {(["balance", "request"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`leave-tab-btn${tab === t ? " is-active" : ""}`}
          >
            {t === "balance" ? "Balance" : "Request"}
          </button>
        ))}
      </div>

      {/* ── Balance tab ──────────────────────────────────────────────────────── */}
      {tab === "balance" && (
        <LeaveBalanceChart
          balances={balances}
          loading={loadingData}
          pendingCount={pendingRequests.length}
          onPressPending={() => setShowPending(true)}
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
                              {exhausted ? " (no balance left)" : ""}
                            </button>
                          );
                        })
                    }
                  </div>
                </div>
              )}
            </div>

            {/* Dates */}
            <label style={fldLbl}>Leave Duration</label>
            <div style={{ display: "flex", gap: 10 }}>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={dateInp} />
              <input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} style={dateInp} />
            </div>
            {startDate && endDate && (
              <p style={{ fontSize: 12, fontWeight: 600, color: "#1680D8", margin: "5px 0 0" }}>
                {totalDays} day{totalDays === 1 ? "" : "s"} total
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

            {selectedType?.name === "Maternity Leave" && (
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
            <input ref={resubmitFileRef} type="file" accept="image/*,.pdf" style={{ display: "none" }} onChange={handleResubmitFileChange} />
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
