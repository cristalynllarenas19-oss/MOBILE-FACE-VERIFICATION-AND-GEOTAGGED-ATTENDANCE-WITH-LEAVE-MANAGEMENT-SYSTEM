import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  ArrowLeft,
  Calendar as CalendarIcon,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  FileText,
  Paperclip,
  Search,
  X,
} from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { DropdownFilter } from "../../components/ui/DropdownFilter";
import { apiRequest } from "../../lib/api";
import { useActiveDepartments } from "../../lib/departments";
import { useCachedData } from "../../lib/dataCache";
import {
  type EmploymentStatus,
  formatEmploymentStatus,
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
  type: "REJECTED" | "RESUBMITTED";
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
  attachmentName?: string | null;
  attachmentMimeType?: string | null;
  attachmentData?: string | null;
  extensionRequested?: boolean;
  extensionApproved?: boolean | null;
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

type LeaveBalanceSummary = {
  year: number;
  byEmploymentStatus: {
    employmentStatus: EmploymentStatus;
    earnedDays: number;
    usedDays: number;
    remainingDays: number;
    employeeCount: number;
  }[];
  byLeaveType: {
    employmentStatus: EmploymentStatus;
    leaveTypeId: string;
    leaveTypeName: string;
    earnedDays: number;
    usedDays: number;
    remainingDays: number;
  }[];
  byDepartment: {
    departmentId: string;
    departmentName: string;
    earnedDays: number;
    usedDays: number;
    remainingDays: number;
    employeeCount: number;
  }[];
};

type DirectoryEmployee = {
  id: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
  employmentStatus: EmploymentStatus;
  department?: { name: string } | null;
  position?: { title: string } | null;
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
  createdAt: string;
  employee: { firstName: string; lastName: string; department: { name: string } | null };
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getEmployeeName(request: LeaveRequest) {
  return `${request.employee.firstName} ${request.employee.lastName}`;
}

function getLeaveTone(status: string) {
  if (status === "APPROVED" || status === "SUPERVISOR_APPROVED") return "success";
  if (status === "REJECTED" || status === "CANCELLED") return "danger";
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
  return titleCaseStatus(status);
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString();
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

const EMPLOYMENT_STATUS_COLORS: Record<EmploymentStatus, string> = {
  REGULAR: "#2979d0",
  PROBATIONARY: "#0d9488",
  CONTRACTUAL_SEASONAL: "#d97706",
  PIECE_RATE: "#7c3aed",
  SEPARATED: "#94a3b8",
};

// ─── Donut chart (plain SVG, no chart library) ───────────────────────────────

function LeaveStatusDonut({
  employmentStatus,
  earnedDays,
  usedDays,
  remainingDays,
  employeeCount,
  isActive,
  onSelect,
}: {
  employmentStatus: EmploymentStatus;
  earnedDays: number;
  usedDays: number;
  remainingDays: number;
  employeeCount: number;
  isActive?: boolean;
  onSelect?: (employmentStatus: EmploymentStatus) => void;
}) {
  const size = 104;
  const stroke = 13;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const usedRatio = earnedDays > 0 ? Math.min(1, usedDays / earnedDays) : 0;
  const usedLength = circumference * usedRatio;
  const usedPercent = Math.round(usedRatio * 100);
  const color = EMPLOYMENT_STATUS_COLORS[employmentStatus];

  return (
    <div
      className={`leave-donut-card${onSelect ? " clickable" : ""}${isActive ? " active" : ""}`}
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onClick={() => onSelect?.(employmentStatus)}
      onKeyDown={(e) => {
        if (onSelect && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onSelect(employmentStatus);
        }
      }}
    >
      <div className="leave-donut-svg-wrap">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#eef2f7" strokeWidth={stroke} />
          {usedLength > 0 && (
            <circle
              cx={size / 2} cy={size / 2} r={radius}
              fill="none" stroke={color} strokeWidth={stroke}
              strokeDasharray={`${usedLength} ${circumference - usedLength}`}
              strokeLinecap="round"
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          )}
        </svg>
        <div className="leave-donut-center">
          <strong>{remainingDays.toFixed(0)}</strong>
          <span>days left</span>
          <em className="leave-donut-pct">{usedPercent}% used</em>
        </div>
      </div>
      <div className="leave-donut-meta">
        <div className="leave-donut-label">
          <span className="leave-donut-dot" style={{ background: color }} />
          {formatEmploymentStatus(employmentStatus)}
        </div>
        <div className="leave-donut-stats">
          <span>{usedDays.toFixed(0)} used</span>
          <span>·</span>
          <span>{earnedDays.toFixed(0)} earned</span>
          <span>·</span>
          <span className="leave-donut-employee-count">
            <strong>{employeeCount}</strong> {employeeCount === 1 ? "employee" : "employees"}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Single-employee summary donut (for the detailed lookup view) ───────────
// Single blue accent only — no per-status color.

function EmployeeSummaryDonut({ earnedDays, usedDays, remainingDays }: {
  earnedDays: number;
  usedDays: number;
  remainingDays: number;
}) {
  const size = 64;
  const stroke = 7;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const usedRatio = earnedDays > 0 ? Math.min(1, usedDays / earnedDays) : 0;
  const usedLength = circumference * usedRatio;
  const usedPercent = Math.round(usedRatio * 100);

  return (
    <div className="employee-summary-donut-wrap">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#eef2f7" strokeWidth={stroke} />
        {usedLength > 0 && (
          <circle
            cx={size / 2} cy={size / 2} r={radius}
            fill="none" stroke="#1680d8" strokeWidth={stroke}
            strokeDasharray={`${usedLength} ${circumference - usedLength}`}
            strokeLinecap="round"
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </svg>
      <div className="employee-summary-donut-center">
        <strong>{remainingDays.toFixed(0)}</strong>
        <span>days left</span>
        <em>{usedPercent}% used</em>
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

// ─── Leave-type balance row (for the detailed lookup view) ──────────────────
// Mirrors the employee self-service "Leave Balance" card content, laid out as
// a wide row so it reads as an extension of the same page.

function EmployeeLeaveTypeRow({
  label,
  earnedDays,
  usedDays,
  remainingDays,
}: {
  label: string;
  earnedDays: number;
  usedDays: number;
  remainingDays: number;
}) {
  const pct = earnedDays > 0 ? Math.min(100, Math.round((remainingDays / earnedDays) * 100)) : 0;
  return (
    <div className="employee-leave-row-card">
      <span className="employee-leave-row-label">{label}</span>
      <span className="employee-leave-row-meta">
        Earned: <b>{earnedDays.toFixed(0)}</b>
      </span>
      <span className="employee-leave-row-meta">
        Used: <b>{usedDays.toFixed(0)}</b>
      </span>
      <div className="employee-leave-row-track">
        <div className="employee-leave-row-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="employee-leave-row-remaining">
        <strong>{remainingDays.toFixed(0)}</strong> remaining
      </div>
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
}: {
  employee: DirectoryEmployee;
  totalEarnedDays: number;
  totalUsedDays: number;
  totalRemainingDays: number;
  balances: { leaveTypeId: string; leaveTypeName: string; earnedDays: number; usedDays: number; remainingDays: number }[];
  year: number;
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
              className="leave-modal"
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
                  <p className="leave-summary-empty">No leave balance records for this employee.</p>
                ) : (
                  <>
                    <div className="employee-summary-row">
                      <EmployeeSummaryDonut
                        earnedDays={totalEarnedDays}
                        usedDays={totalUsedDays}
                        remainingDays={totalRemainingDays}
                      />

                      <div className="employee-summary-info">
                        <strong>{employee.firstName} {employee.lastName}</strong>
                        <span className="employee-summary-badge">
                          <span className="employee-summary-badge-dot" />
                          {formatEmploymentStatus(employee.employmentStatus)}
                        </span>
                      </div>

                      <div className="employee-summary-total">
                        <span>Total Balance</span>
                        <strong>{totalRemainingDays.toFixed(0)}/{totalEarnedDays.toFixed(0)}</strong>
                      </div>
                    </div>

                    <p className="employee-summary-caption">{employee.firstName.toUpperCase()}'S BALANCE</p>

                    <div className="employee-leave-row-list">
                      {balances.map((b) => (
                        <EmployeeLeaveTypeRow
                          key={b.leaveTypeId}
                          label={b.leaveTypeName}
                          earnedDays={b.earnedDays}
                          usedDays={b.usedDays}
                          remainingDays={b.remainingDays}
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

  const [topTab, setTopTab]                     = useState<"requests" | "history" | "undertime">("requests");
  const [statusFilter, setStatusFilter]         = useState("ALL");
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
  const [isSaving, setIsSaving]                 = useState(false);
  const [notification, setNotification]         = useState<Notification>(null);
  const [reviewBalances, setReviewBalances]     = useState<LeaveBalance[] | null>(null);

  const [summaryYear, setSummaryYear]   = useState(new Date().getFullYear());

  const [monitorClassification, setMonitorClassification] = useState("ALL");

  // Drill-down list (classification card -> table of every employee in it).
  // "View" on a row opens EmployeeListViewButton's own modal for that
  // employee's full balance breakdown — see that component.
  const [showEmployeeList, setShowEmployeeList] = useState(false);
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

  const leaveTypesCache = useCachedData<LeaveType[]>("leave-types", () => apiRequest<LeaveType[]>("/leave-types"));
  const leaveTypes = leaveTypesCache.data ?? [];

  const undertimeCache = useCachedData<UndertimeFiling[]>("undertime-filings", () =>
    apiRequest<UndertimeFiling[]>("/undertime-filings"),
  );
  const undertimeFilings = undertimeCache.data ?? [];

  const summaryCache = useCachedData<LeaveBalanceSummary>(`leave-balance-summary:${summaryYear}`, () =>
    apiRequest<LeaveBalanceSummary>(`/leave-balances/summary?year=${summaryYear}`),
  );
  const summary = summaryCache.data;
  const loadSummary = () => {
    summaryCache.refresh().catch(() => undefined);
  };

  // Same "employees" cache key as the Employees/Attendance pages — one
  // fetched copy of GET /employees serves all three.
  const directoryCache = useCachedData<DirectoryEmployee[]>("employees", () =>
    apiRequest<DirectoryEmployee[]>("/employees"),
  );
  const directory = directoryCache.data ?? [];

  const { departmentNames: listDepartmentOptions } = useActiveDepartments();

  // Per-employee balance rows for the classification drill-down list — keyed
  // by year + classification so switching either automatically refetches
  // (new hires/classification changes/balance updates all show up with no
  // code change). Only fetched while the list is actually open.
  const classificationBalancesCache = useCachedData<ClassificationBalanceRow[]>(
    showEmployeeList ? `leave-balances-by-classification:${summaryYear}:${monitorClassification}` : null,
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
  useEffect(() => {
    if (!initialFocusRequestId) return;
    const match = requests.find((r) => r.id === initialFocusRequestId);
    if (!match) return;
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
      if (r.status === "PENDING") counts.PENDING += 1;
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
          (statusFilter === "REJECTED" && r.status === "NEEDS_REVISION");
        const matchesType =
          typeFilter === "ALL" || r.leaveType.id === typeFilter;
        const matchesSearch =
          !searchTerm.trim() ||
          getEmployeeName(r)
            .toLowerCase()
            .includes(searchTerm.trim().toLowerCase());
        return matchesStatus && matchesType && matchesSearch;
      }),
    [requests, statusFilter, typeFilter, searchTerm]
  );

  useEffect(() => setRequestsPage(1), [statusFilter, typeFilter, searchTerm]);
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

  // Mirrors the employee self-service Cancel action, available to HR/Admin
  // (and a Supervisor acting within their department) on any request that
  // hasn't already reached a terminal REJECTED/CANCELLED state.
  const canCancelRequest = Boolean(
    reviewRequest &&
      !(isOwnRequest && !isAdmin) &&
      ["PENDING", "SUPERVISOR_APPROVED", "APPROVED"].includes(reviewRequest.status),
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


  const openClassificationList = (employmentStatus: EmploymentStatus) => {
    setMonitorClassification(employmentStatus);
    setShowEmployeeList(true);
    setEmployeeListPage(1);
  };

  const closeClassificationList = () => {
    setShowEmployeeList(false);
    setMonitorClassification("ALL");
    setListSearch("");
    setListDepartmentFilter("");
    setEmployeeListPage(1);
  };

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

  useEffect(() => setEmployeeListPage(1), [listDepartmentFilter, listSearch, listSort]);
  const employeeListPageCount = Math.max(1, Math.ceil(classificationListRows.length / EMPLOYEE_LIST_PAGE_SIZE));
  const employeeListPageSafe = Math.min(employeeListPage, employeeListPageCount);
  const pagedClassificationListRows = classificationListRows.slice(
    (employeeListPageSafe - 1) * EMPLOYEE_LIST_PAGE_SIZE,
    employeeListPageSafe * EMPLOYEE_LIST_PAGE_SIZE,
  );

  const reviewLeave = async (action: "approve" | "reject") => {
    if (!reviewRequest) return;
    setIsSaving(true);
    try {
      await apiRequest(`/leave-requests/${reviewRequest.id}/${action}`, {
        method: "PATCH",
        body: JSON.stringify(
          action === "reject"
            ? { remarks: remarks.trim(), requiresAdditionalRequirements, requirementDetails: requirementDetails.trim() }
            : { remarks: remarks.trim() }
        ),
      });
      setReviewRequest(null);
      setRemarks("");
      setRequiresAdditionalRequirements(false);
      setRequirementDetails("");
      setNotification({
        type: "success",
        message:
          action === "approve"
            ? "Leave request was approved."
            : requiresAdditionalRequirements
              ? "Leave request was returned to the employee for additional requirements."
              : "Leave request was rejected.",
      });
      loadRequests();
      loadSummary();
    } catch (err) {
      setNotification({
        type: "error",
        message: err instanceof Error ? err.message : "Unable to review leave.",
      });
    } finally {
      setIsSaving(false);
    }
  };

  // Admin/Supervisor cancellation is not bound by the 24-hour post-approval
  // grace window employee self-cancel is (see leave.service.ts's cancel()) —
  // an elevated actor cancelling on the employee's behalf is treated as an
  // override, same as the self-review bypass already used elsewhere here.
  const cancelRequest = async () => {
    if (!reviewRequest) return;
    setIsSaving(true);
    try {
      await apiRequest(`/leave-requests/${reviewRequest.id}/cancel`, { method: "PATCH" });
      setReviewRequest(null);
      setNotification({ type: "success", message: "Leave request was cancelled." });
      loadRequests();
      loadSummary();
    } catch (err) {
      setNotification({
        type: "error",
        message: err instanceof Error ? err.message : "Unable to cancel leave request.",
      });
    } finally {
      setIsSaving(false);
    }
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

      <section className="leave-summary-card">
        <div className="leave-summary-header">
          <div>
            <h2>Leave Balances Overview</h2>
          </div>
          <div className="leave-summary-controls">
            <YearCalendarPicker value={summaryYear} onChange={setSummaryYear} />
          </div>
        </div>

        {showEmployeeList ? (
          <div className="employee-list-section">
            <div className="employee-detail-context-row">
              <button type="button" className="employee-detail-back" onClick={closeClassificationList}>
                <ArrowLeft size={16} />
                Back 
              </button>
              <p className="employee-detail-context">
                {monitorClassification === "ALL" ? "All Classifications" : formatEmploymentStatus(monitorClassification as EmploymentStatus)}
                {" "}· {classificationListRows.length} {classificationListRows.length === 1 ? "employee" : "employees"} · {summaryYear}
              </p>
            </div>

            <div className="employee-list-toolbar">
              <div className="leave-search employee-list-search">
                <Search size={14} />
                <input
                  type="text"
                  value={listSearch}
                  onChange={(e) => setListSearch(e.target.value)}
                  placeholder="Search…"
                  aria-label="Search employees in the selected classification"
                />
              </div>
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
                          Name {listSort.key === "name" ? (listSort.dir === "asc" ? "▲" : "▼") : ""}
                        </button>
                      </th>
                      <th>Department</th>
                      <th>Position</th>
                      <th>
                        <button type="button" className="employee-list-sort-th" onClick={() => toggleListSort("remaining")}>
                          Total Remaining {listSort.key === "remaining" ? (listSort.dir === "asc" ? "▲" : "▼") : ""}
                        </button>
                      </th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedClassificationListRows.map((row) => (
                      <tr key={row.employeeId}>
                        <td data-label="Name" title={`${row.employee.firstName} ${row.employee.lastName}`}>{row.employee.firstName} {row.employee.lastName}</td>
                        <td data-label="Department" title={row.employee.department?.name ?? "Unassigned"}>{row.employee.department?.name ?? "Unassigned"}</td>
                        <td data-label="Position" title={row.employee.position?.title ?? "—"}>{row.employee.position?.title ?? "—"}</td>
                        <td data-label="Total Remaining">{row.totalRemainingDays.toFixed(0)}</td>
                        <td data-label="Action">
                          <EmployeeListViewButton
                            employee={row.employee}
                            totalEarnedDays={row.totalEarnedDays}
                            totalUsedDays={row.totalUsedDays}
                            totalRemainingDays={row.totalRemainingDays}
                            balances={row.balances}
                            year={summaryYear}
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
        ) : !summary || summary.byEmploymentStatus.length === 0 ? (
          <p className="leave-summary-empty">No leave balance records yet for {summaryYear}.</p>
        ) : (
          <div className="leave-donut-row">
            {summary.byEmploymentStatus.map((row) => (
              <div key={row.employmentStatus} className="leave-donut-tile">
                <LeaveStatusDonut
                  employmentStatus={row.employmentStatus}
                  earnedDays={row.earnedDays}
                  usedDays={row.usedDays}
                  remainingDays={row.remainingDays}
                  employeeCount={row.employeeCount}
                  isActive={monitorClassification === row.employmentStatus}
                  onSelect={openClassificationList}
                />
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="leave-section-tabs">
        <button className={topTab === "requests" ? "active" : ""} onClick={() => setTopTab("requests")}>
          Leave Requests
        </button>
        <button className={topTab === "history" ? "active" : ""} onClick={() => setTopTab("history")}>
          Leave History
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
                value={typeFilter}
                onChange={setTypeFilter}
                options={leaveTypes.map((t) => ({ value: t.id, label: t.name }))}
                allLabel="All Leave Types"
                menuLabel="Filter by leave type"
                ariaLabel="Filter by leave type"
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
            <div className="leave-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>EMPLOYEE</th>
                  <th>DEPARTMENT</th>
                  <th>CLASSIFICATION</th>
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
                      <td data-label="Classification">{formatEmploymentStatus(r.employee.employmentStatus)}</td>
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
                          onClick={() => { setReviewRequest(r); setRemarks(""); setRequiresAdditionalRequirements(false); setRequirementDetails(""); setHistoryViewOnly(false); }}
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
            <div className="leave-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>EMPLOYEE</th>
                  <th>DEPARTMENT</th>
                  <th>CLASSIFICATION</th>
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
                      <td data-label="Classification">{formatEmploymentStatus(r.employee.employmentStatus)}</td>
                      <td data-label="Leave Type">{r.leaveType.name}</td>
                      <td data-label="Date Filed">{formatDate(r.createdAt)}</td>
                      <td data-label="Days">{r.totalDays}</td>
                      <td data-label="Status">
                        <Badge tone={getLeaveTone(r.status)}>{getLeaveStatusLabel(r.status, isAdmin)}</Badge>
                      </td>
                      <td data-label="Action">
                        <button
                          className="leave-view-button"
                          onClick={() => { setReviewRequest(r); setRemarks(""); setRequiresAdditionalRequirements(false); setRequirementDetails(""); setHistoryViewOnly(true); }}
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

      {topTab === "undertime" && (
        <section className="table-card leave-table-card">
          <div className="leave-table-scroll">
          <table>
            <thead>
              <tr>
                <th>EMPLOYEE</th>
                <th>DEPARTMENT</th>
                <th>DATE FILED</th>
                <th>REASON</th>
              </tr>
            </thead>
            <tbody>
              {undertimeFilings.length === 0 ? (
                <tr>
                  <td colSpan={4} className="leave-empty-state">No undertime filings found.</td>
                </tr>
              ) : (
                pagedUndertimeFilings.map((f) => (
                  <tr key={f.id}>
                    <td data-label="Employee">{f.employee.firstName} {f.employee.lastName}</td>
                    <td data-label="Department">{f.employee.department?.name ?? "Unassigned"}</td>
                    <td data-label="Date Filed">{formatDate(f.filingDate)}</td>
                    <td data-label="Reason">{f.reason ?? "—"}</td>
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
              <div><span>Classification</span><strong>{formatEmploymentStatus(reviewRequest.employee.employmentStatus)}</strong></div>
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

            <div className="leave-detail-actions">
              {!historyViewOnly && canReviewRequest && (
                <>
                  <button className="leave-reject-button" onClick={() => reviewLeave("reject")} disabled={isSaving}>
                    {requiresAdditionalRequirements ? "Reject & Request Resubmission" : "Reject"}
                  </button>
                  <button className="primary-button" onClick={() => reviewLeave("approve")} disabled={isSaving}>
                    Approve
                  </button>
                </>
              )}
              {!historyViewOnly && canCancelRequest && (
                <button className="leave-reject-button" onClick={cancelRequest} disabled={isSaving}>
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
