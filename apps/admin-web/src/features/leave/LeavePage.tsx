import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Ban,
  Calendar as CalendarIcon,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  FileText,
  IdCard,
  Paperclip,
  Search,
  X,
} from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { DropdownFilter } from "../../components/ui/DropdownFilter";
import { LeaveTimeline, type LeaveRequestHistoryEvent } from "../../components/ui/LeaveTimeline";
import { apiRequest } from "../../lib/api";
import { useActiveDepartments } from "../../lib/departments";
import { useCachedData } from "../../lib/dataCache";
import { colorForLeaveType } from "../../lib/leaveTypeColors";
import {
  type EmploymentStatus,
  formatEmploymentStatus,
  SELECTABLE_EMPLOYMENT_STATUS_OPTIONS,
} from "../../types/employment";
import "./LeavePage.css";

// ─── Types ───────────────────────────────────────────────────────────────────

type LeaveType = {
  id: string;
  name: string;
  defaultDays: string;
  requiresDocument: boolean;
  allowWithoutPay: boolean;
  requiresAdminGrant: boolean;
  isSingleDayOnly: boolean;
};

type LeaveRequestNote = {
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

type LeaveRequest = {
  id: string;
  startDate: string;
  endDate: string;
  totalDays: string;
  status: string;
  reason: string;
  createdAt: string;
  adminRemarks?: { remarks?: string } | null;
  notes?: LeaveRequestNote[];
  history?: LeaveRequestHistoryEvent[];
  attachmentName?: string | null;
  attachmentMimeType?: string | null;
  attachmentData?: string | null;
  extensionRequested?: boolean;
  extensionApproved?: boolean | null;
  // Only set while status is CANCELLATION_PENDING — the status to revert to
  // if this cancellation request is denied.
  preCancellationStatus?: string | null;
  employee: {
    id: string;
    firstName: string;
    lastName: string;
    employmentStatus?: EmploymentStatus;
    department?: { name: string };
  };
  leaveType: { id: string; name: string };
  reviewer?: {
    email: string;
    employee?: { firstName: string; lastName: string } | null;
  } | null;
};

type LeaveBalance = {
  leaveTypeId: string;
  leaveTypeName: string;
  year: number;
  earnedDays: number;
  usedDays: number;
  remainingDays: number;
};

type DirectoryEmployee = {
  id: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
  employmentStatus: EmploymentStatus;
  department?: { name: string } | null;
  position?: { title: string } | null;
  attendanceMode?: string;
};

type ClassificationBalanceRow = {
  employeeId: string;
  totalEarnedDays: number;
  totalUsedDays: number;
  totalRemainingDays: number;
  balances: { leaveTypeId: string; leaveTypeName: string; earnedDays: number; usedDays: number; remainingDays: number }[];
};

type Notification = { type: "success" | "error"; message: string } | null;

const LEAVE_TABLE_PAGE_SIZE = 10;
// Smaller than LEAVE_TABLE_PAGE_SIZE on purpose: this table sits inside the
// compact Leave Balances Overview card, where a shorter page keeps its
// pagination visible without scrolling — Requests/History/Undertime aren't
// affected since they use LEAVE_TABLE_PAGE_SIZE directly.
const EMPLOYEE_LIST_PAGE_SIZE = 5;

type UndertimeFiling = {
  id: string;
  filingDate: string;
  reason: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED";
  remarks: string | null;
  createdAt: string;
  employee: { id: string; firstName: string; lastName: string; department: { name: string } | null };
  attendanceRecord?: { attendanceDate: string; lateMinutes: number } | null;
  reviewer?: { email: string; employee?: { firstName: string; lastName: string } | null } | null;
};

function undertimeReviewerName(filing: UndertimeFiling) {
  if (!filing.reviewer) return "—";
  if (filing.reviewer.employee) {
    return `${filing.reviewer.employee.firstName} ${filing.reviewer.employee.lastName}`;
  }
  return filing.reviewer.email;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getEmployeeName(request: LeaveRequest) {
  return `${request.employee.firstName} ${request.employee.lastName}`;
}

function getLeaveTone(status: string) {
  if (status === "APPROVED" || status === "SUPERVISOR_APPROVED") return "success";
  if (status === "REJECTED") return "danger";
  // Its own neutral tone, not REJECTED's — withdrawing your own request
  // isn't a rejection.
  if (status === "CANCELLED") return "neutral";
  return "warning";
}

function titleCaseStatus(status: string) {
  return status
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function getLeaveStatusLabel(status: string, _isAdmin: boolean) {
  // SUPERVISOR_APPROVED only exists on legacy rows from the old two-step
  // flow — approval is single-step now, so it reads as plain "Approved".
  if (status === "SUPERVISOR_APPROVED") return "Approved";
  // Reordered from a plain title-case ("Cancellation Pending") to match the
  // wording used on the employee portal and the mobile app.
  if (status === "CANCELLATION_PENDING") return "Pending Cancellation";
  return titleCaseStatus(status);
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString();
}

function formatLongDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

// "August 5–7, 2026" for a same-month range, widening to include the month
// (and year, if needed) on either side only when the range actually crosses
// that boundary — a single-day request just reads as one date.
function formatUsedDateRange(startIso: string, endIso: string) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (start.toDateString() === end.toDateString()) return formatLongDate(startIso);

  if (start.getFullYear() === end.getFullYear()) {
    if (start.getMonth() === end.getMonth()) {
      const month = start.toLocaleDateString(undefined, { month: "long" });
      return `${month} ${start.getDate()}–${end.getDate()}, ${start.getFullYear()}`;
    }
    const startLabel = start.toLocaleDateString(undefined, { month: "long", day: "numeric" });
    const endLabel = end.toLocaleDateString(undefined, { month: "long", day: "numeric" });
    return `${startLabel} – ${endLabel}, ${start.getFullYear()}`;
  }

  return `${formatLongDate(startIso)} – ${formatLongDate(endIso)}`;
}

function formatDayCount(days: number) {
  return `${days} day${days === 1 ? "" : "s"}`;
}

function dateKey(value: string | Date) {
  const d = typeof value === "string" ? new Date(value) : value;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function reviewerName(request: LeaveRequest) {
  if (!request.reviewer) return "—";
  if (request.reviewer.employee) {
    return `${request.reviewer.employee.firstName} ${request.reviewer.employee.lastName}`;
  }
  return request.reviewer.email;
}

function attachmentSrc(mimeType: string | null | undefined, data: string | null | undefined) {
  if (!mimeType || !data) return null;
  return `data:${mimeType};base64,${data}`;
}

type PreviewAttachment = {
  src: string;
  name: string;
  mimeType: string;
};

function getLatestResubmissionAttachment(request: LeaveRequest) {
  const note = [...(request.notes ?? [])].reverse().find((item) => item.type === "RESUBMITTED" && item.attachmentData);
  if (!note?.attachmentData || !note.attachmentMimeType) return null;
  const src = attachmentSrc(note.attachmentMimeType, note.attachmentData);
  if (!src) return null;
  return {
    src,
    name: note.attachmentName ?? "Resubmitted document",
    mimeType: note.attachmentMimeType,
  };
}

// ─── Single-employee summary donut (for the detailed lookup view) ───────────
// Same ring as the employee portal's own "My Leave Balance" card
// (features/employee-portal/components/LeaveBalanceChart) — one arc segment
// per leave type in the shared per-type palette, the used percentage in the
// middle, and Remaining/Earned/Used read out beside it — so an admin looking
// up an employee sees the same picture that employee sees.

const SUMMARY_RING_SIZE = 106;
const SUMMARY_RING_STROKE = 11;
const SUMMARY_RING_RADIUS = (SUMMARY_RING_SIZE - SUMMARY_RING_STROKE) / 2;
const SUMMARY_RING_CIRCUMFERENCE = 2 * Math.PI * SUMMARY_RING_RADIUS;

function EmployeeSummaryDonut({ earnedDays, usedDays, remainingDays, balances }: {
  earnedDays: number;
  usedDays: number;
  remainingDays: number;
  // Same order the per-type rows below the ring are rendered in, so a
  // segment's color always matches its row's dot/bar.
  balances: { leaveTypeId: string; leaveTypeName: string; usedDays: number }[];
}) {
  const usedPercent = earnedDays > 0 ? Math.round((usedDays / earnedDays) * 100) : 0;

  let cumulativeOffset = 0;
  const ringSegments = earnedDays > 0
    ? balances
        .map((balance, index) => {
          const length = (balance.usedDays / earnedDays) * SUMMARY_RING_CIRCUMFERENCE;
          const offset = cumulativeOffset;
          cumulativeOffset += length;
          return { id: balance.leaveTypeId, color: colorForLeaveType(balance.leaveTypeName, index), length, offset };
        })
        .filter((segment) => segment.length > 0)
    : [];

  return (
    <div className="employee-summary-ring-block">
      <div className="employee-summary-donut-wrap">
        <svg width={SUMMARY_RING_SIZE} height={SUMMARY_RING_SIZE}>
          <circle
            cx={SUMMARY_RING_SIZE / 2}
            cy={SUMMARY_RING_SIZE / 2}
            r={SUMMARY_RING_RADIUS}
            fill="none"
            stroke="#eef2f7"
            strokeWidth={SUMMARY_RING_STROKE}
          />
          {ringSegments.map((segment) => (
            <circle
              key={segment.id}
              cx={SUMMARY_RING_SIZE / 2}
              cy={SUMMARY_RING_SIZE / 2}
              r={SUMMARY_RING_RADIUS}
              fill="none"
              stroke={segment.color}
              strokeWidth={SUMMARY_RING_STROKE}
              strokeDasharray={`${segment.length} ${SUMMARY_RING_CIRCUMFERENCE - segment.length}`}
              strokeDashoffset={-segment.offset}
              transform={`rotate(-90 ${SUMMARY_RING_SIZE / 2} ${SUMMARY_RING_SIZE / 2})`}
            />
          ))}
        </svg>
        <div className="employee-summary-donut-center">
          <span className="employee-summary-donut-percent">{usedPercent}% used</span>
        </div>
      </div>

      <div className="employee-summary-stats">
        <div className="employee-summary-hero">
          <span className="employee-summary-hero-value">{remainingDays.toFixed(0)}</span>
          <span className="employee-summary-hero-label">Remaining</span>
        </div>
        <div className="employee-summary-stat-row">
          <span className="employee-summary-stat-label">Earned</span>
          <span className="employee-summary-stat-value">{earnedDays.toFixed(0)}</span>
        </div>
        <div className="employee-summary-stat-row">
          <span className="employee-summary-stat-label">Used</span>
          <span className="employee-summary-stat-value">{usedDays.toFixed(0)}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Table pagination footer (shared by every table in this module) ────────

function LeaveTablePagination({ page, pageCount, onChange }: {
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="leave-pagination">
      <button type="button" className="outline-button" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        Previous
      </button>
      <span>Page {page} of {pageCount}</span>
      <button type="button" className="outline-button" disabled={page >= pageCount} onClick={() => onChange(page + 1)}>
        Next
      </button>
    </div>
  );
}

// A request currently CANCELLATION_PENDING still counts toward usedDays —
// LeaveService.cancel() only flips the status; the balance deduction is only
// reversed once the cancellation itself is approved (LeaveService.
// approveCancellation calls adjustLeaveBalance there, not in cancel()). So
// "still contributes to Used" is APPROVED or CANCELLATION_PENDING, never
// PENDING/REJECTED/CANCELLED — matching adjustLeaveBalance's own rule exactly
// rather than inventing a separate one.
const USED_BALANCE_STATUSES = new Set(["APPROVED", "CANCELLATION_PENDING"]);

// ─── Leave-type balance row (for the detailed lookup view) ──────────────────
// Mirrors the employee self-service "Leave Balance" card content, laid out as
// a wide row so it reads as an extension of the same page.

function EmployeeLeaveTypeRow({
  label,
  color,
  earnedDays,
  usedDays,
  remainingDays,
  employeeId,
  leaveTypeId,
  year,
  allRequests,
}: {
  label: string;
  // The same color this leave type gets in the summary ring above, so a row
  // can be matched to its arc segment.
  color: string;
  earnedDays: number;
  usedDays: number;
  remainingDays: number;
  // Identify exactly which approved LeaveRequest rows fed this row's usedDays
  // (via LeaveService.adjustLeaveBalance), so "View Used Dates" always agrees
  // with the Used figure right next to it — same underlying data, not a
  // separate calculation.
  employeeId: string;
  leaveTypeId: string;
  year: number;
  allRequests: LeaveRequest[];
}) {
  const [showUsedDates, setShowUsedDates] = useState(false);
  const pct = earnedDays > 0 ? Math.min(100, Math.round((remainingDays / earnedDays) * 100)) : 0;

  const usedEntries = allRequests
    .filter(
      (r) =>
        r.employee.id === employeeId &&
        r.leaveType.id === leaveTypeId &&
        USED_BALANCE_STATUSES.has(r.status) &&
        new Date(r.startDate).getFullYear() === year,
    )
    .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());

  return (
    <div className="employee-leave-row-card">
      <span className="employee-leave-row-label">
        <span className="employee-leave-row-dot" style={{ background: color }} />
        {label}
      </span>
      <span className="employee-leave-row-meta">
        Earned: <b>{earnedDays.toFixed(0)}</b>
      </span>
      <span className="employee-leave-row-meta">
        Used: <b>{usedDays.toFixed(0)}</b>
      </span>
      <div className="employee-leave-row-track">
        <div className="employee-leave-row-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="employee-leave-row-remaining">
        <strong>{remainingDays.toFixed(0)}</strong> remaining
      </div>
      <button
        type="button"
        className="employee-leave-row-usedbtn"
        onClick={() => setShowUsedDates(true)}
      >
        View Used Dates
      </button>

      {showUsedDates &&
        createPortal(
          <div className="leave-modal-backdrop" role="presentation" onClick={() => setShowUsedDates(false)}>
            <section
              className="leave-modal leave-modal--sm"
              role="dialog"
              aria-modal="true"
              aria-labelledby="used-dates-modal-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="leave-modal-header">
                <div>
                  <h2 id="used-dates-modal-title">{label} — Used Dates</h2>
                </div>
                <button className="icon-button" onClick={() => setShowUsedDates(false)} aria-label="Close">
                  <X size={18} />
                </button>
              </div>

              <div className="used-dates-body">
                {usedEntries.length === 0 ? (
                  <p className="leave-empty-state">No used dates yet.</p>
                ) : (
                  <>
                    <table className="used-dates-table">
                      <thead>
                        <tr>
                          <th>Date(s)</th>
                          <th>Duration</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {usedEntries.map((entry) => (
                          <tr key={entry.id}>
                            <td>{formatUsedDateRange(entry.startDate, entry.endDate)}</td>
                            <td>{formatDayCount(Number(entry.totalDays))}</td>
                            <td>
                              <Badge tone={getLeaveTone(entry.status)}>{getLeaveStatusLabel(entry.status, true)}</Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="used-dates-total">
                      {/* Same usedDays value as the "Used" figure on the row this
                          button sits in — not re-derived from usedEntries — so the
                          two can never disagree. */}
                      Total Used: <strong>{formatDayCount(Math.round(usedDays))}</strong>
                    </div>
                  </>
                )}
              </div>
            </section>
          </div>,
          document.body,
        )}
    </div>
  );
}

// ─── "View" button on the classification drill-down list ────────────────────
// Opens a modal (portal to document.body, same leave-modal-backdrop pattern
// as the Leave Request review modal below) reproducing the same summary —
// donut, total balance, per-type progress-bar rows — as the full-page
// single-employee detail view, so it reads as an extension of that same
// design instead of a different UI, while staying on the list underneath.

function EmployeeListViewButton({
  employee,
  totalEarnedDays,
  totalUsedDays,
  totalRemainingDays,
  balances,
  year,
  allRequests,
}: {
  employee: DirectoryEmployee;
  totalEarnedDays: number;
  totalUsedDays: number;
  totalRemainingDays: number;
  balances: { leaveTypeId: string; leaveTypeName: string; earnedDays: number; usedDays: number; remainingDays: number }[];
  year: number;
  // Passed straight through to each EmployeeLeaveTypeRow's "View Used Dates"
  // — the same org-wide list LeavePage's own request table already loaded,
  // so this needs no extra fetch of its own.
  allRequests: LeaveRequest[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" className="leave-view-button" onClick={() => setOpen(true)}>
        View
      </button>
      {open &&
        createPortal(
          <div className="leave-modal-backdrop" role="presentation">
            <section
              className="leave-modal leave-modal--balance"
              role="dialog"
              aria-modal="true"
              aria-labelledby="employee-balance-modal-title"
            >
              <div className="leave-modal-header">
                <div>
                  <h2 id="employee-balance-modal-title">
                    {employee.firstName} {employee.lastName}
                  </h2>
                  <p>
                    {formatEmploymentStatus(employee.employmentStatus)} · {year}
                  </p>
                </div>
                <button className="icon-button" onClick={() => setOpen(false)} aria-label="Close">
                  <X size={18} />
                </button>
              </div>

              <div className="employee-balance-modal-body">
                {balances.length === 0 ? (
                  <div className="employee-balance-empty">
                    <div className="employee-balance-empty-icon-wrap">
                      <span className="employee-balance-empty-blob employee-balance-empty-blob--1" />
                      <span className="employee-balance-empty-blob employee-balance-empty-blob--2" />
                      <span className="employee-balance-empty-blob employee-balance-empty-blob--3" />
                      <div className="employee-balance-empty-icon-circle">
                        <IdCard size={30} strokeWidth={1.75} />
                        <span className="employee-balance-empty-badge">
                          <Ban size={14} strokeWidth={2} />
                        </span>
                      </div>
                    </div>
                    <p className="employee-balance-empty-text">No leave balance records for this employee.</p>
                  </div>
                ) : (
                  <>
                    <div className="employee-summary-row">
                      <EmployeeSummaryDonut
                        earnedDays={totalEarnedDays}
                        usedDays={totalUsedDays}
                        remainingDays={totalRemainingDays}
                        balances={balances}
                      />
                    </div>

                    <p className="employee-summary-caption">{employee.firstName.toUpperCase()}'S BALANCE</p>

                    <div className="employee-leave-row-list">
                      {balances.map((b, index) => (
                        <EmployeeLeaveTypeRow
                          key={b.leaveTypeId}
                          label={b.leaveTypeName}
                          color={colorForLeaveType(b.leaveTypeName, index)}
                          earnedDays={b.earnedDays}
                          usedDays={b.usedDays}
                          remainingDays={b.remainingDays}
                          employeeId={employee.id}
                          leaveTypeId={b.leaveTypeId}
                          year={year}
                          allRequests={allRequests}
                        />
                      ))}
                    </div>
                  </>
                )}
              </div>
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}


function YearCalendarPicker({ value, onChange }: { value: number; onChange: (year: number) => void }) {
  const [open, setOpen] = useState(false);
  const [pageStart, setPageStart] = useState(value - (value % 12));
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setPageStart(value - (value % 12));
    function handleClickOutside(event: MouseEvent) {
      if (shellRef.current && !shellRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open, value]);

  const currentYear = new Date().getFullYear();
  const yearGrid = Array.from({ length: 12 }, (_, i) => pageStart + i);

  return (
    <div className="cal-picker-shell" ref={shellRef}>
      <button
        type="button"
        className="cal-picker-trigger"
        onClick={() => setOpen((current) => !current)}
        aria-label="Pick year"
      >
        <CalendarIcon size={14} />
        <strong>{value}</strong>
        <ChevronDown size={14} className={`cal-picker-chevron${open ? " open" : ""}`} />
      </button>

      {open && (
        <div className="cal-picker-menu year-picker-menu">
          <div className="cal-picker-year-row">
            <button
              type="button"
              className="cal-picker-year-nav"
              onClick={() => setPageStart((start) => start - 12)}
              aria-label="Previous years"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="cal-picker-year-label">{yearGrid[0]} – {yearGrid[yearGrid.length - 1]}</span>
            <button
              type="button"
              className="cal-picker-year-nav"
              onClick={() => setPageStart((start) => start + 12)}
              aria-label="Next years"
            >
              <ChevronRight size={14} />
            </button>
          </div>

          <div className="cal-picker-months year-picker-grid">
            {yearGrid.map((year) => (
              <button
                key={year}
                type="button"
                className={`cal-picker-month${year === value ? " active" : ""}${year === currentYear ? " is-current" : ""}`}
                onClick={() => {
                  onChange(year);
                  setOpen(false);
                }}
              >
                {year}
              </button>
            ))}
          </div>

          <button
            type="button"
            className="cal-picker-today-btn"
            onClick={() => {
              onChange(currentYear);
              setOpen(false);
            }}
          >
            Go to current year
          </button>
        </div>
      )}
    </div>
  );
}


const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

function DateFiledPicker({ value, onChange }: { value: string | null; onChange: (date: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [viewDate, setViewDate] = useState(() => (value ? new Date(value) : new Date()));
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(event: MouseEvent) {
      if (shellRef.current && !shellRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = dateKey(new Date());

  const cells: (number | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  return (
    <div className="cal-picker-shell" ref={shellRef}>
      <button
        type="button"
        className="cal-picker-trigger"
        onClick={() => setOpen((current) => !current)}
        aria-label="Filter by date filed"
      >
        <CalendarIcon size={14} />
        <strong>{value ? formatDate(value) : "Filed on..."}</strong>
        <ChevronDown size={14} className={`cal-picker-chevron${open ? " open" : ""}`} />
      </button>

      {open && (
        <div className="cal-picker-menu date-picker-menu">
          <div className="cal-picker-year-row">
            <button
              type="button"
              className="cal-picker-year-nav"
              onClick={() => setViewDate(new Date(year, month - 1, 1))}
              aria-label="Previous month"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="cal-picker-year-label">
              {viewDate.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
            </span>
            <button
              type="button"
              className="cal-picker-year-nav"
              onClick={() => setViewDate(new Date(year, month + 1, 1))}
              aria-label="Next month"
            >
              <ChevronRight size={14} />
            </button>
          </div>

          <div className="date-picker-weekdays">
            {WEEKDAY_LABELS.map((label, index) => (
              <span key={index}>{label}</span>
            ))}
          </div>

          <div className="date-picker-days">
            {cells.map((day, index) => {
              if (day === null) return <span key={index} className="date-picker-day empty" />;
              const key = dateKey(new Date(year, month, day));
              return (
                <button
                  key={index}
                  type="button"
                  className={`date-picker-day${value === key ? " active" : ""}${key === todayKey ? " is-today" : ""}`}
                  onClick={() => {
                    onChange(key);
                    setOpen(false);
                  }}
                >
                  {day}
                </button>
              );
            })}
          </div>

          {value && (
            <button
              type="button"
              className="cal-picker-today-btn"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
            >
              Clear date filter
            </button>
          )}
        </div>
      )}
    </div>
  );
}


export function LeavePage({
  user,
  initialFocusRequestId,
  onFocusRequestHandled,
}: {
  user?: { role: string; roles: string[]; departmentId?: string; department?: string; employeeId?: string };
  // Set when arriving here from a clicked Leave notification — opens that
  // request's review modal directly instead of landing on the plain list.
  initialFocusRequestId?: string;
  onFocusRequestHandled?: () => void;
} = {}) {
  const roles = user?.roles ?? (user?.role ? [user.role] : []);
  const isAdmin = roles.includes("ADMIN");
  // Mirrors the backend's getSupervisorDepartmentScope: a Supervisor who is
  // also an Admin (or not a Supervisor at all) gets full, unscoped access.
  const isDepartmentLocked = roles.includes("SUPERVISOR") && !isAdmin;

  const [topTab, setTopTab]                     = useState<"requests" | "history" | "balances" | "undertime">("requests");
  const [statusFilter, setStatusFilter]         = useState("ALL");
  // Requests tab filters by employee type; History tab still filters by
  // leave type (typeFilter below) — separate state since the two tabs'
  // dropdowns are independent, not the same control shown twice.
  const [requestsClassificationFilter, setRequestsClassificationFilter] = useState("ALL");
  const [typeFilter, setTypeFilter]             = useState("ALL");
  const [historyDepartmentFilter, setHistoryDepartmentFilter] = useState("ALL");
  const [dateFiledFilter, setDateFiledFilter]   = useState<string | null>(null);
  const [searchTerm, setSearchTerm]             = useState("");
  const [reviewRequest, setReviewRequest]       = useState<LeaveRequest | null>(null);
  const [historyViewOnly, setHistoryViewOnly]   = useState(false);
  const [imagePreview, setImagePreview]         = useState<PreviewAttachment | null>(null);
  const [remarks, setRemarks]                   = useState("");
  const [requiresAdditionalRequirements, setRequiresAdditionalRequirements] = useState(false);
  const [requirementDetails, setRequirementDetails] = useState("");
  const [cancelNote, setCancelNote]             = useState("");
  const [isSaving, setIsSaving]                 = useState(false);
  const [notification, setNotification]         = useState<Notification>(null);
  const [reviewBalances, setReviewBalances]     = useState<LeaveBalance[] | null>(null);
  const [reviewUndertime, setReviewUndertime]   = useState<UndertimeFiling | null>(null);
  const [undertimeRemarks, setUndertimeRemarks] = useState("");

  const [summaryYear, setSummaryYear]   = useState(new Date().getFullYear());

  // Employee Type filter for the Leave Balances tab's employee table. "View"
  // on a row opens EmployeeListViewButton's own modal for that employee's
  // full balance breakdown — see that component.
  const [monitorClassification, setMonitorClassification] = useState("ALL");
  const [listSearch, setListSearch] = useState("");
  const [listDepartmentFilter, setListDepartmentFilter] = useState("");
  const [listSort, setListSort] = useState<{ key: "name" | "remaining"; dir: "asc" | "desc" }>({
    key: "name",
    dir: "asc",
  });

  const [requestsPage, setRequestsPage] = useState(1);
  const [historyPage, setHistoryPage] = useState(1);
  const [undertimePage, setUndertimePage] = useState(1);
  const [employeeListPage, setEmployeeListPage] = useState(1);

  const requestsCache = useCachedData<LeaveRequest[]>("admin-leave-requests", () =>
    apiRequest<LeaveRequest[]>("/leave-requests"),
  );
  const requests = requestsCache.data ?? [];
  const loadRequests = () => {
    requestsCache.refresh().catch(() => undefined);
  };

  // There's no push/WebSocket infra in this app — a newly filed request, or
  // an employee's self-cancellation, only lands here on the next fetch.
  // Polling this often while the page is mounted is the pragmatic way to
  // make that feel near-instant without adding real-time transport.
  useEffect(() => {
    const interval = setInterval(() => { requestsCache.refresh().catch(() => undefined); }, 3000);
    // Browsers throttle setInterval in a background tab, so a status change
    // that landed while this tab wasn't focused could sit unnoticed well
    // past the poll interval — catch up the moment the tab is looked at
    // again instead of waiting out whatever's left of a throttled timer.
    const onVisible = () => {
      if (document.visibilityState === "visible") requestsCache.refresh().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [requestsCache.refresh]);

  const leaveTypesCache = useCachedData<LeaveType[]>("leave-types", () => apiRequest<LeaveType[]>("/leave-types"));
  const leaveTypes = leaveTypesCache.data ?? [];

  const undertimeCache = useCachedData<UndertimeFiling[]>("undertime-filings", () =>
    apiRequest<UndertimeFiling[]>("/undertime-filings"),
  );
  const undertimeFilings = undertimeCache.data ?? [];

  // Same "employees" cache key as the Employees/Attendance pages — one
  // fetched copy of GET /employees serves all three.
  const directoryCache = useCachedData<DirectoryEmployee[]>("employees", () =>
    apiRequest<DirectoryEmployee[]>("/employees"),
  );
  const directory = directoryCache.data ?? [];

  const { departmentNames: listDepartmentOptions } = useActiveDepartments();

  // Per-employee balance rows for the Leave Balances tab's employee table —
  // keyed by year + Employee Type so switching either automatically
  // refetches (new hires/classification changes/balance updates all show up
  // with no code change). Only fetched while the tab is actually open.
  const classificationBalancesCache = useCachedData<ClassificationBalanceRow[]>(
    topTab === "balances" ? `leave-balances-by-classification:${summaryYear}:${monitorClassification}` : null,
    () =>
      apiRequest<ClassificationBalanceRow[]>(
        `/leave-balances/by-classification?year=${summaryYear}${
          monitorClassification === "ALL" ? "" : `&employmentStatus=${monitorClassification}`
        }`,
      ),
  );
  const classificationBalances = classificationBalancesCache.data ?? [];

  // Arrived here from a clicked Leave notification — open that request's
  // review modal directly once it shows up in the loaded list, same as
  // clicking its Review button would, then tell the parent we're done with
  // the focus id so it doesn't reapply on a later re-render.
  const focusRefreshAttempted = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!initialFocusRequestId) return;
    const match = requests.find((r) => r.id === initialFocusRequestId);
    if (!match) {
      // The request may be too new for whatever's currently cached (e.g. a
      // just-filed/just-cancelled leave that triggered this very
      // notification) — force one immediate refetch instead of silently
      // waiting on the next unrelated poll to happen to pick it up.
      if (focusRefreshAttempted.current !== initialFocusRequestId) {
        focusRefreshAttempted.current = initialFocusRequestId;
        loadRequests();
      }
      return;
    }
    setReviewRequest(match);
    setRemarks("");
    setRequiresAdditionalRequirements(false);
    setRequirementDetails("");
    setHistoryViewOnly(false);
    onFocusRequestHandled?.();
  }, [requests, initialFocusRequestId]);

  useEffect(() => {
    if (!reviewRequest) {
      setImagePreview(null);
      return;
    }
    const latestResubmissionAttachment = getLatestResubmissionAttachment(reviewRequest);
    if (latestResubmissionAttachment) {
      setImagePreview(latestResubmissionAttachment);
      return;
    }
    if (reviewRequest.attachmentData && reviewRequest.attachmentMimeType) {
      const src = attachmentSrc(reviewRequest.attachmentMimeType, reviewRequest.attachmentData);
      if (src) {
        setImagePreview({
          src,
          name: reviewRequest.attachmentName ?? "Supporting document",
          mimeType: reviewRequest.attachmentMimeType,
        });
      }
    }
  }, [reviewRequest]);

  useEffect(() => {
    if (!notification) return;
    const id = window.setTimeout(() => setNotification(null), 3500);
    return () => window.clearTimeout(id);
  }, [notification]);

  useEffect(() => {
    if (!reviewRequest) {
      setReviewBalances(null);
      return;
    }
    const year = new Date(reviewRequest.startDate).getFullYear();
    apiRequest<LeaveBalance[]>(
      `/leave-balances/${reviewRequest.employee.id}?year=${year}`
    )
      .then(setReviewBalances)
      .catch(() => setReviewBalances(null));
  }, [reviewRequest]);


  const statusCounts = useMemo(() => {
    const counts = { ALL: requests.length, PENDING: 0, APPROVED: 0, REJECTED: 0 };
    for (const r of requests) {
      if (r.status === "PENDING" || r.status === "CANCELLATION_PENDING") counts.PENDING += 1;
      else if (r.status === "APPROVED" || r.status === "SUPERVISOR_APPROVED") counts.APPROVED += 1;
      else if (r.status === "REJECTED" || r.status === "NEEDS_REVISION") counts.REJECTED += 1;
    }
    return counts;
  }, [requests]);

  const visibleRequests = useMemo(
    () =>
      requests.filter((r) => {
        const matchesStatus =
          statusFilter === "ALL" ||
          r.status === statusFilter ||
          (statusFilter === "PENDING" && r.status === "CANCELLATION_PENDING") ||
          (statusFilter === "REJECTED" && r.status === "NEEDS_REVISION");
        const matchesClassification =
          requestsClassificationFilter === "ALL" ||
          r.employee.employmentStatus === requestsClassificationFilter;
        const matchesSearch =
          !searchTerm.trim() ||
          getEmployeeName(r)
            .toLowerCase()
            .includes(searchTerm.trim().toLowerCase());
        return matchesStatus && matchesClassification && matchesSearch;
      }),
    [requests, statusFilter, requestsClassificationFilter, searchTerm]
  );

  useEffect(() => setRequestsPage(1), [statusFilter, requestsClassificationFilter, searchTerm]);
  const requestsPageCount = Math.max(1, Math.ceil(visibleRequests.length / LEAVE_TABLE_PAGE_SIZE));
  const requestsPageSafe = Math.min(requestsPage, requestsPageCount);
  const pagedRequests = visibleRequests.slice(
    (requestsPageSafe - 1) * LEAVE_TABLE_PAGE_SIZE,
    requestsPageSafe * LEAVE_TABLE_PAGE_SIZE,
  );

  // Built from the full employee directory, not just whoever currently has a
  // leave request on file — otherwise a department with zero requests would
  // never appear as a filter option at all. For a scoped Supervisor,
  // `/employees` already only returns their own department, so this list
  // would only ever contain one entry (the dropdown is hidden for them
  // anyway — see isDepartmentLocked below).
  const historyDepartmentOptions = useMemo(() => {
    const names = new Set<string>();
    for (const e of directory) {
      if (e.department?.name) names.add(e.department.name);
    }
    return Array.from(names)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ value: name, label: name }));
  }, [directory]);

  const visibleHistoryRequests = useMemo(
    () =>
      requests
        .filter((r) => {
          const matchesType =
            typeFilter === "ALL" || r.leaveType.id === typeFilter;
          const matchesDepartment =
            historyDepartmentFilter === "ALL" || r.employee.department?.name === historyDepartmentFilter;
          const matchesDate =
            !dateFiledFilter || dateKey(r.createdAt) === dateFiledFilter;
          const matchesSearch =
            !searchTerm.trim() ||
            getEmployeeName(r)
              .toLowerCase()
              .includes(searchTerm.trim().toLowerCase());
          return matchesType && matchesDepartment && matchesDate && matchesSearch;
        })
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [requests, typeFilter, historyDepartmentFilter, dateFiledFilter, searchTerm]
  );

  useEffect(
    () => setHistoryPage(1),
    [typeFilter, historyDepartmentFilter, dateFiledFilter, searchTerm],
  );
  const historyPageCount = Math.max(1, Math.ceil(visibleHistoryRequests.length / LEAVE_TABLE_PAGE_SIZE));
  const historyPageSafe = Math.min(historyPage, historyPageCount);
  const pagedHistoryRequests = visibleHistoryRequests.slice(
    (historyPageSafe - 1) * LEAVE_TABLE_PAGE_SIZE,
    historyPageSafe * LEAVE_TABLE_PAGE_SIZE,
  );

  const undertimePageCount = Math.max(1, Math.ceil(undertimeFilings.length / LEAVE_TABLE_PAGE_SIZE));
  const undertimePageSafe = Math.min(undertimePage, undertimePageCount);
  const pagedUndertimeFilings = undertimeFilings.slice(
    (undertimePageSafe - 1) * LEAVE_TABLE_PAGE_SIZE,
    undertimePageSafe * LEAVE_TABLE_PAGE_SIZE,
  );

  const selectedLeaveType = reviewRequest
    ? leaveTypes.find((t) => t.id === reviewRequest.leaveType.id)
    : undefined;

  // A Supervisor can never review their own leave request — it has to stay
  // PENDING until HR/Admin acts on it directly (mirrors the backend guard in
  // leave.service.ts). An Admin reviewing their own request is unaffected.
  const isOwnRequest = Boolean(reviewRequest && user?.employeeId && reviewRequest.employee.id === user.employeeId);

  // Approval is single-step now; SUPERVISOR_APPROVED only lingers on legacy
  // rows from the old two-step flow, and either role can finalize those.
  const canReviewRequest = Boolean(
    reviewRequest &&
      !(isOwnRequest && !isAdmin) &&
      (reviewRequest.status === "PENDING" || reviewRequest.status === "SUPERVISOR_APPROVED"),
  );

  // Cancelling a filed leave request is reserved for the employee who filed
  // it (self-service, elsewhere) or HR/Admin as a manual-correction override
  // — a Supervisor never cancels, even for their own department, only
  // approves/rejects/requests resubmission (mirrors the backend guard in
  // leave.controller.ts / leave.service.ts).
  const canCancelRequest = Boolean(
    reviewRequest && isAdmin && ["PENDING", "SUPERVISOR_APPROVED", "APPROVED"].includes(reviewRequest.status),
  );

  // An employee's request to cancel their own already-approved leave sits
  // here until a Supervisor/Admin decides on it (mirrors leave.service.ts's
  // approveCancellation/denyCancellation) — same self-review guard as the
  // normal review actions above.
  const canDecideCancellation = Boolean(
    reviewRequest && !(isOwnRequest && !isAdmin) && reviewRequest.status === "CANCELLATION_PENDING",
  );

  // Same self-review pattern as leave requests — a Supervisor can never
  // review their own filing, only HR/Admin can (mirrors undertime.service.ts's
  // updateStatus guards).
  const isOwnUndertime = Boolean(reviewUndertime && user?.employeeId && reviewUndertime.employee.id === user.employeeId);
  const canReviewUndertime = Boolean(
    reviewUndertime && !(isOwnUndertime && !isAdmin) && reviewUndertime.status === "PENDING",
  );

  const matchingBalance =
    reviewRequest && reviewBalances
      ? reviewBalances.find((b) => b.leaveTypeId === reviewRequest.leaveType.id)
      : undefined;

  const wouldExceedBalance = Boolean(
    matchingBalance &&
      reviewRequest &&
      reviewRequest.status !== "APPROVED" &&
      !selectedLeaveType?.allowWithoutPay &&
      Number(reviewRequest.totalDays) > matchingBalance.remainingDays
  );


  function toggleListSort(key: "name" | "remaining") {
    setListSort((current) =>
      current.key === key ? { key, dir: current.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" },
    );
  }

  const classificationListRows = useMemo(() => {
    const directoryById = new Map(directory.map((e) => [e.id, e]));
    const query = listSearch.trim().toLowerCase();

    const rows = classificationBalances
      .map((row) => {
        const employee = directoryById.get(row.employeeId);
        return employee ? { ...row, employee } : null;
      })
      .filter((row): row is ClassificationBalanceRow & { employee: DirectoryEmployee } => row !== null)
      .filter((row) => {
        if (!listDepartmentFilter) return true;
        return row.employee.department?.name === listDepartmentFilter;
      })
      .filter((row) => {
        if (!query) return true;
        const name = `${row.employee.firstName} ${row.employee.lastName}`.toLowerCase();
        return name.includes(query) || row.employee.employeeNo.toLowerCase().includes(query);
      });

    const dir = listSort.dir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      if (listSort.key === "remaining") return (a.totalRemainingDays - b.totalRemainingDays) * dir;
      const nameA = `${a.employee.firstName} ${a.employee.lastName}`;
      const nameB = `${b.employee.firstName} ${b.employee.lastName}`;
      return nameA.localeCompare(nameB) * dir;
    });

    return rows;
  }, [classificationBalances, directory, listDepartmentFilter, listSearch, listSort]);

  useEffect(
    () => setEmployeeListPage(1),
    [listDepartmentFilter, listSearch, listSort, monitorClassification],
  );
  const employeeListPageCount = Math.max(1, Math.ceil(classificationListRows.length / EMPLOYEE_LIST_PAGE_SIZE));
  const employeeListPageSafe = Math.min(employeeListPage, employeeListPageCount);
  const pagedClassificationListRows = classificationListRows.slice(
    (employeeListPageSafe - 1) * EMPLOYEE_LIST_PAGE_SIZE,
    employeeListPageSafe * EMPLOYEE_LIST_PAGE_SIZE,
  );

  // Optimistic — the click already told us what the outcome will be (there's
  // nothing left for the server to decide that the UI doesn't already know),
  // so reflect the new status everywhere this cache is read from immediately
  // instead of waiting on the round trip, and only correct course if the
  // background call actually fails.
  const reviewLeave = (action: "approve" | "reject") => {
    if (!reviewRequest) return;
    const targetId = reviewRequest.id;
    const newStatus = action === "approve" ? "APPROVED" : requiresAdditionalRequirements ? "NEEDS_REVISION" : "REJECTED";
    const remarksTrimmed = remarks.trim();
    const requirementDetailsTrimmed = requirementDetails.trim();
    const requiresAdditionalRequirementsSnapshot = requiresAdditionalRequirements;

    requestsCache.setData(requests.map((r) => (r.id === targetId ? { ...r, status: newStatus } : r)));
    setReviewRequest(null);
    setRemarks("");
    setRequiresAdditionalRequirements(false);
    setRequirementDetails("");
    setNotification({
      type: "success",
      message:
        action === "approve"
          ? "Leave request was approved."
          : requiresAdditionalRequirementsSnapshot
            ? "Leave request was returned to the employee for additional requirements."
            : "Leave request was rejected.",
    });

    apiRequest(`/leave-requests/${targetId}/${action}`, {
      method: "PATCH",
      body: JSON.stringify(
        action === "reject"
          ? { remarks: remarksTrimmed, requiresAdditionalRequirements: requiresAdditionalRequirementsSnapshot, requirementDetails: requirementDetailsTrimmed }
          : { remarks: remarksTrimmed }
      ),
    })
      .then(() => {
        loadRequests();
        classificationBalancesCache.refresh().catch(() => undefined);
      })
      .catch((err) => {
        // The optimistic status above was wrong — re-sync with the real
        // server state instead of leaving a false "Approved"/"Rejected"
        // showing.
        loadRequests();
        setNotification({
          type: "error",
          message:
            err instanceof Error
              ? `${action === "approve" ? "Approval" : "Rejection"} failed: ${err.message}`
              : "Unable to review leave.",
        });
      });
  };

  // Same optimistic pattern as reviewLeave above.
  const reviewUndertimeFiling = (action: "approve" | "reject") => {
    if (!reviewUndertime) return;
    const targetId = reviewUndertime.id;
    const newStatus = action === "approve" ? "APPROVED" : "REJECTED";
    const remarksTrimmed = undertimeRemarks.trim();

    undertimeCache.setData(undertimeFilings.map((f) => (f.id === targetId ? { ...f, status: newStatus } : f)));
    setReviewUndertime(null);
    setUndertimeRemarks("");
    setNotification({
      type: "success",
      message: action === "approve" ? "Undertime filing was approved." : "Undertime filing was rejected.",
    });

    apiRequest(`/undertime-filings/${targetId}/${action}`, {
      method: "PATCH",
      body: JSON.stringify({ remarks: remarksTrimmed }),
    })
      .then(() => undertimeCache.refresh())
      .catch((err) => {
        undertimeCache.refresh().catch(() => undefined);
        setNotification({
          type: "error",
          message:
            err instanceof Error
              ? `${action === "approve" ? "Approval" : "Rejection"} failed: ${err.message}`
              : "Unable to review undertime filing.",
        });
      });
  };

  // Admin/Supervisor cancellation is not bound by the 24-hour post-approval
  // grace window employee self-cancel is (see leave.service.ts's cancel()) —
  // an elevated actor cancelling on the employee's behalf is treated as an
  // override, same as the self-review bypass already used elsewhere here.
  // Optimistic, same as reviewLeave above — this is an ADMIN override (see
  // canCancelRequest), which the backend always finalizes to CANCELLED
  // immediately rather than routing through CANCELLATION_PENDING.
  const cancelRequest = () => {
    if (!reviewRequest) return;
    if (!cancelNote.trim()) {
      setNotification({ type: "error", message: "Please provide a reason for cancelling this leave request." });
      return;
    }
    const targetId = reviewRequest.id;
    const noteTrimmed = cancelNote.trim();

    requestsCache.setData(requests.map((r) => (r.id === targetId ? { ...r, status: "CANCELLED" } : r)));
    setReviewRequest(null);
    setCancelNote("");
    setNotification({ type: "success", message: "Leave request was cancelled." });

    apiRequest(`/leave-requests/${targetId}/cancel`, {
      method: "PATCH",
      body: JSON.stringify({ note: noteTrimmed }),
    })
      .then(() => {
        loadRequests();
        classificationBalancesCache.refresh().catch(() => undefined);
      })
      .catch((err) => {
        loadRequests();
        setNotification({
          type: "error",
          message: err instanceof Error ? `Cancellation failed: ${err.message}` : "Unable to cancel leave request.",
        });
      });
  };

  // The employee's own cancellation request for their already-approved
  // leave — finalizes to CANCELLED (approve) or reverts to APPROVED as if
  // nothing happened (deny). Mirrors leave.service.ts's
  // approveCancellation/denyCancellation. Optimistic, same as reviewLeave.
  const decideCancellation = (decision: "approve" | "deny") => {
    if (!reviewRequest) return;
    const targetId = reviewRequest.id;
    const remarksTrimmed = remarks.trim();
    const revertStatus = reviewRequest.preCancellationStatus ?? "APPROVED";
    const newStatus = decision === "approve" ? "CANCELLED" : revertStatus;

    requestsCache.setData(requests.map((r) => (r.id === targetId ? { ...r, status: newStatus } : r)));
    setReviewRequest(null);
    setRemarks("");
    setNotification({
      type: "success",
      message: decision === "approve" ? "Leave cancellation was approved." : "Leave cancellation was denied — the leave remains approved.",
    });

    apiRequest(`/leave-requests/${targetId}/${decision}-cancellation`, {
      method: "PATCH",
      ...(decision === "deny" ? { body: JSON.stringify({ remarks: remarksTrimmed || undefined }) } : {}),
    })
      .then(() => {
        loadRequests();
        classificationBalancesCache.refresh().catch(() => undefined);
      })
      .catch((err) => {
        loadRequests();
        setNotification({
          type: "error",
          message: err instanceof Error ? `Decision failed: ${err.message}` : "Unable to decide on this cancellation request.",
        });
      });
  };

  const decideExtension = async (extensionApproved: boolean) => {
    if (!reviewRequest) return;
    setIsSaving(true);
    try {
      await apiRequest(`/leave-requests/${reviewRequest.id}/extension-decision`, {
        method: "PATCH",
        body: JSON.stringify({ extensionApproved }),
      });
      setReviewRequest(null);
      setNotification({
        type: "success",
        message: `Maternity extension was ${extensionApproved ? "approved" : "rejected"}.`,
      });
      loadRequests();
    } catch (err) {
      setNotification({
        type: "error",
        message: err instanceof Error ? err.message : "Unable to decide extension.",
      });
    } finally {
      setIsSaving(false);
    }
  };


  return (
    <>
      {notification && (
        <div className={`leave-notification ${notification.type}`} role="status">
          {notification.type === "success"
            ? <CheckCircle2 size={17} />
            : <AlertTriangle size={17} />}
          <span>{notification.message}</span>
        </div>
      )}

      <div className="leave-section-tabs">
        <button className={topTab === "requests" ? "active" : ""} onClick={() => setTopTab("requests")}>
          Leave Requests
        </button>
        <button className={topTab === "history" ? "active" : ""} onClick={() => setTopTab("history")}>
          Leave History
        </button>
        <button className={topTab === "balances" ? "active" : ""} onClick={() => setTopTab("balances")}>
          Leave Balances
        </button>
        <button className={topTab === "undertime" ? "active" : ""} onClick={() => setTopTab("undertime")}>
          Undertime
        </button>
      </div>

      {topTab === "requests" && (
        <>
          <div className="leave-toolbar">
            <div className="filter-tabs">
              {(["ALL", "PENDING", "APPROVED", "REJECTED"] as const).map((tab) => (
                <button
                  key={tab}
                  className={statusFilter === tab ? "active" : ""}
                  onClick={() => setStatusFilter(tab)}
                >
                  {tab === "ALL" ? "All Leave" : tab.charAt(0) + tab.slice(1).toLowerCase()}
                  {" "}({statusCounts[tab]})
                </button>
              ))}
            </div>

            <div className="leave-table-toolbar">
              <DropdownFilter
                className="leave-select"
                value={requestsClassificationFilter}
                onChange={setRequestsClassificationFilter}
                options={SELECTABLE_EMPLOYMENT_STATUS_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                allLabel="All Employee Types"
                menuLabel="Filter by employee type"
                ariaLabel="Filter by employee type"
              />
              <div className="leave-search">
                <Search size={14} />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Search employee..."
                  aria-label="Search by employee name"
                />
              </div>
            </div>
          </div>

          {/* ── Table ── */}
          <section className="table-card leave-table-card">
            <div className="leave-table-scroll leave-table-scroll-fixed">
            <table>
              <thead>
                <tr>
                  <th>EMPLOYEE</th>
                  <th>DEPARTMENT</th>
                  <th>EMPLOYEE TYPE</th>
                  <th>LEAVE TYPE</th>
                  <th>DATES</th>
                  <th>DAYS</th>
                  <th>STATUS</th>
                  <th>ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                {visibleRequests.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="leave-empty-state">
                      {requests.length === 0
                        ? "No leave requests found."
                        : "No leave requests match your current filters."}
                    </td>
                  </tr>
                ) : (
                  pagedRequests.map((r) => (
                    <tr key={r.id}>
                      <td data-label="Employee">{getEmployeeName(r)}</td>
                      <td data-label="Department">{r.employee.department?.name ?? "Unassigned"}</td>
                      <td data-label="Employee Type">{formatEmploymentStatus(r.employee.employmentStatus)}</td>
                      <td data-label="Leave Type">{r.leaveType.name}</td>
                      <td data-label="Dates">
                        {formatDate(r.startDate)} – {formatDate(r.endDate)}
                      </td>
                      <td data-label="Days">{r.totalDays}</td>
                      <td data-label="Status">
                        <Badge tone={getLeaveTone(r.status)}>{getLeaveStatusLabel(r.status, isAdmin)}</Badge>
                      </td>
                      <td data-label="Action">
                        <button
                          className="leave-view-button"
                          onClick={() => { setReviewRequest(r); setRemarks(""); setRequiresAdditionalRequirements(false); setRequirementDetails(""); setCancelNote(""); setHistoryViewOnly(false); }}
                        >
                          <Eye size={14} /> Review
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            </div>
            <LeaveTablePagination page={requestsPageSafe} pageCount={requestsPageCount} onChange={setRequestsPage} />
          </section>
        </>
      )}

      {topTab === "history" && (
        <>
          <div className="leave-toolbar">
            <div className="leave-table-toolbar leave-table-toolbar-left">
              {!isDepartmentLocked && (
                <DropdownFilter
                  className="leave-select"
                  value={historyDepartmentFilter}
                  onChange={setHistoryDepartmentFilter}
                  options={historyDepartmentOptions}
                  allLabel="All Departments"
                  menuLabel="Filter by department"
                  ariaLabel="Filter by department"
                />
              )}
              <DropdownFilter
                className="leave-select"
                value={typeFilter}
                onChange={setTypeFilter}
                options={leaveTypes.map((t) => ({ value: t.id, label: t.name }))}
                allLabel="All Leave Types"
                menuLabel="Filter by leave type"
                ariaLabel="Filter by leave type"
              />
            </div>

            <div className="leave-table-toolbar">
              <DateFiledPicker value={dateFiledFilter} onChange={setDateFiledFilter} />
              <div className="leave-search">
                <Search size={14} />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Search employee..."
                  aria-label="Search by employee name"
                />
              </div>
            </div>
          </div>

          {/* ── History table ── */}
          <section className="table-card leave-table-card">
            <div className="leave-table-scroll leave-table-scroll-fixed">
            <table>
              <thead>
                <tr>
                  <th>EMPLOYEE</th>
                  <th>DEPARTMENT</th>
                  <th>EMPLOYEE TYPE</th>
                  <th>LEAVE TYPE</th>
                  <th>DATE FILED</th>
                  <th>DAYS</th>
                  <th>STATUS</th>
                  <th>ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                {visibleHistoryRequests.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="leave-empty-state">
                      {requests.length === 0
                        ? "No leave history found."
                        : "No leave history matches your current filters."}
                    </td>
                  </tr>
                ) : (
                  pagedHistoryRequests.map((r) => (
                    <tr key={r.id}>
                      <td data-label="Employee">{getEmployeeName(r)}</td>
                      <td data-label="Department">{r.employee.department?.name ?? "Unassigned"}</td>
                      <td data-label="Employee Type">{formatEmploymentStatus(r.employee.employmentStatus)}</td>
                      <td data-label="Leave Type">{r.leaveType.name}</td>
                      <td data-label="Date Filed">{formatDate(r.createdAt)}</td>
                      <td data-label="Days">{r.totalDays}</td>
                      <td data-label="Status">
                        <Badge tone={getLeaveTone(r.status)}>{getLeaveStatusLabel(r.status, isAdmin)}</Badge>
                      </td>
                      <td data-label="Action">
                        <button
                          className="leave-view-button"
                          onClick={() => { setReviewRequest(r); setRemarks(""); setRequiresAdditionalRequirements(false); setRequirementDetails(""); setCancelNote(""); setHistoryViewOnly(true); }}
                        >
                          <Eye size={14} /> View
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            </div>
            <LeaveTablePagination page={historyPageSafe} pageCount={historyPageCount} onChange={setHistoryPage} />
          </section>
        </>
      )}

      {topTab === "balances" && (
        <div className="employee-list-section">
          <div className="employee-list-toolbar">
            <div className="leave-search employee-list-search">
              <Search size={14} />
              <input
                type="text"
                value={listSearch}
                onChange={(e) => setListSearch(e.target.value)}
                placeholder="Search…"
                aria-label="Search employees"
              />
            </div>

            <div className="employee-list-toolbar-right">
              <DropdownFilter
                className="employee-list-type-filter"
                value={monitorClassification}
                onChange={setMonitorClassification}
                options={SELECTABLE_EMPLOYMENT_STATUS_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                allLabel="All Employee Types"
                allValue="ALL"
                menuLabel="Filter by employee type"
                ariaLabel="Filter employees by employee type"
              />

              <DropdownFilter
                className="employee-list-department-filter"
                value={listDepartmentFilter}
                onChange={setListDepartmentFilter}
                options={listDepartmentOptions.map((name) => ({ value: name, label: name }))}
                allLabel="All Departments"
                allValue=""
                menuLabel="Filter by department"
                ariaLabel="Filter employees by department"
              />

              <YearCalendarPicker value={summaryYear} onChange={setSummaryYear} />
            </div>
          </div>

          {!classificationBalancesCache.data ? (
            <p className="leave-summary-empty">Loading employee balances…</p>
          ) : classificationListRows.length === 0 ? (
            <p className="leave-summary-empty">No employees match this filter.</p>
          ) : (
            <div className="leave-table-card">
              <div className="leave-table-scroll employee-list-table-scroll">
              <table className="employee-list-fixed-table">
                <colgroup>
                  <col style={{ width: "26%" }} />
                  <col style={{ width: "20%" }} />
                  <col style={{ width: "20%" }} />
                  <col style={{ width: "18%" }} />
                  <col style={{ width: "16%" }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>
                      <button type="button" className="employee-list-sort-th" onClick={() => toggleListSort("name")}>
                        NAME {listSort.key === "name" ? (listSort.dir === "asc" ? "▲" : "▼") : ""}
                      </button>
                    </th>
                    <th>DEPARTMENT</th>
                    <th>EMPLOYEE TYPE</th>
                    <th>
                      <button type="button" className="employee-list-sort-th" onClick={() => toggleListSort("remaining")}>
                        TOTAL REMAINING {listSort.key === "remaining" ? (listSort.dir === "asc" ? "▲" : "▼") : ""}
                      </button>
                    </th>
                    <th>ACTION</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedClassificationListRows.map((row) => (
                    <tr key={row.employeeId}>
                      <td data-label="Name" title={`${row.employee.firstName} ${row.employee.lastName}`}>{row.employee.firstName} {row.employee.lastName}</td>
                      <td data-label="Department" title={row.employee.department?.name ?? "Unassigned"}>{row.employee.department?.name ?? "Unassigned"}</td>
                      <td data-label="Employee Type">{formatEmploymentStatus(row.employee.employmentStatus)}</td>
                      <td data-label="Total Remaining">{row.totalRemainingDays.toFixed(0)}</td>
                      <td data-label="Action">
                        <EmployeeListViewButton
                          employee={row.employee}
                          totalEarnedDays={row.totalEarnedDays}
                          totalUsedDays={row.totalUsedDays}
                          totalRemainingDays={row.totalRemainingDays}
                          balances={row.balances}
                          year={summaryYear}
                          allRequests={requests}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              <LeaveTablePagination page={employeeListPageSafe} pageCount={employeeListPageCount} onChange={setEmployeeListPage} />
            </div>
          )}
        </div>
      )}

      {topTab === "undertime" && (
        <section className="table-card leave-table-card">
          <div className="leave-table-scroll">
          <table>
            <thead>
              <tr>
                <th>EMPLOYEE</th>
                <th>DEPARTMENT</th>
                <th>ATTENDANCE DATE</th>
                <th>LATE MINUTES</th>
                <th>STATUS</th>
                <th>ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {undertimeFilings.length === 0 ? (
                <tr>
                  <td colSpan={6} className="leave-empty-state">No undertime filings found.</td>
                </tr>
              ) : (
                pagedUndertimeFilings.map((f) => (
                  <tr key={f.id}>
                    <td data-label="Employee">{f.employee.firstName} {f.employee.lastName}</td>
                    <td data-label="Department">{f.employee.department?.name ?? "Unassigned"}</td>
                    <td data-label="Attendance Date">{f.attendanceRecord ? formatDate(f.attendanceRecord.attendanceDate) : formatDate(f.filingDate)}</td>
                    <td data-label="Late Minutes">{f.attendanceRecord?.lateMinutes ?? "—"}</td>
                    <td data-label="Status">
                      <Badge tone={getLeaveTone(f.status)}>{getLeaveStatusLabel(f.status, isAdmin)}</Badge>
                    </td>
                    <td data-label="Action">
                      <button
                        className="leave-view-button"
                        onClick={() => { setReviewUndertime(f); setUndertimeRemarks(""); }}
                      >
                        <Eye size={14} /> Review
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          </div>
          <LeaveTablePagination page={undertimePageSafe} pageCount={undertimePageCount} onChange={setUndertimePage} />
        </section>
      )}

      {/* ── Review modal ── */}
      {reviewRequest && (
        <div className="leave-modal-backdrop" role="presentation">
          <section
            className="leave-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="leave-review-title"
          >
            <div className="leave-modal-header">
              <div>
                <h2 id="leave-review-title">Leave Request Details</h2>
                <p>{getEmployeeName(reviewRequest)}</p>
              </div>
              <button
                className="icon-button"
                onClick={() => { setReviewRequest(null); setHistoryViewOnly(false); }}
                aria-label="Close leave review"
              >
                <X size={18} />
              </button>
            </div>

            <div className="leave-modal-body">
            <div
              className={`leave-photo-frame${
                attachmentSrc(reviewRequest.attachmentMimeType, reviewRequest.attachmentData) &&
                !reviewRequest.attachmentMimeType?.startsWith("image/")
                  ? " leave-photo-frame--file"
                  : ""
              }`}
            >
              {attachmentSrc(reviewRequest.attachmentMimeType, reviewRequest.attachmentData) ? (
                reviewRequest.attachmentMimeType?.startsWith("image/") ? (
                  <button
                    type="button"
                    className="leave-photo-capture-button"
                    onClick={() =>
                      setImagePreview({
                        src: attachmentSrc(reviewRequest.attachmentMimeType, reviewRequest.attachmentData)!,
                        name: reviewRequest.attachmentName ?? "Supporting document",
                        mimeType: reviewRequest.attachmentMimeType ?? "image/*",
                      })
                    }
                  >
                    <img
                      className="leave-photo-capture"
                      src={attachmentSrc(reviewRequest.attachmentMimeType, reviewRequest.attachmentData)!}
                      alt={reviewRequest.attachmentName ?? "Supporting document"}
                    />
                  </button>
                ) : (
                  <a
                    className="leave-attachment-link leave-attachment-link--inline"
                    href={attachmentSrc(reviewRequest.attachmentMimeType, reviewRequest.attachmentData)!}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <FileText size={14} /> {reviewRequest.attachmentName ?? "View document"}
                  </a>
                )
              ) : (
                <div className="leave-photo-empty">No document submitted</div>
              )}
            </div>

            <div className="leave-detail-grid">
              <div><span>Employee</span><strong>{getEmployeeName(reviewRequest)}</strong></div>
              <div><span>Department</span><strong>{reviewRequest.employee.department?.name ?? "Unassigned"}</strong></div>
              <div><span>Employee Type</span><strong>{formatEmploymentStatus(reviewRequest.employee.employmentStatus)}</strong></div>
              <div><span>Leave Type</span><strong>{reviewRequest.leaveType.name}</strong></div>
              <div><span>Date Filed</span><strong>{formatDate(reviewRequest.createdAt)}</strong></div>
              <div>
                <span>Date Range</span>
                <strong>{formatDate(reviewRequest.startDate)} – {formatDate(reviewRequest.endDate)}</strong>
              </div>
              <div><span>Total Days</span><strong>{reviewRequest.totalDays}</strong></div>
              <div>
                <span>Status</span>
                <Badge tone={getLeaveTone(reviewRequest.status)}>{getLeaveStatusLabel(reviewRequest.status, isAdmin)}</Badge>
              </div>
              {reviewRequest.status !== "PENDING" && (
                <div><span>Reviewed By</span><strong>{reviewerName(reviewRequest)}</strong></div>
              )}

              {matchingBalance && (
                <div>
                  <span>Leave Balance ({matchingBalance.year})</span>
                  <strong className={wouldExceedBalance ? "leave-balance-warning" : ""}>
                    {formatEmploymentStatus(reviewRequest.employee.employmentStatus)} — {matchingBalance.remainingDays} of {matchingBalance.earnedDays} days remaining
                  </strong>
                </div>
              )}

              {wouldExceedBalance && (
                <div className="leave-balance-alert">
                  <AlertTriangle size={14} />
                  <span>This request exceeds the employee's remaining balance for this leave type.</span>
                </div>
              )}

              {selectedLeaveType?.requiresDocument && (
                <div>
                  <span>Document Required</span>
                  <strong className="leave-requires-doc">Yes, per policy</strong>
                </div>
              )}

              {reviewRequest.extensionRequested && (
                <div>
                  <span>Extension Requested</span>
                  <Badge tone={reviewRequest.extensionApproved == null ? "warning" : reviewRequest.extensionApproved ? "success" : "danger"}>
                    {reviewRequest.extensionApproved == null
                      ? "Pending decision"
                      : reviewRequest.extensionApproved
                        ? "Approved"
                        : "Rejected"}
                  </Badge>
                </div>
              )}

              <div><span>Reason</span><strong>{reviewRequest.reason}</strong></div>
            </div>

            <LeaveTimeline history={reviewRequest.history} status={reviewRequest.status} />

            {reviewRequest.notes && reviewRequest.notes.length > 0 && (
              <div className="leave-notes-thread">
                <span className="leave-notes-thread-label">Requirements / Resubmission History</span>
                {reviewRequest.notes.map((note) => (
                  <div key={note.id} className={`leave-note leave-note-${note.type.toLowerCase()}`}>
                    <div className="leave-note-header">
                      <strong>
                        {note.type === "REJECTED"
                          ? note.requiresAdditionalRequirements
                            ? "Additional requirements requested"
                            : "Rejected"
                          : note.type === "CANCELLED"
                            ? "Cancellation requested"
                            : "Employee resubmitted"}
                      </strong>
                      <time>{new Date(note.createdAt).toLocaleString()}</time>
                    </div>
                    {note.message && <p>{note.message}</p>}
                    {note.requirementDetails && (
                      <p><em>Requirement needed:</em> {note.requirementDetails}</p>
                    )}
                    {attachmentSrc(note.attachmentMimeType, note.attachmentData) && (
                      note.attachmentMimeType?.startsWith("image/") ? (
                        <button
                          type="button"
                          className="leave-attachment-preview leave-attachment-preview--inline"
                          onClick={() =>
                            setImagePreview({
                              src: attachmentSrc(note.attachmentMimeType, note.attachmentData)!,
                              name: note.attachmentName ?? "Attached requirement",
                              mimeType: note.attachmentMimeType ?? "image/*",
                            })
                          }
                        >
                          <img
                            src={attachmentSrc(note.attachmentMimeType, note.attachmentData)!}
                            alt={note.attachmentName ?? "Attached requirement"}
                          />
                          <span><Paperclip size={13} /> {note.attachmentName ?? "View attachment"}</span>
                        </button>
                      ) : (
                        <a
                          className="leave-attachment-link leave-attachment-link--inline"
                          href={attachmentSrc(note.attachmentMimeType, note.attachmentData)!}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <FileText size={14} /> {note.attachmentName ?? "View document"}
                        </a>
                      )
                    )}
                  </div>
                ))}
              </div>
            )}

            {!historyViewOnly && isOwnRequest && !isAdmin && (
              <p className="leave-remarks-field">
                This is your own leave request — a Supervisor cannot approve or reject it. It stays pending until HR/Admin reviews it.
              </p>
            )}

            {!historyViewOnly && canReviewRequest && (
              <>
                <label className="leave-remarks-field">
                  Add Remarks
                  <textarea
                    value={remarks}
                    onChange={(e) => setRemarks(e.target.value)}
                    placeholder="Optional review notes"
                  />
                </label>

                <label className="leave-requirements-checkbox">
                  <input
                    type="checkbox"
                    checked={requiresAdditionalRequirements}
                    onChange={(e) => setRequiresAdditionalRequirements(e.target.checked)}
                  />
                  <span>Reject because it requires additional requirements (employee can resubmit)</span>
                </label>

                {requiresAdditionalRequirements && (
                  <label className="leave-remarks-field">
                    Requirement needed
                    <textarea
                      value={requirementDetails}
                      onChange={(e) => setRequirementDetails(e.target.value)}
                      placeholder="e.g. Medical certificate, proof of travel..."
                    />
                  </label>
                )}
              </>
            )}

            {!historyViewOnly && canCancelRequest && (
              <label className="leave-remarks-field">
                Cancellation Reason
                <textarea
                  value={cancelNote}
                  onChange={(e) => setCancelNote(e.target.value)}
                  placeholder="Why is this leave request being cancelled?"
                />
              </label>
            )}

            <div className="leave-detail-actions">
              {!historyViewOnly && canDecideCancellation && (
                <>
                  <button className="leave-reject-button" onClick={() => decideCancellation("deny")} disabled={isSaving}>
                    Deny Cancellation
                  </button>
                  <button className="primary-button" onClick={() => decideCancellation("approve")} disabled={isSaving}>
                    Approve Cancellation
                  </button>
                </>
              )}
              {!historyViewOnly && canReviewRequest && (
                <>
                  <button className="leave-reject-button" onClick={() => reviewLeave("reject")} disabled={isSaving}>
                    {requiresAdditionalRequirements ? "Reject & Request Resubmission" : "Reject"}
                  </button>
                  {!requiresAdditionalRequirements && (
                    <button className="primary-button" onClick={() => reviewLeave("approve")} disabled={isSaving}>
                      Approve
                    </button>
                  )}
                </>
              )}
              {!historyViewOnly && canCancelRequest && (
                <button className="leave-reject-button" onClick={cancelRequest} disabled={isSaving || !cancelNote.trim()}>
                  Cancel Leave
                </button>
              )}
              {!historyViewOnly && isAdmin && reviewRequest.extensionRequested && reviewRequest.extensionApproved == null && (
                <>
                  <button className="leave-reject-button" onClick={() => decideExtension(false)} disabled={isSaving}>
                    Reject Extension
                  </button>
                  <button className="primary-button" onClick={() => decideExtension(true)} disabled={isSaving}>
                    Approve Extension
                  </button>
                </>
              )}
              <button
                className="outline-button"
                onClick={() => { setReviewRequest(null); setHistoryViewOnly(false); }}
                disabled={isSaving}
              >
                Close
              </button>
            </div>
            </div>
          </section>
        </div>
      )}

      {/* ── Undertime review modal ── */}
      {reviewUndertime && (
        <div className="leave-modal-backdrop" role="presentation">
          <section
            className="leave-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="undertime-review-title"
          >
            <div className="leave-modal-header">
              <div>
                <h2 id="undertime-review-title">Undertime Filing Details</h2>
                <p>{reviewUndertime.employee.firstName} {reviewUndertime.employee.lastName}</p>
              </div>
              <button
                className="icon-button"
                onClick={() => setReviewUndertime(null)}
                aria-label="Close undertime review"
              >
                <X size={18} />
              </button>
            </div>

            <div className="leave-modal-body">
              <div className="leave-detail-grid">
                <div><span>Employee</span><strong>{reviewUndertime.employee.firstName} {reviewUndertime.employee.lastName}</strong></div>
                <div><span>Department</span><strong>{reviewUndertime.employee.department?.name ?? "Unassigned"}</strong></div>
                {reviewUndertime.attendanceRecord && (
                  <>
                    <div><span>Attendance Date</span><strong>{formatDate(reviewUndertime.attendanceRecord.attendanceDate)}</strong></div>
                    <div><span>Late Minutes</span><strong>{reviewUndertime.attendanceRecord.lateMinutes}</strong></div>
                  </>
                )}
                <div><span>Date Filed</span><strong>{formatDate(reviewUndertime.createdAt)}</strong></div>
                <div>
                  <span>Status</span>
                  <Badge tone={getLeaveTone(reviewUndertime.status)}>{getLeaveStatusLabel(reviewUndertime.status, isAdmin)}</Badge>
                </div>
                {reviewUndertime.status !== "PENDING" && (
                  <div><span>Reviewed By</span><strong>{undertimeReviewerName(reviewUndertime)}</strong></div>
                )}
                <div><span>Reason</span><strong>{reviewUndertime.reason ?? "—"}</strong></div>
                {reviewUndertime.status !== "PENDING" && reviewUndertime.remarks && (
                  <div><span>Remarks</span><strong>{reviewUndertime.remarks}</strong></div>
                )}
              </div>

              {isOwnUndertime && !isAdmin && (
                <p className="leave-remarks-field">
                  This is your own undertime filing — a Supervisor cannot approve or reject it. It stays pending until HR/Admin reviews it.
                </p>
              )}

              {canReviewUndertime && (
                <label className="leave-remarks-field">
                  Add Remarks
                  <textarea
                    value={undertimeRemarks}
                    onChange={(e) => setUndertimeRemarks(e.target.value)}
                    placeholder="Optional review notes"
                  />
                </label>
              )}

              <div className="leave-detail-actions">
                {canReviewUndertime && (
                  <>
                    <button className="leave-reject-button" onClick={() => reviewUndertimeFiling("reject")} disabled={isSaving}>
                      Reject
                    </button>
                    <button className="primary-button" onClick={() => reviewUndertimeFiling("approve")} disabled={isSaving}>
                      Approve
                    </button>
                  </>
                )}
                <button className="outline-button" onClick={() => setReviewUndertime(null)} disabled={isSaving}>
                  Close
                </button>
              </div>
            </div>
          </section>
        </div>
      )}

      {/* ── Attachment image lightbox ── */}
      {imagePreview && (
        <div
          className="leave-image-lightbox-backdrop"
          role="presentation"
          onClick={() => setImagePreview(null)}
        >
          <button
            type="button"
            className="leave-image-lightbox-close"
            onClick={() => setImagePreview(null)}
            aria-label="Close document preview"
          >
            <X size={20} />
          </button>
          {imagePreview.mimeType.startsWith("image/") ? (
            <img
              className="leave-image-lightbox-img"
              src={imagePreview.src}
              alt={imagePreview.name}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <iframe
              className="leave-image-lightbox-frame"
              src={imagePreview.src}
              title={imagePreview.name}
              onClick={(e) => e.stopPropagation()}
            />
          )}
        </div>
      )}
    </>
  );
}
