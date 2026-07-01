// pages/leave/LeavePage.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
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
import "./LeavePage.css";

// ─── Types ───────────────────────────────────────────────────────────────────

type EmploymentStatus = "REGULAR" | "PROBATIONARY" | "CONTRACTUAL" | "SEPARATED";

type LeaveType = {
  id: string;
  name: string;
  defaultDays: string;
  requiresDocument: boolean;
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
  attachmentName?: string | null;
  attachmentMimeType?: string | null;
  attachmentData?: string | null;
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
};

type Notification = { type: "success" | "error"; message: string } | null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getEmployeeName(request: LeaveRequest) {
  return `${request.employee.firstName} ${request.employee.lastName}`;
}

function getLeaveTone(status: string) {
  if (status === "APPROVED" || status === "SUPERVISOR_APPROVED") return "success";
  if (status === "REJECTED" || status === "CANCELLED") return "danger";
  return "warning";
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

function formatEmploymentStatus(status?: EmploymentStatus) {
  if (!status) return "Unspecified";
  return status.charAt(0) + status.slice(1).toLowerCase();
}

const EMPLOYMENT_STATUS_COLORS: Record<EmploymentStatus, string> = {
  REGULAR: "#2979d0",
  PROBATIONARY: "#d97706",
  CONTRACTUAL: "#7c3aed",
  SEPARATED: "#94a3b8",
};

const EMPLOYMENT_STATUS_OPTIONS = [
  { value: "REGULAR", label: "Regular" },
  { value: "PROBATIONARY", label: "Probationary" },
  { value: "CONTRACTUAL", label: "Contractual" },
  { value: "SEPARATED", label: "Separated" },
];

const LEAVE_TYPE_COLORS = ["#1baf7a", "#eda100", "#e34948", "#4a3aa7", "#2a78d6", "#0ea5b8", "#d6336c", "#7c3aed"];

// ─── Donut chart (plain SVG, no chart library) ───────────────────────────────

function LeaveStatusDonut({
  employmentStatus,
  earnedDays,
  usedDays,
  remainingDays,
  employeeCount,
  leaveTypeRows,
}: {
  employmentStatus: EmploymentStatus;
  earnedDays: number;
  usedDays: number;
  remainingDays: number;
  employeeCount: number;
  leaveTypeRows: { leaveTypeId: string; leaveTypeName: string; remainingDays: number }[];
}) {
  const size = 132;
  const stroke = 16;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const usedRatio = earnedDays > 0 ? Math.min(1, usedDays / earnedDays) : 0;
  const usedLength = circumference * usedRatio;
  const usedPercent = Math.round(usedRatio * 100);
  const color = EMPLOYMENT_STATUS_COLORS[employmentStatus];
  const [showTypes, setShowTypes] = useState(false);
  const typesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showTypes) return;
    function handleOutside(e: MouseEvent) {
      if (typesRef.current && !typesRef.current.contains(e.target as Node)) setShowTypes(false);
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [showTypes]);

  return (
    <div className="leave-donut-card">
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
      {leaveTypeRows.length > 0 && (
        <div className="leave-donut-types-wrap" ref={typesRef}>
          <button
            type="button"
            className="leave-donut-types-trigger"
            onClick={() => setShowTypes((prev) => !prev)}
          >
            All Leave Types
            <ChevronDown size={11} className={`leave-donut-types-chevron${showTypes ? " open" : ""}`} />
          </button>
          {showTypes && (
            <div className="leave-donut-types-menu">
              {leaveTypeRows.map((row) => (
                <div key={row.leaveTypeId} className="leave-donut-type-row">
                  <span className="leave-donut-type-name">{row.leaveTypeName}</span>
                  <span className="leave-donut-type-value">{row.remainingDays.toFixed(0)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
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
          <span>{employeeCount} {employeeCount === 1 ? "employee" : "employees"}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Single-employee donut (for the detailed lookup view) ───────────────────

function EmployeeLeaveDonut({
  firstName,
  color,
  earnedDays,
  usedDays,
  remainingDays,
}: {
  firstName: string;
  color: string;
  earnedDays: number;
  usedDays: number;
  remainingDays: number;
}) {
  const size = 132;
  const stroke = 16;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const usedRatio = earnedDays > 0 ? Math.min(1, usedDays / earnedDays) : 0;
  const usedLength = circumference * usedRatio;
  const usedPercent = Math.round(usedRatio * 100);

  return (
    <div className="employee-donut-card">
      <div className="leave-donut-svg-wrap">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#eef2f7" strokeWidth={stroke} />
          {usedLength > 0 && (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={color}
              strokeWidth={stroke}
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
      <span className="employee-donut-caption">{firstName.toUpperCase()}'S BALANCE</span>
    </div>
  );
}

// ─── Leave-type bar row (for the detailed lookup view) ──────────────────────

function EmployeeLeaveTypeBar({
  label,
  earnedDays,
  remainingDays,
  color,
}: {
  label: string;
  earnedDays: number;
  remainingDays: number;
  color: string;
}) {
  const ratio = earnedDays > 0 ? Math.min(1, remainingDays / earnedDays) : 0;
  const isSickLeave = label.trim().toLowerCase() === "sick leave";
  return (
    <div className="employee-leave-bar-row">
      <span className="employee-leave-bar-label">
        <span className="employee-leave-bar-dot" style={{ background: color }} />
        {label}
      </span>
      <div className="employee-leave-bar-track">
        <div className="employee-leave-bar-fill" style={{ width: `${ratio * 100}%`, background: color }} />
      </div>
      {!isSickLeave && (
        <span className="employee-leave-bar-value">
          {remainingDays.toFixed(0)}/{earnedDays.toFixed(0)}
        </span>
      )}
    </div>
  );
}


function ClassificationChip({ status }: { status?: EmploymentStatus }) {
  if (!status) return <span className="classification-chip neutral">Unspecified</span>;
  const color = EMPLOYMENT_STATUS_COLORS[status];
  return (
    <span className="classification-chip" style={{ color, borderColor: `${color}55`, background: `${color}15` }}>
      <span className="classification-chip-dot" style={{ background: color }} />
      {formatEmploymentStatus(status)}
    </span>
  );
}


function EmployeeBalanceSearch({
  employees,
  selected,
  onSelect,
  openTrigger,
}: {
  employees: DirectoryEmployee[];
  selected: DirectoryEmployee | null;
  onSelect: (employee: DirectoryEmployee | null) => void;
  openTrigger?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(event: MouseEvent) {
      if (shellRef.current && !shellRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  
  const previousOpenTrigger = useRef(openTrigger);
  useEffect(() => {
    if (openTrigger === undefined || openTrigger === previousOpenTrigger.current) return;
    previousOpenTrigger.current = openTrigger;
    setOpen(true);
  }, [openTrigger]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter(
      (e) =>
        `${e.firstName} ${e.lastName}`.toLowerCase().includes(q) ||
        e.employeeNo.toLowerCase().includes(q)
    );
  }, [employees, query]);

  const displayValue = open ? query : selected ? `${selected.firstName} ${selected.lastName} · ${selected.employeeNo}` : query;
  const showClear = Boolean(selected || query);

  return (
    <div className="employee-balance-search-shell" ref={shellRef}>
      <div className="leave-search employee-balance-search">
        <Search size={14} />
        <input
          type="text"
          value={displayValue}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          placeholder="Search employee by name or department"
          aria-label="Search employee for leave balance lookup"
        />
        {showClear && (
          <button
            type="button"
            className="employee-balance-clear"
            onClick={() => {
              onSelect(null);
              setQuery("");
              setOpen(false);
            }}
            aria-label="Clear employee search"
          >
            <X size={14} />
          </button>
        )}
      </div>
      {open && (
        <div className="employee-balance-menu">
          {matches.length === 0 ? (
            <p className="employee-balance-no-matches">No employees match this search.</p>
          ) : (
            matches.map((employee) => (
              <button
                type="button"
                key={employee.id}
                className={`employee-balance-option ${selected?.id === employee.id ? "active" : ""}`}
                onClick={() => {
                  onSelect(employee);
                  setQuery("");
                  setOpen(false);
                }}
              >
                <strong>{employee.firstName} {employee.lastName}</strong>
                <small>{formatEmploymentStatus(employee.employmentStatus)}</small>
              </button>
            ))
          )}
        </div>
      )}
    </div>
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


export function LeavePage() {
  const [requests, setRequests]                 = useState<LeaveRequest[]>([]);
  const [leaveTypes, setLeaveTypes]             = useState<LeaveType[]>([]);
  const [topTab, setTopTab]                     = useState<"requests" | "history">("requests");
  const [statusFilter, setStatusFilter]         = useState("ALL");
  const [typeFilter, setTypeFilter]             = useState("ALL");
  const [historyDepartmentFilter, setHistoryDepartmentFilter] = useState("ALL");
  const [dateFiledFilter, setDateFiledFilter]   = useState<string | null>(null);
  const [searchTerm, setSearchTerm]             = useState("");
  const [reviewRequest, setReviewRequest]       = useState<LeaveRequest | null>(null);
  const [historyViewOnly, setHistoryViewOnly]   = useState(false);
  const [imagePreview, setImagePreview]         = useState<{ src: string; name: string } | null>(null);
  const [remarks, setRemarks]                   = useState("");
  const [isSaving, setIsSaving]                 = useState(false);
  const [notification, setNotification]         = useState<Notification>(null);
  const [reviewBalances, setReviewBalances]     = useState<LeaveBalance[] | null>(null);

  const [summary, setSummary]           = useState<LeaveBalanceSummary | null>(null);
  const [summaryYear, setSummaryYear]   = useState(new Date().getFullYear());

  const [directory, setDirectory]                       = useState<DirectoryEmployee[]>([]);
  const [balanceEmployee, setBalanceEmployee]           = useState<DirectoryEmployee | null>(null);
  const [employeeBalances, setEmployeeBalances]         = useState<LeaveBalance[] | null>(null);
  const [monitorClassification, setMonitorClassification] = useState("ALL");
  const [searchClearKey, setSearchClearKey]             = useState(0);


  const loadRequests = () => {
    apiRequest<LeaveRequest[]>("/leave-requests")
      .then(setRequests)
      .catch(() => undefined);
  };

  const loadLeaveTypes = () => {
    apiRequest<LeaveType[]>("/leave-types")
      .then(setLeaveTypes)
      .catch(() => undefined);
  };

  const loadSummary = () => {
    apiRequest<LeaveBalanceSummary>(`/leave-balances/summary?year=${summaryYear}`)
      .then(setSummary)
      .catch(() => setSummary(null));
  };

  const loadDirectory = () => {
    apiRequest<DirectoryEmployee[]>("/employees")
      .then(setDirectory)
      .catch(() => undefined);
  };

  useEffect(loadRequests, []);
  useEffect(loadLeaveTypes, []);
  useEffect(loadSummary, [summaryYear]);
  useEffect(loadDirectory, []);

  useEffect(() => {
    if (!balanceEmployee) {
      setEmployeeBalances(null);
      return;
    }
    apiRequest<LeaveBalance[]>(`/leave-balances/${balanceEmployee.id}?year=${summaryYear}`)
      .then(setEmployeeBalances)
      .catch(() => setEmployeeBalances(null));
  }, [balanceEmployee, summaryYear]);

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
      else if (r.status === "REJECTED") counts.REJECTED += 1;
    }
    return counts;
  }, [requests]);

  const visibleRequests = useMemo(
    () =>
      requests.filter((r) => {
        const matchesStatus =
          statusFilter === "ALL" || r.status === statusFilter;
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

  const historyDepartmentOptions = useMemo(() => {
    const names = new Set<string>();
    for (const r of requests) {
      if (r.employee.department?.name) names.add(r.employee.department.name);
    }
    return Array.from(names)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ value: name, label: name }));
  }, [requests]);

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

  const selectedLeaveType = reviewRequest
    ? leaveTypes.find((t) => t.id === reviewRequest.leaveType.id)
    : undefined;

  const matchingBalance =
    reviewRequest && reviewBalances
      ? reviewBalances.find((b) => b.leaveTypeId === reviewRequest.leaveType.id)
      : undefined;

  const wouldExceedBalance = Boolean(
    matchingBalance &&
      reviewRequest &&
      reviewRequest.status !== "APPROVED" &&
      Number(reviewRequest.totalDays) > matchingBalance.remainingDays
  );

 
  const leaveTypeRowsByStatus = useMemo(() => {
    const map = new Map<EmploymentStatus, { leaveTypeId: string; leaveTypeName: string; remainingDays: number }[]>();
    if (!summary) return map;
    for (const row of summary.byLeaveType) {
      if (row.earnedDays <= 0) continue;
      const rows = map.get(row.employmentStatus) ?? [];
      rows.push({ leaveTypeId: row.leaveTypeId, leaveTypeName: row.leaveTypeName, remainingDays: row.remainingDays });
      map.set(row.employmentStatus, rows);
    }
    return map;
  }, [summary]);

  const directoryForSearch = useMemo(
    () =>
      monitorClassification === "ALL"
        ? directory
        : directory.filter((employee) => employee.employmentStatus === monitorClassification),
    [directory, monitorClassification]
  );

  const employeeTotals = useMemo(() => {
    const rows = employeeBalances ?? [];
    return rows.reduce(
      (acc, row) => ({
        earnedDays: acc.earnedDays + row.earnedDays,
        usedDays: acc.usedDays + row.usedDays,
        remainingDays: acc.remainingDays + row.remainingDays,
      }),
      { earnedDays: 0, usedDays: 0, remainingDays: 0 }
    );
  }, [employeeBalances]);


  const reviewLeave = async (action: "approve" | "reject") => {
    if (!reviewRequest) return;
    setIsSaving(true);
    try {
      await apiRequest(`/leave-requests/${reviewRequest.id}/${action}`, {
        method: "PATCH",
        body: JSON.stringify({ remarks: remarks.trim() }),
      });
      setReviewRequest(null);
      setRemarks("");
      setNotification({
        type: "success",
        message: `Leave request was ${action === "approve" ? "approved" : "rejected"}.`,
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
            <p>Earned vs. used leave credits grouped by employment classification.</p>
          </div>
          <div className="leave-summary-controls">
            <EmployeeBalanceSearch
              key={searchClearKey}
              employees={directoryForSearch}
              selected={balanceEmployee}
              onSelect={setBalanceEmployee}
              openTrigger={monitorClassification}
            />
            <DropdownFilter
              className="leave-select"
              value={monitorClassification}
              onChange={setMonitorClassification}
              options={EMPLOYMENT_STATUS_OPTIONS}
              allLabel="All Classifications"
              menuLabel="Filter by employment classification"
              ariaLabel="Filter employee search by classification"
            />
            <YearCalendarPicker value={summaryYear} onChange={setSummaryYear} />
          </div>
        </div>

        {balanceEmployee ? (
          <div className="employee-detail-section">
            <div className="employee-detail-heading-row">
              <h3 className="employee-detail-heading">Detailed Employee Leave Monitoring ({summaryYear})</h3>
              <button
                type="button"
                className="employee-detail-close"
                onClick={() => { setBalanceEmployee(null); setMonitorClassification("ALL"); setSearchClearKey((k) => k + 1); }}
                aria-label="Close employee leave detail"
              >
                <X size={16} />
              </button>
            </div>

            {!employeeBalances ? (
              <p className="leave-summary-empty">Loading leave balance…</p>
            ) : employeeBalances.length === 0 ? (
              <p className="leave-summary-empty">No leave balance records for this employee.</p>
            ) : (
              <div className="leave-employee-grid">
                <EmployeeLeaveDonut
                  firstName={balanceEmployee.firstName}
                  color={EMPLOYMENT_STATUS_COLORS[balanceEmployee.employmentStatus]}
                  earnedDays={employeeTotals.earnedDays}
                  usedDays={employeeTotals.usedDays}
                  remainingDays={employeeTotals.remainingDays}
                />

                <div className="leave-employee-info">
                  <div className="employee-balance-result-header">
                    <div>
                      <strong>{balanceEmployee.firstName} {balanceEmployee.lastName}</strong>
                      <span>{balanceEmployee.employeeNo} · {balanceEmployee.department?.name ?? "Unassigned"}</span>
                    </div>
                    <div className="employee-total-balance">
                      <span>Total Balance</span>
                      <strong>{employeeTotals.remainingDays.toFixed(0)}/{employeeTotals.earnedDays.toFixed(0)}</strong>
                      <ClassificationChip status={balanceEmployee.employmentStatus} />
                    </div>
                  </div>

                  <div className="employee-leave-bar-list">
                    {employeeBalances.map((b, index) => (
                      <EmployeeLeaveTypeBar
                        key={b.leaveTypeId}
                        label={b.leaveTypeName}
                        earnedDays={b.earnedDays}
                        remainingDays={b.remainingDays}
                        color={LEAVE_TYPE_COLORS[index % LEAVE_TYPE_COLORS.length]}
                      />
                    ))}
                  </div>
                </div>
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
                  leaveTypeRows={leaveTypeRowsByStatus.get(row.employmentStatus) ?? []}
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
                  visibleRequests.map((r) => (
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
                        <Badge tone={getLeaveTone(r.status)}>{r.status}</Badge>
                      </td>
                      <td data-label="Action">
                        <button
                          className="leave-view-button"
                          onClick={() => { setReviewRequest(r); setRemarks(""); setHistoryViewOnly(false); }}
                        >
                          <Eye size={14} /> Review
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </section>
        </>
      )}

      {topTab === "history" && (
        <>
          <div className="leave-toolbar">
            <div className="leave-table-toolbar leave-table-toolbar-left">
              <DropdownFilter
                className="leave-select"
                value={historyDepartmentFilter}
                onChange={setHistoryDepartmentFilter}
                options={historyDepartmentOptions}
                allLabel="All Departments"
                menuLabel="Filter by department"
                ariaLabel="Filter by department"
              />
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
                  visibleHistoryRequests.map((r) => (
                    <tr key={r.id}>
                      <td data-label="Employee">{getEmployeeName(r)}</td>
                      <td data-label="Department">{r.employee.department?.name ?? "Unassigned"}</td>
                      <td data-label="Classification">{formatEmploymentStatus(r.employee.employmentStatus)}</td>
                      <td data-label="Leave Type">{r.leaveType.name}</td>
                      <td data-label="Date Filed">{formatDate(r.createdAt)}</td>
                      <td data-label="Days">{r.totalDays}</td>
                      <td data-label="Status">
                        <Badge tone={getLeaveTone(r.status)}>{r.status}</Badge>
                      </td>
                      <td data-label="Action">
                        <button
                          className="leave-view-button"
                          onClick={() => { setReviewRequest(r); setRemarks(""); setHistoryViewOnly(true); }}
                        >
                          <Eye size={14} /> View
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </section>
        </>
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
                <Badge tone={getLeaveTone(reviewRequest.status)}>{reviewRequest.status}</Badge>
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

              <div className="leave-attachment-row">
                <span>Supporting Document</span>
                {reviewRequest.attachmentData ? (
                  reviewRequest.attachmentMimeType?.startsWith("image/") ? (
                    <button
                      type="button"
                      className="leave-attachment-preview"
                      onClick={() =>
                        setImagePreview({
                          src: `data:${reviewRequest.attachmentMimeType};base64,${reviewRequest.attachmentData}`,
                          name: reviewRequest.attachmentName ?? "Supporting document",
                        })
                      }
                    >
                      <img
                        src={`data:${reviewRequest.attachmentMimeType};base64,${reviewRequest.attachmentData}`}
                        alt={reviewRequest.attachmentName ?? "Supporting document"}
                      />
                      <span><Paperclip size={13} /> {reviewRequest.attachmentName ?? "View attachment"}</span>
                    </button>
                  ) : (
                    <a
                      className="leave-attachment-link"
                      href={`data:${reviewRequest.attachmentMimeType ?? "application/octet-stream"};base64,${reviewRequest.attachmentData}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <FileText size={14} /> {reviewRequest.attachmentName ?? "View document"}
                    </a>
                  )
                ) : (
                  <strong className="leave-no-attachment">None attached</strong>
                )}
              </div>

              <div><span>Reason</span><strong>{reviewRequest.reason}</strong></div>
              <div><span>Latest Remarks</span><strong>{reviewRequest.adminRemarks?.remarks ?? "None"}</strong></div>
            </div>

            {!historyViewOnly && reviewRequest.status === "PENDING" && (
              <label className="leave-remarks-field">
                Add Remarks
                <textarea
                  value={remarks}
                  onChange={(e) => setRemarks(e.target.value)}
                  placeholder="Optional review notes"
                />
              </label>
            )}

            <div className="leave-detail-actions">
              {!historyViewOnly && reviewRequest.status === "PENDING" && (
                <>
                  <button className="leave-reject-button" onClick={() => reviewLeave("reject")} disabled={isSaving}>
                    Reject
                  </button>
                  <button className="primary-button" onClick={() => reviewLeave("approve")} disabled={isSaving}>
                    Approve
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
            aria-label="Close image preview"
          >
            <X size={20} />
          </button>
          <img
            className="leave-image-lightbox-img"
            src={imagePreview.src}
            alt={imagePreview.name}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}