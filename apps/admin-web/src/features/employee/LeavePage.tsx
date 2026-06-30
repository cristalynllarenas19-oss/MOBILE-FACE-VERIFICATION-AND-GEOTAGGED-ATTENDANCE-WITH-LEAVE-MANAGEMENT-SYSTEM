/**
 * LeavePage — employee self-service leave
 *
 * Mirrors employee-mobile LeaveScreen exactly:
 *  Balance tab  — leave balance cards per type with usage bar + pending-request banner
 *  Request tab  — searchable leave-type dropdown, date pickers, file attachment
 *                 (image/PDF ≤ 5 MB), reason textarea, submit
 *
 * Endpoints used (same as mobile):
 *   GET  /leave-types
 *   GET  /leave-balances/:employeeId?year=YYYY
 *   GET  /leave-requests?employeeId=:id
 *   POST /leave-requests
 */

import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle, ChevronDown, ChevronUp, FileText, Paperclip, Search, X } from "lucide-react";
import {
  LeaveType, LeaveBalance, LeaveRequest,
  getLeaveTypes, getLeaveBalances, getLeaveRequests, createLeaveRequest,
} from "./api";
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
  const [isSubmitting,  setIsSubmitting]  = useState(false);

  // Modals
  const [showPending,  setShowPending]   = useState(false);
  const [resultModal,  setResultModal]   = useState<{ ok: boolean; title: string; msg: string } | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);

  const selectedType    = leaveTypes.find((t) => t.id === leaveTypeId);
  const filteredTypes   = leaveTypes.filter((t) =>
    t.name.toLowerCase().includes(searchLeave.toLowerCase()),
  );
  const pendingRequests = useMemo(() => requests.filter((r) => r.status === "PENDING"), [requests]);

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

  const totalDays = useMemo(() => {
    if (!startDate || !endDate) return 0;
    return Math.max(1, Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86_400_000) + 1);
  }, [startDate, endDate]);

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
    if (selectedType?.requiresDocument && !attachment) {
      setResultModal({ ok: false, title: "Document Required", msg: `${selectedType.name} requires a supporting document. Please attach one before submitting.` });
      return;
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
      });
      resetForm();
      await loadData();
      setResultModal({ ok: true, title: "Leave Request Submitted", msg: "Your HR/Admin and supervisor have been notified. You'll be informed once it's reviewed." });
    } catch (err) {
      setResultModal({ ok: false, title: "Submission Failed", msg: err instanceof Error ? err.message : "Please try again." });
    } finally { setIsSubmitting(false); }
  }

  return (
    <div style={{ maxWidth: 620, margin: "0 auto" }}>

      {/* Tab switcher */}
      <div style={{ display: "flex", background: "#F1F5F9", borderRadius: 14, padding: 4, marginBottom: 16 }}>
        {(["balance", "request"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              flex: 1, padding: "10px 0", borderRadius: 11,
              border: "none", cursor: "pointer",
              background:  tab === t ? "#062B59" : "transparent",
              color:       tab === t ? "#FFFFFF"  : "#64748B",
              fontWeight: 700, fontSize: 14,
            }}
          >
            {t === "balance" ? "Balance" : "Request"}
          </button>
        ))}
      </div>

      {/* ── Balance tab ──────────────────────────────────────────────────────── */}
      {tab === "balance" && (
        <div>
          {loadingData ? (
            <p style={{ color: "#64748B", textAlign: "center", padding: 32 }}>Loading…</p>
          ) : balances.length === 0 ? (
            <p style={{ color: "#94A3B8", textAlign: "center", padding: 32 }}>No leave balances found.</p>
          ) : (
            <>
              {pendingRequests.length > 0 && (
                <button
                  onClick={() => setShowPending(true)}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, width: "100%",
                    background: "#FEF3C7", border: "1px solid #FCD34D",
                    borderRadius: 12, padding: "10px 14px", marginBottom: 14,
                    cursor: "pointer",
                  }}
                >
                  <span style={{ color: "#B45309", fontSize: 13, fontWeight: 700 }}>
                    ⏳ {pendingRequests.length} pending request{pendingRequests.length > 1 ? "s" : ""}
                  </span>
                  <span style={{ color: "#B45309", fontSize: 12, marginLeft: "auto" }}>View →</span>
                </button>
              )}

              {balances.map((b) => {
                const pct = b.earnedDays > 0 ? Math.round((b.usedDays / b.earnedDays) * 100) : 0;
                return (
                  <div key={b.leaveTypeId} style={balCard}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                      <div>
                        <p style={{ fontWeight: 700, color: "#062B59", fontSize: 14, marginBottom: 2 }}>{b.leaveTypeName}</p>
                        <p style={{ color: "#64748B", fontSize: 12, margin: 0 }}>{b.year}</p>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <p style={{ fontSize: 24, fontWeight: 800, color: "#062B59", margin: 0 }}>{b.remainingDays}</p>
                        <p style={{ color: "#94A3B8", fontSize: 11, margin: 0 }}>remaining</p>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 14, fontSize: 12, color: "#64748B", marginBottom: 8 }}>
                      <span>Earned: <b style={{ color: "#062B59" }}>{b.earnedDays}</b></span>
                      <span>Used: <b style={{ color: "#062B59" }}>{b.usedDays}</b></span>
                    </div>
                    <div style={{ height: 4, borderRadius: 2, background: "#E2E8F0", overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${pct}%`, background: "#1680D8", borderRadius: 2 }} />
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}

      {/* ── Request tab ──────────────────────────────────────────────────────── */}
      {tab === "request" && (
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
                    : filteredTypes.map((t) => (
                        <button
                          key={t.id}
                          onClick={() => { setLeaveTypeId(t.id); setDropOpen(false); setSearchLeave(""); }}
                          style={{
                            display: "block", width: "100%", textAlign: "left",
                            padding: "11px 14px", border: "none",
                            borderBottom: "1px solid #F1F5F9",
                            background: "none", cursor: "pointer",
                            color:      leaveTypeId === t.id ? "#062B59" : "#334155",
                            fontWeight: leaveTypeId === t.id ? 700 : 400,
                            fontSize: 14,
                          }}
                        >
                          {t.name}{t.requiresDocument ? " (document required)" : ""}
                        </button>
                      ))
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
            Supporting Document{selectedType?.requiresDocument ? " (required)" : " (optional)"}
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
              ) : pendingRequests.map((r) => {
                const tone = statusTone(r.status);
                return (
                  <div key={r.id} style={{ background: "#F8FAFC", borderRadius: 12, padding: 14, marginBottom: 10 }}>
                    <p style={{ fontWeight: 700, marginBottom: 3 }}>{r.leaveType.name}</p>
                    <p style={{ color: "#475569", fontSize: 13, marginBottom: 3 }}>
                      {new Date(r.startDate).toLocaleDateString()} – {new Date(r.endDate).toLocaleDateString()}
                    </p>
                    {r.attachmentName && (
                      <p style={{ color: "#64748B", fontSize: 12, margin: "3px 0" }}>📎 {r.attachmentName}</p>
                    )}
                    <span style={{
                      display: "inline-block",
                      background: tone.bg, color: tone.color,
                      fontWeight: 700, fontSize: 11,
                      borderRadius: 999, padding: "3px 8px", marginTop: 4,
                    }}>
                      {r.status.replace("_", " ")}
                    </span>
                  </div>
                );
              })}
            </div>
            <button onClick={() => setShowPending(false)} style={{ ...primBtn, marginTop: 10 }}>Close</button>
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
const balCard: CSSProperties = {
  background: "#FFFFFF", borderRadius: 14,
  border: "1px solid #E2E8F0", padding: "14px 16px", marginBottom: 10,
};
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
