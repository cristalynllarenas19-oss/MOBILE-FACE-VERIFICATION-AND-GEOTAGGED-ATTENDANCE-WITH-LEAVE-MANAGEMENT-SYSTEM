import { Fragment, useEffect, useMemo, useState } from "react";
import { Download, FileText, Printer } from "lucide-react";
import { jsPDF } from "jspdf";
import { autoTable } from "jspdf-autotable";
import { StatCard } from "../../components/ui/StatCard";
import { Badge } from "../../components/ui/Badge";
import { DropdownFilter } from "../../components/ui/DropdownFilter";
import { EmployeeSearchSelect, matchesEmployeeQuery } from "../../components/ui/EmployeeSearchSelect";
import { apiRequest } from "../../lib/api";
import { useLiveRefresh } from "../../lib/liveRefresh";
import { useActiveDepartments } from "../../lib/departments";
import { formatEmploymentStatus } from "../../types/employment";
import logo from "../../assets/unileaf-logo.png";
import { formatDays } from "../../lib/leaveDays";
import "./ReportsPage.css";

type ReportData = {
  generatedAt: string;
  monthStart: string;
  attendanceByStatus: Record<string, number>;
  leaveByStatus: Record<string, number>;
  totals: {
    attendanceRecords: number;
    approvedLeaves: number;
    pendingLeaves: number;
    activeSchedules: number;
  };
  attendance: {
    id: string;
    attendanceDate: string;
    status: string;
    totalMinutes: number;
    lateMinutes: number;
    timeInAt?: string | null;
    timeOutAt?: string | null;
    lunchOutAt?: string | null;
    lunchInAt?: string | null;
    breakKind?: "LUNCH" | "BREAK";
    workLocation?: { name: string } | null;
    employee: { firstName: string; lastName: string; department: { name: string } };
  }[];
  leaves: {
    id: string;
    startDate: string;
    endDate: string;
    totalDays: string;
    status: string;
    // Set only on a LAPSED request: "REPORTED_FOR_WORK" or "NOT_DECIDED".
    lapseReason?: string | null;
    employee: { firstName: string; lastName: string; employmentStatus?: string; department: { name: string } };
    leaveType: { name: string };
  }[];
  undertime: {
    id: string;
    filingDate: string;
    reason: string | null;
    status: string;
    remarks: string | null;
    reviewedAt: string | null;
    employee: { firstName: string; lastName: string; department: { name: string } };
    attendanceRecord: { attendanceDate: string; lateMinutes: number; undertimeMinutes?: number };
    reviewer?: { email: string; employee?: { firstName: string; lastName: string } | null } | null;
  }[];
  schedules: {
    id: string;
    startsOn: string;
    endsOn?: string | null;
    employee: { firstName: string; lastName: string; department: { name: string }; position?: { title: string } | null };
    shift: { name: string; startTime: string; endTime: string };
  }[];
  employees: {
    id: string;
    firstName: string;
    lastName: string;
    sex?: string | null;
    hireDate: string;
    department: { name: string };
  }[];
  leaveBalances: {
    employeeId: string;
    employee: { firstName: string; lastName: string; sex?: string | null; department: { name: string } };
    leaveTypeId: string;
    leaveTypeName: string;
    year: number;
    earnedDays: number;
    usedDays: number;
    remainingDays: number;
    usedDates: { startDate: string; endDate: string }[];
  }[];
  vlMonetizations?: {
    id: string;
    year: number;
    days: number;
    monetizedAt: string;
    leaveType: { name: string };
    employee: { firstName: string; lastName: string; sex?: string | null; department: { name: string } };
  }[];
};

type ReportTab = "ALL" | "attendance" | "leave" | "undertime" | "schedules" | "employees" | "leaveBalances" | "vlMonetization";
type SavePicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<{
  createWritable: () => Promise<{
    write: (data: Blob) => Promise<void>;
    close: () => Promise<void>;
  }>;
}>;

const REPORT_TYPE_LABELS: Record<ReportTab, string> = {
  ALL: "All Reports",
  attendance: "DTR / Attendance",
  leave: "Leave",
  undertime: "Undertime",
  schedules: "Schedules",
  employees: "List of Employees",
  leaveBalances: "Remaining Leave",
  vlMonetization: "VL Monetization",
};

const VL_MONETIZATION_HEAD = ["Name", "Department", "Sex", "Leave Year", "Days Monetized", "Date Monetized"];

// All Reports' first page: the department counts only, under this title;
// the DTR / Attendance records follow on the next page.
const ALL_REPORTS_SUMMARY_TITLE = "DTR / Attendance Summary";

const UNDERTIME_STATUS_FILTERS = ["PENDING", "APPROVED", "REJECTED"] as const;
type UndertimeStatus = (typeof UNDERTIME_STATUS_FILTERS)[number];

const UNDERTIME_HEAD = ["Employee", "Department", "Undertime Date", "Minutes", "Reason", "Date Filed", "Status", "Reviewed By"];

type UndertimeRow = ReportData["undertime"][number];

// Undertime a filing covers: minutes late plus minutes timed out early —
// same total the Leave Management page shows.
function undertimeMinutes(row: UndertimeRow) {
  return row.attendanceRecord.lateMinutes + (row.attendanceRecord.undertimeMinutes ?? 0);
}

function undertimeReviewer(row: UndertimeRow) {
  if (!row.reviewer) return "—";
  return row.reviewer.employee ? `${row.reviewer.employee.firstName} ${row.reviewer.employee.lastName}` : row.reviewer.email;
}

function undertimeCells(row: UndertimeRow): (string | number)[] {
  return [
    employeeName(row),
    row.employee.department.name,
    formatDate(row.attendanceRecord.attendanceDate),
    undertimeMinutes(row),
    row.reason ?? "—",
    formatDate(row.filingDate),
    row.status,
    undertimeReviewer(row),
  ];
}

function employeeName(row: { employee: { firstName: string; lastName: string } }) {
  return `${row.employee.firstName} ${row.employee.lastName}`;
}

// --- Department grouping: every report lists departments A–Z (Unassigned
// last), employees A–Z within each. One sort, used by the screen, print,
// PDF and CSV alike, so they always come out in the same order.
type ReportPerson = { firstName: string; lastName: string; department?: { name: string } | null };

const UNASSIGNED_DEPARTMENT = "Unassigned Department";

function departmentOf(person: ReportPerson) {
  return person.department?.name?.trim() || UNASSIGNED_DEPARTMENT;
}

function departmentHeading(name: string) {
  return /department$/i.test(name) ? name : `${name} Department`;
}

function compareText(a: string, b: string) {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

// Stable, so one employee's own rows keep their original (date) order.
function sortByDepartment<T>(rows: T[], person: (row: T) => ReportPerson): T[] {
  return [...rows].sort((rowA, rowB) => {
    const a = person(rowA);
    const b = person(rowB);
    const deptA = departmentOf(a);
    const deptB = departmentOf(b);
    if (deptA !== deptB) {
      if (deptA === UNASSIGNED_DEPARTMENT) return 1;
      if (deptB === UNASSIGNED_DEPARTMENT) return -1;
      return compareText(deptA, deptB);
    }
    return compareText(`${a.firstName} ${a.lastName}`, `${b.firstName} ${b.lastName}`);
  });
}

// Rows must already be sorted with sortByDepartment.
function groupByDepartment<T>(rows: T[], person: (row: T) => ReportPerson) {
  const groups: { department: string; rows: T[] }[] = [];
  for (const row of rows) {
    const department = departmentOf(person(row));
    const last = groups[groups.length - 1];
    if (last && last.department === department) last.rows.push(row);
    else groups.push({ department, rows: [row] });
  }
  return groups;
}

// A table body split into department sections, each under a heading row.
function DepartmentGroups<T>({
  rows,
  person,
  colSpan,
  renderRow,
}: {
  rows: T[];
  person: (row: T) => ReportPerson;
  colSpan: number;
  renderRow: (row: T) => React.ReactNode;
}) {
  return (
    <>
      {groupByDepartment(rows, person).map((group) => (
        <Fragment key={group.department}>
          <tr className="reports-department-row">
            <td colSpan={colSpan}>
              {departmentHeading(group.department)} <span>({group.rows.length})</span>
            </td>
          </tr>
          {group.rows.map(renderRow)}
        </Fragment>
      ))}
    </>
  );
}

const personOfRow = (row: { employee: ReportPerson }) => row.employee;
const personSelf = (row: ReportPerson) => row;

function formatDate(value: string) {
  return new Date(value).toLocaleDateString();
}

function formatTime(value?: string | null, status?: string) {
  if (value) return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  // An absent day will never get a punch, so "Pending" would be misleading.
  return status === "ABSENT" ? "—" : "Pending";
}

// jsPDF's addImage needs pixel data (base64/canvas), not a bundler asset URL —
// draw the logo onto an off-screen canvas once to get that data URL. Natural
// width/height come along so the PDF can scale it without distorting it
// (the logo isn't square — forcing a square box would stretch it).
function loadImageDataUrl(src: string): Promise<{ dataUrl: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("Canvas not supported")); return; }
      ctx.drawImage(img, 0, 0);
      resolve({ dataUrl: canvas.toDataURL("image/png"), width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => reject(new Error("Failed to load logo"));
    img.src = src;
  });
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // Revoking right away can cancel the download before it starts.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// Opens the Save dialog (file explorer) straight away — browsers only allow
// it right after the click, so it has to come before the (slow) report is
// built — and returns a save() for the finished file, or null if the user
// cancelled. Browsers without the dialog, or a dialog that fails, fall back
// to a plain download.
async function openSaveTarget(filename: string, description: string, mimeType: string, extension: string) {
  const showSaveFilePicker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  let handle: Awaited<ReturnType<SavePicker>> | null = null;
  if (showSaveFilePicker) {
    try {
      handle = await showSaveFilePicker({
        suggestedName: filename,
        types: [{ description, accept: { [mimeType]: [extension] } }],
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return null;
    }
  }
  return {
    save: async (blob: Blob) => {
      if (handle) {
        try {
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          return;
        } catch (error) {
          // e.g. the file is open in Excel — download a copy instead.
          console.warn("[REPORTS] Couldn't write to the chosen file; downloading instead.", error);
        }
      }
      downloadBlob(blob, filename);
    },
  };
}

// xlsx is loaded only when an All Report Types export needs it. Its ESM
// build has the API on the namespace, the CommonJS build on default.
// Started when the Reports page opens, so a click on Export has it ready.
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
type SheetJs = typeof import("xlsx");
let sheetJsPromise: Promise<SheetJs> | null = null;
function loadSheetJs(): Promise<SheetJs> {
  sheetJsPromise ??= import("xlsx").then((mod) => (mod.SSF ? mod : (mod as unknown as { default: SheetJs }).default));
  return sheetJsPromise;
}


function formatSex(sex?: string | null) {
  if (sex === "MALE") return "Male";
  if (sex === "FEMALE") return "Female";
  return "—";
}

// Each approved filing as "8/26/26-8/28/26" (a one-day leave too:
// "8/27/26-8/27/26"), oldest first.
function usedDateRanges(dates: { startDate: string; endDate: string }[]) {
  const short = (value: string) => {
    const d = new Date(value);
    return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(-2)}`;
  };
  return [...dates]
    .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime())
    .map((d) => `${short(d.startDate)}-${short(d.endDate)}`);
}

// Plain-text form for exports: three ranges per line.
function formatUsedDates(dates: { startDate: string; endDate: string }[]) {
  const ranges = usedDateRanges(dates);
  if (ranges.length === 0) return "—";
  const lines: string[] = [];
  for (let i = 0; i < ranges.length; i += 3) lines.push(ranges.slice(i, i + 3).join(", "));
  return lines.join("\n");
}

const LEAVE_STATUS_FILTERS = ["PENDING", "APPROVED", "REJECTED", "CANCELLED", "LAPSED"] as const;
type LeaveStatusBucket = (typeof LEAVE_STATUS_FILTERS)[number];

// Every leave status lands in exactly one of the filter tabs, so the counts
// always add up to the total under "All".
function leaveStatusBucket(status: string): LeaveStatusBucket {
  if (status === "APPROVED" || status === "SUPERVISOR_APPROVED") return "APPROVED";
  if (status === "REJECTED" || status === "NEEDS_REVISION") return "REJECTED";
  if (status === "CANCELLED") return "CANCELLED";
  if (status === "LAPSED") return "LAPSED";
  // PENDING, plus an approved leave still awaiting a cancellation decision.
  return "PENDING";
}

// Same wording as the Leave Management page — a lapsed request always says
// whether the employee came to work anyway or the days stand as absent.
function leaveStatusText(request: { status: string; lapseReason?: string | null }) {
  if (request.status === "LAPSED") {
    return request.lapseReason === "REPORTED_FOR_WORK" ? "LAPSED - REPORTED TO WORK" : "LAPSED - ABSENT";
  }
  if (request.status === "CANCELLATION_PENDING") return "PENDING CANCELLATION";
  return request.status.replace(/_/g, " ");
}

function statusTone(status: string) {
  if (status === "CANCELLED" || status === "LAPSED") return "neutral";
  if (status === "PRESENT" || status === "APPROVED" || status === "SUPERVISOR_APPROVED") return "success";
  if (status === "ABSENT" || status === "REJECTED" || status === "NEEDS_REVISION") return "danger";
  return "warning";
}

// A plain "YYYY-MM-DD" filter value must be parsed as LOCAL midnight, not
// `new Date(string)`'s UTC midnight — the backend's attendanceDate/startDate
// values are themselves local-midnight instants (see ReportsService /
// AttendanceService's own parseLocalDate), so on any timezone ahead of UTC
// (e.g. PHT, UTC+8) the UTC parse put `from` several hours *after* today's
// own records, excluding them the moment From/To both default to today.
function parseLocalDateFilter(value: string, endOfDay = false): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return endOfDay ? Infinity : -Infinity;
  const [, year, month, day] = match;
  return endOfDay
    ? new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 59, 999).getTime()
    : new Date(Number(year), Number(month) - 1, Number(day)).getTime();
}

function isInDateRange(dateStr: string, from: string, to: string) {
  if (!from && !to) return true;
  const date = new Date(dateStr).getTime();
  const fromTime = from ? parseLocalDateFilter(from) : -Infinity;
  const toTime = to ? parseLocalDateFilter(to, true) : Infinity;
  return date >= fromTime && date <= toTime;
}

// One printed part of a report. The browser repeats its <thead> — logo,
// title and generated range — at the top of every page the part spans, and
// in All Reports each part starts on its own page with its own title
// ("Leave Report", ...). Laid out as plain blocks on screen (see
// .reports-print-frame), where the print header itself stays hidden.
function PrintFrame({
  title,
  subtitle,
  rangeLabel,
  signatories,
  children,
}: {
  title: string;
  subtitle?: string;
  rangeLabel: string;
  signatories: Signatory[];
  children: React.ReactNode;
}) {
  return (
    <table className="reports-print-frame">
      <thead>
        <tr>
          <td>
            <div className="reports-print-header">
              <img src={logo} alt="Universal Leaf Philippines, Inc." className="reports-print-logo" />
              <div className="reports-print-heading">
                <h1 className="reports-print-title">{title}</h1>
                {subtitle && <p className="reports-print-subtitle">{subtitle}</p>}
              </div>
            </div>
            <div className="reports-print-meta">
              <span>{rangeLabel}</span>
            </div>
          </td>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            {children}
            <PrintSignatories signatories={signatories} />
          </td>
        </tr>
      </tbody>
    </table>
  );
}

// Signatories at the end of every exported/printed report, "signature over
// printed name": the label, blank space to sign, a line with the name in
// capitals under it, then the position. Names and positions are typed on the
// Reports page and remembered in this browser per account (admin and
// supervisor each keep their own); Prepared By's name and position start as
// the logged-in user's and can still be edited.
const SIGNATORY_LABELS = ["Prepared By :", "Noted By :"];
const SIGNATORIES_STORAGE_KEY = "reports.signatories";
type Signatory = { name: string; position: string };
type SavedSignatories = { preparedName: string; preparedPosition: string; notedName: string; notedPosition: string };

const signatoriesKey = (account: string) => `${SIGNATORIES_STORAGE_KEY}:${account}`;

// What this account has actually saved (fields it never edited are missing).
function loadSavedSignatoriesRaw(account: string): Partial<SavedSignatories> {
  try {
    const parsed = JSON.parse(localStorage.getItem(signatoriesKey(account)) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function loadSavedSignatories(defaultPreparedName: string): SavedSignatories {
  const blank = { preparedName: defaultPreparedName, preparedPosition: "", notedName: "", notedPosition: "" };
  try {
    const parsed = JSON.parse(localStorage.getItem(signatoriesKey(defaultPreparedName)) ?? "{}");
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return blank;
    return {
      preparedName: typeof parsed.preparedName === "string" ? parsed.preparedName : defaultPreparedName,
      preparedPosition: typeof parsed.preparedPosition === "string" ? parsed.preparedPosition : "",
      notedName: typeof parsed.notedName === "string" ? parsed.notedName : "",
      notedPosition: typeof parsed.notedPosition === "string" ? parsed.notedPosition : "",
    };
  } catch {
    return blank;
  }
}

// Printed at the end of every part of the report; hidden on screen.
function PrintSignatories({ signatories }: { signatories: Signatory[] }) {
  return (
    <div className="reports-print-signatories">
      {SIGNATORY_LABELS.map((label, i) => (
        <div key={label} className="reports-print-signatory">
          <span>{label}</span>
          <span className="reports-print-signatory-name">{signatories[i].name.toUpperCase()}</span>
          <span className="reports-print-signatory-position">{signatories[i].position}</span>
        </div>
      ))}
    </div>
  );
}

export function ReportsPage({
  user,
}: {
  user?: { roles?: string[]; departmentId?: string; department?: string; displayName?: string; employeeId?: string };
} = {}) {

  const roles = user?.roles ?? [];
  const isSupervisorOnly = roles.includes("SUPERVISOR") && !roles.includes("ADMIN");
  const [savedSignatories, setSavedSignatories] = useState<SavedSignatories>(() => loadSavedSignatories(user?.displayName ?? ""));
  const updateSavedSignatory = (field: keyof SavedSignatories, value: string) => {
    setSavedSignatories((current) => {
      const next = { ...current, [field]: value };
      localStorage.setItem(signatoriesKey(user?.displayName ?? ""), JSON.stringify(next));
      return next;
    });
  };
  // Prepared By's position defaults to "Supervisor" for a supervisor, and to
  // the logged-in user's own position otherwise, until they type their own
  // (an account with no employee record has none).
  useEffect(() => {
    if (loadSavedSignatoriesRaw(user?.displayName ?? "").preparedPosition !== undefined) return;
    if (isSupervisorOnly) {
      setSavedSignatories((current) => (current.preparedPosition ? current : { ...current, preparedPosition: "Supervisor" }));
      return;
    }
    if (!user?.employeeId) return;
    let cancelled = false;
    apiRequest<{ position?: { title: string } | null }>("/employees/me")
      .then((profile) => {
        const title = profile.position?.title;
        if (!cancelled && title) {
          setSavedSignatories((current) => (current.preparedPosition ? current : { ...current, preparedPosition: title }));
        }
      })
      .catch(() => {
        // Best-effort — the field just stays blank to type in.
      });
    return () => {
      cancelled = true;
    };
  }, [user?.employeeId, user?.displayName, isSupervisorOnly]);
  const signatories: Signatory[] = [
    { name: savedSignatories.preparedName, position: savedSignatories.preparedPosition },
    { name: savedSignatories.notedName, position: savedSignatories.notedPosition },
  ];
  const isDepartmentLocked = roles.includes("SUPERVISOR") && !roles.includes("ADMIN");

  const [data, setData] = useState<ReportData | null>(null);
  // Shown instead of the endless "Loading reports…" when /reports fails.
  const [loadError, setLoadError] = useState("");
  const [exportError, setExportError] = useState("");
  const [tab, setTab] = useState<ReportTab>("ALL");
  // Both default to today (not month-start) — a same-day From/To range is
  // what lets the backend reconstruct Absent/On-Leave rows (see
  // ReportsService.summary's singleDay check), so today's report shows real
  // Present/Absent/On Leave statuses by default instead of only whichever
  // employees happen to already have a materialized attendance record.
  const [filters, setFilters] = useState({
    from: new Date().toISOString().slice(0, 10),
    to: new Date().toISOString().slice(0, 10),
    department: "ALL",
  });
  // Applied client-side on top of the loaded report, and — like the status
  // tabs — narrows the exports and result count too, not just the tables.
  const [search, setSearch] = useState("");
  // Narrows the DTR / Attendance table (and its exports) to one status.
  const [attendanceStatusFilter, setAttendanceStatusFilter] = useState("ALL");
  const [leaveStatusFilter, setLeaveStatusFilter] = useState<"ALL" | LeaveStatusBucket>("ALL");
  const [undertimeStatusFilter, setUndertimeStatusFilter] = useState<"ALL" | UndertimeStatus>("ALL");

  const loadReport = () => {
    const params = new URLSearchParams();
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    if (filters.department !== "ALL") params.set("department", filters.department);
    const query = params.toString();
    setLoadError("");
    apiRequest<ReportData>(`/reports${query ? `?${query}` : ""}`)
      .then(setData)
      .catch((error) => {
        console.error("[REPORTS] Failed to load /reports", error);
        setLoadError(error instanceof Error && error.message ? error.message : "Unable to load reports.");
      });
  };

  useEffect(loadReport, [filters.from, filters.to, filters.department]);
  useEffect(() => {
    loadSheetJs().catch(() => {
      sheetJsPromise = null; // retried on Export
    });
  }, []);
  // A heavier payload than most pages, so polled less often.
  useLiveRefresh(loadReport, true, 30_000);

  const { departmentNames: departments } = useActiveDepartments();

  // --- Client-side filtering for all report types ---
  const filteredAttendance = useMemo(() => {
    if (!data) return [];
    const rows = data.attendance.filter((record) => {
      const deptMatch = filters.department === "ALL" || record.employee.department.name === filters.department;
      const dateMatch = isInDateRange(record.attendanceDate, filters.from, filters.to);
      const statusMatch = attendanceStatusFilter === "ALL" || record.status === attendanceStatusFilter;
      return deptMatch && dateMatch && statusMatch && matchesEmployeeQuery(record.employee, search);
    });
    return sortByDepartment(rows, personOfRow);
  }, [data, filters, search, attendanceStatusFilter]);

  // Department Attendance Summary (All Reports): the same department, date
  // and search filters as the DTR table, but every status, so it always
  // shows the full breakdown even while the Status filter narrows the table.
  // One AttendanceRecord per employee per day, so a multi-day range counts
  // employee-days. Pending Review / Flagged only count toward Total.
  const departmentSummary = useMemo(() => {
    type Counts = { present: number; late: number; absent: number; onLeave: number; total: number };
    const empty = (): Counts => ({ present: 0, late: 0, absent: 0, onLeave: 0, total: 0 });
    const byDepartment = new Map<string, Counts>();
    // Every active department is listed, with 0s where it has no records —
    // just the chosen one when filtered, and only matching ones while
    // searching for an employee.
    if (!search.trim()) {
      for (const name of filters.department === "ALL" ? departments : [filters.department]) {
        byDepartment.set(name, empty());
      }
    }
    const total = empty();
    for (const record of data?.attendance ?? []) {
      if (filters.department !== "ALL" && record.employee.department.name !== filters.department) continue;
      if (!isInDateRange(record.attendanceDate, filters.from, filters.to)) continue;
      if (!matchesEmployeeQuery(record.employee, search)) continue;
      const name = record.employee.department.name;
      const row = byDepartment.get(name) ?? empty();
      byDepartment.set(name, row);
      const key: keyof Counts | null =
        record.status === "PRESENT"
          ? "present"
          : record.status === "LATE"
            ? "late"
            : record.status === "ABSENT"
              ? "absent"
              : record.status === "ON_LEAVE"
                ? "onLeave"
                : null;
      for (const counts of [row, total]) {
        if (key) counts[key] += 1;
        counts.total += 1;
      }
    }
    const rows = [...byDepartment.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([department, counts]) => ({ department, ...counts }));
    const other = total.total - total.present - total.late - total.absent - total.onLeave;
    return { rows, total, other };
  }, [data, filters, search, departments]);
  // Printed title of one part: "Leave Report" etc. inside All Reports, the
  // tab's own name otherwise.
  const partTitle = (part: ReportTab) => (tab === "ALL" ? `${REPORT_TYPE_LABELS[part]} Report` : REPORT_TYPE_LABELS[tab]);
  const departmentSummaryTitle = `Department Attendance Summary${filters.from !== filters.to ? " (employee-days)" : ""}`;

  const leavesInRange = useMemo(() => {
    if (!data) return [];
    const rows = data.leaves.filter((request) => {
      const deptMatch = filters.department === "ALL" || request.employee.department.name === filters.department;
      // Show leave if it overlaps the date range at all
      const startInRange = isInDateRange(request.startDate, filters.from, filters.to);
      const endInRange = isInDateRange(request.endDate, filters.from, filters.to);
      const spanRange =
        new Date(request.startDate).getTime() <= parseLocalDateFilter(filters.to, true) &&
        new Date(request.endDate).getTime() >= parseLocalDateFilter(filters.from);
      return deptMatch && (startInRange || endInRange || spanRange) && matchesEmployeeQuery(request.employee, search);
    });
    // Latest dates first within each employee (sortByDepartment is stable).
    rows.sort(
      (a, b) =>
        new Date(b.endDate).getTime() - new Date(a.endDate).getTime() ||
        new Date(b.startDate).getTime() - new Date(a.startDate).getTime(),
    );
    return sortByDepartment(rows, personOfRow);
  }, [data, filters, search]);

  const leaveStatusCounts = useMemo(() => {
    const counts: Record<LeaveStatusBucket, number> = { PENDING: 0, APPROVED: 0, REJECTED: 0, CANCELLED: 0, LAPSED: 0 };
    for (const r of leavesInRange) counts[leaveStatusBucket(r.status)] += 1;
    return counts;
  }, [leavesInRange]);

  const filteredLeaves = useMemo(() => {
    if (leaveStatusFilter === "ALL") return leavesInRange;
    return leavesInRange.filter((request) => leaveStatusBucket(request.status) === leaveStatusFilter);
  }, [leavesInRange, leaveStatusFilter]);

  const undertimeInRange = useMemo(() => {
    if (!data) return [];
    const rows = (data.undertime ?? []).filter((filing) => {
      const deptMatch = filters.department === "ALL" || filing.employee.department.name === filters.department;
      return (
        deptMatch &&
        isInDateRange(filing.attendanceRecord.attendanceDate, filters.from, filters.to) &&
        matchesEmployeeQuery(filing.employee, search)
      );
    });
    return sortByDepartment(rows, personOfRow);
  }, [data, filters, search]);

  const undertimeStatusCounts = useMemo(() => {
    const counts: Record<UndertimeStatus, number> = { PENDING: 0, APPROVED: 0, REJECTED: 0 };
    for (const filing of undertimeInRange) {
      if (filing.status in counts) counts[filing.status as UndertimeStatus] += 1;
    }
    return counts;
  }, [undertimeInRange]);

  // Like the leave status tabs: also narrows what the exports and the
  // result count include, not just the table on screen.
  const filteredUndertime = useMemo(() => {
    if (undertimeStatusFilter === "ALL") return undertimeInRange;
    return undertimeInRange.filter((filing) => filing.status === undertimeStatusFilter);
  }, [undertimeInRange, undertimeStatusFilter]);

  const filteredSchedules = useMemo(() => {
    if (!data) return [];
    const rows = data.schedules.filter((schedule) => {
      const deptMatch = filters.department === "ALL" || schedule.employee.department.name === filters.department;
      const startInRange = isInDateRange(schedule.startsOn, filters.from, filters.to);
      const endsOnOrOngoing = !schedule.endsOn || isInDateRange(schedule.endsOn, filters.from, filters.to);
      const active =
        new Date(schedule.startsOn).getTime() <= parseLocalDateFilter(filters.to, true) &&
        (!schedule.endsOn || new Date(schedule.endsOn).getTime() >= parseLocalDateFilter(filters.from));
      return deptMatch && (startInRange || endsOnOrOngoing || active) && matchesEmployeeQuery(schedule.employee, search);
    });
    return sortByDepartment(rows, personOfRow);
  }, [data, filters, search]);

  // Employee directory / leave balances are point-in-time snapshots, not
  // bounded by the from/to range — only the department filter applies.
  const filteredEmployeesList = useMemo(() => {
    if (!data) return [];
    const rows = data.employees.filter(
      (e) => (filters.department === "ALL" || e.department.name === filters.department) && matchesEmployeeQuery(e, search),
    );
    return sortByDepartment(rows, personSelf);
  }, [data, filters.department, search]);

  const filteredLeaveBalances = useMemo(() => {
    if (!data) return [];
    const rows = data.leaveBalances.filter(
      (b) =>
        (filters.department === "ALL" || b.employee.department.name === filters.department) &&
        matchesEmployeeQuery(b.employee, search),
    );
    return sortByDepartment(rows, personOfRow);
  }, [data, filters.department, search]);

  // Like Remaining Leave: the leave year of the "To" date, department filter only.
  const filteredVlMonetizations = useMemo(() => {
    if (!data) return [];
    const rows = (data.vlMonetizations ?? []).filter(
      (m) =>
        (filters.department === "ALL" || m.employee.department.name === filters.department) &&
        matchesEmployeeQuery(m.employee, search),
    );
    return sortByDepartment(rows, personOfRow);
  }, [data, filters.department, search]);
  const vlMonetizationCells = (m: NonNullable<ReportData["vlMonetizations"]>[number]): (string | number)[] => [
    `${m.employee.firstName} ${m.employee.lastName}`, m.employee.department.name, formatSex(m.employee.sex),
    String(m.year), formatDays(m.days), formatDate(m.monetizedAt),
  ];

  // Filtered totals for stat cards
  const filteredTotals = useMemo(() => ({
    attendanceRecords: filteredAttendance.length,
    approvedLeaves: filteredLeaves.filter((l) => l.status === "APPROVED").length,
    pendingLeaves: filteredLeaves.filter((l) => l.status === "PENDING").length,
    activeSchedules: filteredSchedules.filter((s) => !s.endsOn).length,
  }), [filteredAttendance, filteredLeaves, filteredSchedules]);

  if (!data && loadError) {
    return (
      <section className="table-card reports-loading">
        Couldn't load reports: {loadError}{" "}
        <button type="button" className="outline-button" onClick={loadReport}>
          Retry
        </button>
      </section>
    );
  }

  if (!data) {
    return <section className="table-card reports-loading"><span className="reports-loading-dot" />Loading reports…</section>;
  }

  const generatedRangeLabel = `Generated: ${filters.from ? formatDate(filters.from) : "—"} to ${filters.to ? formatDate(filters.to) : "—"}`;

  // Runs an export; only a failure is shown next to the buttons.
  const runExport = async (exporter: () => Promise<void>) => {
    setExportError("");
    try {
      await exporter();
      loadReport();
    } catch (error) {
      console.error("[REPORTS] Export failed", error);
      setExportError(`Export failed: ${error instanceof Error && error.message ? error.message : String(error)}`);
    }
  };

  const exportCsv = async () => {
    const target =
      tab === "ALL"
        ? await openSaveTarget("all-report.xlsx", "Excel workbook", XLSX_TYPE, ".xlsx")
        : await openSaveTarget(`${tab}-report.csv`, "CSV file", "text/csv", ".csv");
    if (!target) return;
    const aRows = [
      ["Employee", "Department", "Site", "Date", "Time In", "Time Out", "Lunch / Break", "Status"],
      ...filteredAttendance.map((r) => [
        employeeName(r), r.employee.department.name, r.workLocation?.name ?? "—", formatDate(r.attendanceDate),
        formatTime(r.timeInAt, r.status), formatTime(r.timeOutAt, r.status),
        r.lunchOutAt ? `${r.breakKind === "BREAK" ? "Break " : ""}${formatTime(r.lunchOutAt)} - ${formatTime(r.lunchInAt)}` : "—", r.status,
      ]),
    ];
    const lRows = [
      ["Employee", "Department", "Classification", "Leave Type", "Dates", "Days", "Status"],
      ...filteredLeaves.map((r) => [
        employeeName(r), r.employee.department.name, formatEmploymentStatus(r.employee.employmentStatus), r.leaveType.name,
        `${formatDate(r.startDate)} - ${formatDate(r.endDate)}`, r.totalDays, leaveStatusText(r),
      ]),
    ];
    const uRows = [UNDERTIME_HEAD, ...filteredUndertime.map(undertimeCells)];
    const sRows = [
      ["Employee", "Department", "Position", "Shift", "Time", "Effective Dates"],
      ...filteredSchedules.map((s) => [
        employeeName(s), s.employee.department.name, s.employee.position?.title ?? "—", s.shift.name,
        `${s.shift.startTime} - ${s.shift.endTime}`, `${formatDate(s.startsOn)} - ${s.endsOn ? formatDate(s.endsOn) : "Present"}`,
      ]),
    ];
    const eRows = [
      ["Name", "Department", "Sex", "Hired Date"],
      ...filteredEmployeesList.map((e) => [`${e.firstName} ${e.lastName}`, e.department.name, formatSex(e.sex), formatDate(e.hireDate)]),
    ];
    const rbRows = [
      ["Name", "Department", "Sex", "Leave Type", "Remaining", "Used", "Dates Used"],
      ...filteredLeaveBalances.map((b) => [
        `${b.employee.firstName} ${b.employee.lastName}`, b.employee.department.name, formatSex(b.employee.sex),
        b.leaveTypeName, formatDays(b.remainingDays), formatDays(b.usedDays), formatUsedDates(b.usedDates),
      ]),
    ];
    // Signatures closing each part: Prepared By in the first column, Noted
    // By a few columns over, as in the HR's DTR summary.
    const signRows = [
      [], [],
      [SIGNATORY_LABELS[0], "", "", "", SIGNATORY_LABELS[1]],
      [], [],
      [signatories[0].name.toUpperCase(), "", "", "", signatories[1].name.toUpperCase()],
      [signatories[0].position, "", "", "", signatories[1].position],
    ];
    const rows: (string | number)[][] =
      tab === "attendance" ? [...aRows, ...signRows]
      : tab === "leave" ? [...lRows, ...signRows]
      : tab === "undertime" ? [...uRows, ...signRows]
      : tab === "schedules" ? [...sRows, ...signRows]
      : tab === "employees" ? [...eRows, ...signRows]
      : tab === "leaveBalances" ? [...rbRows, ...signRows]
      : tab === "vlMonetization" ? [VL_MONETIZATION_HEAD, ...filteredVlMonetizations.map(vlMonetizationCells), ...signRows]
      : [];
    // All Report Types: an Excel workbook with one tab per report, since a
    // CSV file can only hold a single sheet.
    if (tab === "ALL") {
      const summaryRows: (string | number)[][] = [
        ["Department", "Present", "Late", "Absent", "On Leave", "Total"],
        ...departmentSummary.rows.map((row) => [row.department, row.present, row.late, row.absent, row.onLeave, row.total]),
        ["Grand Total", departmentSummary.total.present, departmentSummary.total.late, departmentSummary.total.absent, departmentSummary.total.onLeave, departmentSummary.total.total],
      ];
      // Excel sheet names can't contain "/" and max out at 31 characters.
      const sheets: [string, (string | number)[][]][] = [
        ["Attendance Summary", summaryRows],
        ["DTR - Attendance", aRows],
        ["Leave", lRows],
        ["Undertime", uRows],
        ["Schedules", sRows],
        ["List of Employees", eRows],
        ["Remaining Leave", rbRows],
        ["VL Monetization", [VL_MONETIZATION_HEAD, ...filteredVlMonetizations.map(vlMonetizationCells)]],
      ];
      const XLSX = await loadSheetJs();
      const workbook = XLSX.utils.book_new();
      for (const [name, sheetRows] of sheets) {
        const sheet = XLSX.utils.aoa_to_sheet([[generatedRangeLabel], [], ...sheetRows, ...signRows]);
        // Columns wide enough for their longest value, so names aren't cut off.
        sheet["!cols"] = sheetRows[0].map((_, col) => ({
          wch: Math.min(45, Math.max(10, ...sheetRows.map((row) => String(row[col] ?? "").length + 2))),
        }));
        XLSX.utils.book_append_sheet(workbook, sheet, name);
      }
      const data = XLSX.write(workbook, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
      await target.save(new Blob([data], { type: XLSX_TYPE }));
      return;
    }
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    // Leading BOM tells Excel the file is UTF-8 — without it Excel reads it
    // as ANSI and "—" shows up as "â€”".
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    await target.save(blob);
  };

  const exportPdf = async () => {
    const target = await openSaveTarget(`${tab === "ALL" ? "all" : tab}-report.pdf`, "PDF file", "application/pdf", ".pdf");
    if (!target) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" }) as any;
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 40;

    // Header matches the on-screen print header: centered logo, the report
    // type as a title below it, then the generated date range as plain text.
    // Drawn on every page (tables call it from didDrawPage), and every table
    // starts below it, so it never covers data.
    let logoImage: { dataUrl: string; width: number; height: number } | null = null;
    try {
      const { dataUrl, width, height } = await loadImageDataUrl(logo);
      // About the printed logo's share of the page width.
      const scale = 210 / width;
      logoImage = { dataUrl, width: width * scale, height: height * scale };
    } catch {
      // Logo failed to load — still produce the report without it.
    }

    // The header's title/subtitle: the report's own at first; in All Reports
    // each later part (Leave, Undertime, Schedules) switches it to its own.
    let header: { title: string; subtitle?: string } = {
      title: tab === "ALL" ? ALL_REPORTS_SUMMARY_TITLE : REPORT_TYPE_LABELS[tab],
    };

    // Draws the header on the current page and returns the y just below it.
    const drawHeader = () => {
      let y = 32;
      if (logoImage) {
        doc.addImage(logoImage.dataUrl, "PNG", pageWidth / 2 - logoImage.width / 2, y, logoImage.width, logoImage.height);
        y += logoImage.height + 16;
      }

      doc.setFont(undefined, "bold");
      doc.setFontSize(14);
      doc.setTextColor(26, 58, 92);
      doc.text(header.title, pageWidth / 2, y, { align: "center" });
      doc.setFont(undefined, "normal");
      y += 18;

      if (header.subtitle) {
        doc.setFontSize(8);
        doc.setTextColor(107, 130, 153);
        doc.text(header.subtitle, pageWidth / 2, y, { align: "center" });
        y += 14;
      }

      doc.setFont(undefined, "bold");
      doc.setFontSize(9);
      doc.setTextColor(45, 74, 101);
      doc.text(generatedRangeLabel, pageWidth / 2, y, { align: "center" });
      doc.setFont(undefined, "normal");
      y += 10;
      doc.setDrawColor(215, 226, 236);
      doc.line(margin, y, pageWidth - margin, y);
      return y + 18;
    };

    let headerBottom = drawHeader();
    let startY = headerBottom;
    let headerDrawnOnPage = doc.internal.getNumberOfPages();
    let sectionsDrawn = 0;

    // Signature block right after a part's last table — moved to a fresh
    // page (under the header) when it doesn't fit below it.
    const drawSignatories = () => {
      const pageHeight = doc.internal.pageSize.getHeight();
      let signY = startY + 10;
      if (signY + 70 > pageHeight - 30) {
        doc.addPage();
        drawHeader();
        headerDrawnOnPage = doc.internal.getNumberOfPages();
        signY = headerBottom + 10;
      }
      // Prepared By centered in the left half, Noted By in the right half:
      // label, room to sign, line, name in capitals, position.
      const lineWidth = 200;
      const signatoryX = [pageWidth * 0.25 - lineWidth / 2, pageWidth * 0.75 - lineWidth / 2];
      doc.setTextColor(30, 41, 59);
      doc.setDrawColor(30, 41, 59);
      SIGNATORY_LABELS.forEach((label, i) => {
        const x = signatoryX[i];
        const center = x + lineWidth / 2;
        doc.setFont(undefined, "normal");
        doc.setFontSize(10);
        doc.text(label, x, signY);
        doc.line(x, signY + 34, x + lineWidth, signY + 34);
        doc.setFont(undefined, "bold");
        doc.text(signatories[i].name.toUpperCase(), center, signY + 47, { align: "center" });
        doc.setFont(undefined, "normal");
        doc.setFontSize(9);
        doc.text(signatories[i].position, center, signY + 59, { align: "center" });
      });
    };

    // Width of one "Dates Used" slot: the longest range plus a gap. Sized
    // from the whole section so every department's columns line up.
    let sectionDateSlot = 0;
    const dateSlotWidth = (body: (string | number)[][], col: number) => {
      doc.setFontSize(8);
      const ranges = body.flatMap((row) => String(row[col] ?? "").split(/\n|, /));
      sectionDateSlot = Math.max(0, ...ranges.map((range) => doc.getTextWidth(range))) + 6;
      return sectionDateSlot;
    };

    const addSection = (
      title: string,
      head: string[],
      body: (string | number)[][],
      // centerFrom: columns from this index on (counts) are centered.
      // byDepartment: body is sorted by department (column 1) — each
      // department is drawn as its own titled block.
      options: { boldLastRow?: boolean; partTitle?: string; centerFrom?: number; byDepartment?: boolean } = {},
    ) => {
      if (body.length === 0) return;
      // A new part of All Reports: the previous part is signed off, then
      // this one gets its own page, headed with its own title.
      if (options.partTitle && tab === "ALL" && sectionsDrawn > 0) {
        drawSignatories();
        doc.addPage();
        header = { title: options.partTitle };
        headerBottom = drawHeader();
        startY = headerBottom;
        headerDrawnOnPage = doc.internal.getNumberOfPages();
      }
      sectionsDrawn += 1;
      // As in print, a section's own label only shows in All Reports.
      if (tab === "ALL") {
        doc.setFont(undefined, "bold");
        doc.setFontSize(10);
        doc.setTextColor(26, 58, 92);
        doc.text(title, margin, startY);
        doc.setFont(undefined, "normal");
        startY += 8;
      }

      if (!options.byDepartment) {
        drawTable(head, body, startY, options);
        return;
      }
      // One set of column widths for every department's table, sized from
      // the whole section — otherwise each table fits only its own rows and
      // the columns shift from one department to the next.
      doc.setFontSize(8);
      const textWidth = (value: string | number) =>
        Math.max(...String(value).split("\n").map((line) => doc.getTextWidth(line))) + 12;
      // Column headings are drawn bold in capitals at 7.5pt.
      const headingWidth = (label: string) => {
        doc.setFont(undefined, "bold");
        doc.setFontSize(7.5);
        const width = Math.max(...label.toUpperCase().split(" ").map((word) => doc.getTextWidth(word))) + 12;
        doc.setFont(undefined, "normal");
        doc.setFontSize(8);
        return width;
      };
      const natural = head.map((label, col) =>
        Math.max(textWidth(label), ...body.map((row) => textWidth(row[col] ?? ""))),
      );
      // Narrowest a column may get: its longest single word, so text only
      // wraps between words ("Tobacco / Production"), never inside one.
      const longestWord = (value: string | number) =>
        Math.max(0, ...String(value).split(/\s+/).map((word) => doc.getTextWidth(word))) + 12;
      const minimum = head.map((label, col) =>
        Math.max(headingWidth(label), ...body.map((row) => longestWord(row[col] ?? ""))),
      );
      minimum.forEach((width, col) => (natural[col] = Math.max(natural[col], width)));
      // Room for three full date slots (see drawTable).
      const datesCol = head.indexOf("Dates Used");
      if (datesCol >= 0) natural[datesCol] = Math.max(natural[datesCol], dateSlotWidth(body, datesCol) * 3 + 2);
      const available = pageWidth - margin * 2;
      const naturalTotal = natural.reduce((sum, width) => sum + width, 0);
      // Spare room is shared out evenly. When it's too wide, each column
      // keeps its minimum and gives up part of the rest (long text then
      // wraps between words) — except "Dates Used", which keeps its three
      // slots so they never overlap.
      const minimumTotal = minimum.reduce((sum, width, col) => sum + (col === datesCol ? natural[col] : width), 0);
      const flexTotal = natural.reduce((sum, width, col) => sum + (col === datesCol ? 0 : width - minimum[col]), 0);
      const flexRoom = Math.max(0, available - minimumTotal);
      const widths =
        naturalTotal <= available
          ? natural.map((width) => width + (available - naturalTotal) / natural.length)
          : natural.map((width, col) =>
              col === datesCol
                ? width
                : minimum[col] + (flexTotal > 0 ? ((width - minimum[col]) / flexTotal) * flexRoom : 0),
            );
      const columnStyles = Object.fromEntries(widths.map((cellWidth, col) => [col, { cellWidth }]));
      const groups = groupByDepartment(body, (row) => ({
        firstName: "",
        lastName: "",
        department: { name: String(row[1] ?? "") },
      }));
      // Like the print: one table, each department opened by a shaded
      // full-width heading row.
      const rows = groups.flatMap((group) => [
        [{
          content: `${departmentHeading(group.department)} (${group.rows.length})`,
          colSpan: head.length,
          styles: {
            halign: "left" as const,
            fontStyle: "bold" as const,
            fillColor: [238, 243, 249] as [number, number, number],
            textColor: [26, 58, 92] as [number, number, number],
            lineColor: [215, 226, 236] as [number, number, number],
          },
        }],
        ...group.rows,
      ]);
      drawTable(head, rows, startY, { ...options, columnStyles });
    };

    const drawTable = (
      head: string[],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: any[][],
      tableStartY: number,
      options: { boldLastRow?: boolean; centerFrom?: number; columnStyles?: Record<number, { cellWidth: number }> },
    ) => {
      // Remaining Leave's "Dates Used": the text keeps three ranges per line
      // (so the row gets the right height), but each range is drawn at a
      // fixed slot so the three columns line up from row to row.
      const datesCol = head.indexOf("Dates Used");
      const dateSlot = datesCol < 0 ? 0 : sectionDateSlot || dateSlotWidth(body, datesCol);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const isDatesCell = (cell: any) =>
        cell.section === "body" && cell.column.index === datesCol && cell.cell.raw !== "—";
      autoTable(doc, {
        startY: tableStartY,
        // Styled like the printed table: light heading row in uppercase,
        // white rows split by thin lines, everything centered.
        head: [head.map((label) => label.toUpperCase())],
        body,
        theme: "plain" as const,
        // A row is never split across two pages.
        rowPageBreak: "avoid" as const,
        columnStyles: options.columnStyles,
        headStyles: {
          fillColor: [244, 248, 252] as [number, number, number],
          textColor: [74, 102, 128] as [number, number, number],
          fontSize: 7.5,
          fontStyle: "bold" as const,
          halign: "center" as const,
          lineWidth: { bottom: 1 },
          lineColor: [227, 234, 242] as [number, number, number],
        },
        bodyStyles: {
          fontSize: 8,
          textColor: [45, 74, 101] as [number, number, number],
          halign: "center" as const,
          valign: "middle" as const,
          lineWidth: { bottom: 0.5 },
          lineColor: [232, 238, 244] as [number, number, number],
        },
        // Pages a table flows onto start below the repeated header; its
        // column headings repeat there too (autoTable's default).
        margin: { left: 40, right: 40, top: headerBottom },
        didDrawPage: () => {
          const page = doc.internal.getNumberOfPages();
          if (page !== headerDrawnOnPage) {
            drawHeader();
            headerDrawnOnPage = page;
          }
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        didParseCell: (cell: any) => {
          if (options.centerFrom !== undefined && cell.column.index >= options.centerFrom) {
            cell.cell.styles.halign = "center";
          }
          if (options.boldLastRow && cell.section === "body" && cell.row.index === body.length - 1) {
            cell.cell.styles.fontStyle = "bold";
          }
          // An open-ended schedule's "Present", green bold as on screen.
          if (cell.section === "body" && cell.cell.raw === "Present" && head[cell.column.index] === "Until") {
            cell.cell.styles.fontStyle = "bold";
            cell.cell.styles.textColor = [46, 125, 50];
          }
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        willDrawCell: (cell: any) => {
          if (isDatesCell(cell)) cell.cell.text = [];
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        didDrawCell: (cell: any) => {
          if (!isDatesCell(cell)) return;
          const lineHeight = 8 * doc.getLineHeightFactor();
          doc.setFontSize(8);
          doc.setTextColor(45, 74, 101);
          // The three-slot block is centered in the cell, like the other columns.
          const blockLeft = cell.cell.x + Math.max(cell.cell.padding("left"), (cell.cell.width - dateSlot * 3) / 2);
          String(cell.cell.raw).split("\n").forEach((line, lineIndex) => {
            line.split(", ").forEach((range, slot) => {
              doc.text(
                range,
                blockLeft + slot * dateSlot,
                cell.cell.y + cell.cell.padding("top") + lineIndex * lineHeight,
                { baseline: "top" },
              );
            });
          });
        },
      });
      startY = doc.lastAutoTable.finalY + 24;
    };

    if (tab === "ALL") {
      addSection(
        departmentSummaryTitle,
        ["Department", "Present", "Late", "Absent", "On Leave", "Total"],
        departmentSummary.rows.length === 0
          ? []
          : [
              ...departmentSummary.rows.map((row) => [row.department, row.present, row.late, row.absent, row.onLeave, row.total]),
              ["Grand Total", departmentSummary.total.present, departmentSummary.total.late, departmentSummary.total.absent, departmentSummary.total.onLeave, departmentSummary.total.total],
            ],
        { boldLastRow: true, centerFrom: 1 },
      );
    }
    if (tab === "ALL" || tab === "attendance") {
      addSection("DTR / Attendance",
        ["Employee", "Department", "Site", "Date", "Time In", "Time Out", "Lunch / Break", "Status"],
        filteredAttendance.map((r) => [
          employeeName(r), r.employee.department.name, r.workLocation?.name ?? "—", formatDate(r.attendanceDate),
          formatTime(r.timeInAt, r.status), formatTime(r.timeOutAt, r.status),
          r.lunchOutAt ? `${r.breakKind === "BREAK" ? "Break " : ""}${formatTime(r.lunchOutAt)} - ${formatTime(r.lunchInAt)}` : "—", r.status,
        ]),
        { partTitle: partTitle("attendance"), byDepartment: true },
      );
    }
    if (tab === "ALL" || tab === "leave") {
      addSection("Leave",
        ["Employee", "Department", "Classification", "Leave Type", "Start Date", "End Date", "Days", "Status"],
        filteredLeaves.map((r) => [
          employeeName(r), r.employee.department.name, formatEmploymentStatus(r.employee.employmentStatus), r.leaveType.name,
          formatDate(r.startDate), formatDate(r.endDate), r.totalDays, leaveStatusText(r),
        ]),
        { partTitle: partTitle("leave"), byDepartment: true },
      );
    }
    if (tab === "ALL" || tab === "undertime") {
      addSection("Undertime", UNDERTIME_HEAD, filteredUndertime.map(undertimeCells), { partTitle: partTitle("undertime"), byDepartment: true });
    }
    if (tab === "ALL" || tab === "schedules") {
      addSection("Schedules",
        // Start and end in their own columns so each lines up in the PDF.
        ["Employee", "Department", "Position", "Shift", "Time", "Effective From", "Until"],
        filteredSchedules.map((s) => [
          employeeName(s), s.employee.department.name, s.employee.position?.title ?? "—", s.shift.name,
          `${s.shift.startTime} - ${s.shift.endTime}`, formatDate(s.startsOn), s.endsOn ? formatDate(s.endsOn) : "Present",
        ]),
        { partTitle: partTitle("schedules"), byDepartment: true },
      );
    }
    if (tab === "ALL" || tab === "employees") {
      addSection("List of Employees",
        ["Name", "Department", "Sex", "Hired Date"],
        filteredEmployeesList.map((e) => [`${e.firstName} ${e.lastName}`, e.department.name, formatSex(e.sex), formatDate(e.hireDate)]),
        { partTitle: partTitle("employees"), byDepartment: true },
      );
    }
    if (tab === "ALL" || tab === "leaveBalances") {
      addSection("Remaining Leave",
        ["Name", "Department", "Sex", "Leave Type", "Remaining", "Used", "Dates Used"],
        filteredLeaveBalances.map((b) => [
          `${b.employee.firstName} ${b.employee.lastName}`, b.employee.department.name, formatSex(b.employee.sex),
          b.leaveTypeName, formatDays(b.remainingDays), formatDays(b.usedDays), formatUsedDates(b.usedDates),
        ]),
        { partTitle: partTitle("leaveBalances"), byDepartment: true },
      );
    }

    if (tab === "ALL" || tab === "vlMonetization") {
      addSection("VL Monetization", VL_MONETIZATION_HEAD, filteredVlMonetizations.map(vlMonetizationCells), { partTitle: partTitle("vlMonetization"), byDepartment: true });
    }

    // The last part's signatures (earlier parts get theirs in addSection).
    if (sectionsDrawn > 0) drawSignatories();

    const blob = doc.output("blob") as Blob;
    await target.save(blob);
  };

  return (
    <>


      {/* ── Toolbar (screen only) ── */}
      <div className="reports-toolbar">
        <div className="reports-toolbar-left">
          <h2 className="reports-title">Reports</h2>
        </div>
      </div>

      {/* ── Filter Bar + export actions: two cards side by side on one row ── */}
      <div className="reports-filter-row">
      <div className="reports-filter-bar">
        <div className="reports-filter-group employee-search-group">
          <label className="reports-filter-label">Search</label>
          <EmployeeSearchSelect
            value={search}
            onChange={setSearch}
            options={data.employees.filter(
              (e) => filters.department === "ALL" || e.department.name === filters.department,
            )}
          />
        </div>

        {!isDepartmentLocked && (
          <div className="reports-filter-group">
            <label className="reports-filter-label">Department</label>
            <DropdownFilter
              className="reports-select"
              value={filters.department}
              onChange={(value) => setFilters((c) => ({ ...c, department: value }))}
              options={departments.map((d) => ({ value: d, label: d }))}
              allLabel="All Departments"
              menuLabel="Filter by department"
              ariaLabel="Report department"
            />
          </div>
        )}

        <div className="reports-filter-group">
          <label className="reports-filter-label">Report Type</label>
          <DropdownFilter
            className="reports-select"
            value={tab}
            onChange={(value) => setTab(value as ReportTab)}
            options={[
              { value: "attendance", label: "DTR / Attendance" },
              { value: "leave", label: "Leave" },
              { value: "undertime", label: "Undertime" },
              { value: "schedules", label: "Schedules" },
              { value: "employees", label: "List of Employees" },
              { value: "leaveBalances", label: "Remaining Leave" },
              { value: "vlMonetization", label: "VL Monetization" },
            ]}
            allLabel="All Report Types"
            menuLabel="Filter by report type"
            ariaLabel="Report type"
          />
        </div>

        {/* Only attendance rows carry these statuses, so the filter is
            hidden on report types it can't affect. */}
        {(tab === "ALL" || tab === "attendance") && (
          <div className="reports-filter-group">
            <label className="reports-filter-label">Status</label>
            <DropdownFilter
              className="reports-select"
              value={attendanceStatusFilter}
              onChange={setAttendanceStatusFilter}
              options={[
                { value: "PRESENT", label: "Present" },
                { value: "LATE", label: "Late" },
                { value: "ABSENT", label: "Absent" },
                { value: "ON_LEAVE", label: "On Leave" },
              ]}
              allLabel="All Status"
              menuLabel="Filter by attendance status"
              ariaLabel="Attendance status"
            />
          </div>
        )}

        <div className="reports-filter-group">
          <label className="reports-filter-label">From</label>
          <input
            type="date"
            value={filters.from}
            onChange={(e) => setFilters((c) => ({ ...c, from: e.target.value }))}
            aria-label="Report start date"
          />
        </div>

        <div className="reports-filter-group">
          <label className="reports-filter-label">To</label>
          <input
            type="date"
            value={filters.to}
            onChange={(e) => setFilters((c) => ({ ...c, to: e.target.value }))}
            aria-label="Report end date"
          />
        </div>
      </div>

        <div className="reports-filter-actions">
          <span className="reports-filter-label">Actions</span>
          <div className="reports-filter-actions-buttons">
          <button className="report-export-button" onClick={() => runExport(exportCsv)}>
            <Download size={14} />
            <span>Export CSV</span>
          </button>
          <button className="report-export-button" onClick={() => runExport(exportPdf)}>
            <FileText size={14} />
            <span>Export PDF</span>
          </button>
          <button className="report-export-button" onClick={() => { window.print(); loadReport(); }}>
            <Printer size={14} />
            <span>Print</span>
          </button>
          </div>
          {exportError && (
            <p className="reports-export-error" role="alert">
              {exportError}
            </p>
          )}
        </div>
      </div>

      {/* ── Signatories: printed at the end of every report ── */}
      <div className="reports-signatories-bar">
        <div className="reports-filter-group">
          <label className="reports-filter-label">Prepared By</label>
          <div className="reports-signatory-inputs">
            <input
              value={savedSignatories.preparedName}
              onChange={(e) => updateSavedSignatory("preparedName", e.target.value)}
              placeholder="Name"
              aria-label="Prepared by name"
            />
            <input
              value={savedSignatories.preparedPosition}
              onChange={(e) => updateSavedSignatory("preparedPosition", e.target.value)}
              placeholder="Position"
              aria-label="Prepared by position"
            />
          </div>
        </div>
        <div className="reports-filter-group">
          <label className="reports-filter-label">Noted By</label>
          <div className="reports-signatory-inputs">
            <input
              value={savedSignatories.notedName}
              onChange={(e) => updateSavedSignatory("notedName", e.target.value)}
              placeholder="Name"
              aria-label="Noted by name"
            />
            <input
              value={savedSignatories.notedPosition}
              onChange={(e) => updateSavedSignatory("notedPosition", e.target.value)}
              placeholder="Position"
              aria-label="Noted by position"
            />
          </div>
        </div>
      </div>

      {/* ── Printable region: print header + department/results text + the
          active table(s) — everything else is hidden via visibility:hidden
          on the rest of the document in @media print, so this doesn't rely
          on hiding every other element by name. ── */}
      <div className="reports-printable">
        {/* All Reports' first page: the department summary on its own. */}
        {tab === "ALL" && (
        <PrintFrame
          title={ALL_REPORTS_SUMMARY_TITLE}
          rangeLabel={generatedRangeLabel} signatories={signatories}
        >
        {/* ── Department Attendance Summary (All Reports only) ── */}
        {tab === "ALL" && (
        <section className="table-card reports-table-card reports-summary-card">
          <div className="reports-table-label">{departmentSummaryTitle}</div>
          <table>
            <thead>
              <tr>
                <th>Department</th><th>Present</th><th>Late</th><th>Absent</th><th>On Leave</th><th>Total</th>
              </tr>
            </thead>
            <tbody>
              {departmentSummary.rows.length === 0 ? (
                <tr><td colSpan={6} className="reports-empty">No attendance records match the current filters.</td></tr>
              ) : (
                <>
                  {departmentSummary.rows.map((row) => (
                    <tr key={row.department}>
                      <td>{row.department}</td>
                      <td>{row.present}</td>
                      <td>{row.late}</td>
                      <td>{row.absent}</td>
                      <td>{row.onLeave}</td>
                      <td>{row.total}</td>
                    </tr>
                  ))}
                  <tr className="reports-summary-total">
                    <td>Grand Total</td>
                    <td>{departmentSummary.total.present}</td>
                    <td>{departmentSummary.total.late}</td>
                    <td>{departmentSummary.total.absent}</td>
                    <td>{departmentSummary.total.onLeave}</td>
                    <td>{departmentSummary.total.total}</td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
          {departmentSummary.other > 0 && (
            <p className="reports-summary-note">
              Total includes {departmentSummary.other} record{departmentSummary.other === 1 ? "" : "s"} still pending review or flagged.
            </p>
          )}
        </section>
        )}
        </PrintFrame>
        )}

        {/* DTR / Attendance records: page 2 of All Reports. */}
        {(tab === "ALL" || tab === "attendance") && (
        <PrintFrame title={partTitle("attendance")} rangeLabel={generatedRangeLabel} signatories={signatories}>

        {/* ── Tables ── */}
        {(tab === "ALL" || tab === "attendance") && (
        <section className="table-card reports-table-card">
          {tab === "ALL" && <div className="reports-table-label">DTR / Attendance</div>}
          <table>
            <thead>
              <tr>
                <th>Employee</th><th>Department</th><th>Site</th><th>Date</th>
                <th>Time In</th><th>Time Out</th><th>Lunch / Break</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredAttendance.length === 0 ? (
                <tr><td colSpan={8} className="reports-empty">No attendance records match the current filters.</td></tr>
              ) : <DepartmentGroups rows={filteredAttendance} person={personOfRow} colSpan={8} renderRow={(record) => (
                <tr key={record.id}>
                  <td>{employeeName(record)}</td>
                  <td>{record.employee.department.name}</td>
                  <td>{record.workLocation?.name ?? "—"}</td>
                  <td>{formatDate(record.attendanceDate)}</td>
                  <td>{formatTime(record.timeInAt, record.status)}</td>
                  <td>{formatTime(record.timeOutAt, record.status)}</td>
                  <td>{record.lunchOutAt ? `${record.breakKind === "BREAK" ? "Break " : ""}${formatTime(record.lunchOutAt)} – ${formatTime(record.lunchInAt)}` : "—"}</td>
                  <td><Badge tone={statusTone(record.status)}>{record.status.replace(/_/g, " ")}</Badge></td>
                </tr>
              )} />}
            </tbody>
          </table>
        </section>
      )}
        </PrintFrame>
        )}

      {(tab === "ALL" || tab === "leave") && (
        <PrintFrame title={partTitle("leave")} rangeLabel={generatedRangeLabel} signatories={signatories}>
        <section className="table-card reports-table-card">
          {tab === "ALL" && <div className="reports-table-label">Leave</div>}
          <div className="reports-status-tabs">
            {LEAVE_STATUS_FILTERS.map((status) => (
              <button
                key={status}
                className={leaveStatusFilter === status ? "active" : ""}
                onClick={() => setLeaveStatusFilter((current) => (current === status ? "ALL" : status))}
              >
                {status.charAt(0) + status.slice(1).toLowerCase()} ({leaveStatusCounts[status]})
              </button>
            ))}
          </div>
          <table>
            <thead>
              <tr>
                <th>Employee</th><th>Department</th><th>Classification</th><th>Leave Type</th>
                <th>Dates</th><th>Days</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredLeaves.length === 0 ? (
                <tr><td colSpan={7} className="reports-empty">No leave records match the current filters.</td></tr>
              ) : <DepartmentGroups rows={filteredLeaves} person={personOfRow} colSpan={7} renderRow={(request) => (
                <tr key={request.id}>
                  <td>{employeeName(request)}</td>
                  <td>{request.employee.department.name}</td>
                  <td>{formatEmploymentStatus(request.employee.employmentStatus)}</td>
                  <td>{request.leaveType.name}</td>
                  <td>{formatDate(request.startDate)} – {formatDate(request.endDate)}</td>
                  <td>{request.totalDays}</td>
                  <td><Badge tone={statusTone(request.status)}>{leaveStatusText(request)}</Badge></td>
                </tr>
              )} />}
            </tbody>
          </table>
        </section>
        </PrintFrame>
      )}

      {(tab === "ALL" || tab === "undertime") && (
        <PrintFrame title={partTitle("undertime")} rangeLabel={generatedRangeLabel} signatories={signatories}>
        <section className="table-card reports-table-card">
          {tab === "ALL" && <div className="reports-table-label">Undertime</div>}
          <div className="reports-status-tabs">
            {UNDERTIME_STATUS_FILTERS.map((status) => (
              <button
                key={status}
                className={undertimeStatusFilter === status ? "active" : ""}
                onClick={() => setUndertimeStatusFilter((current) => (current === status ? "ALL" : status))}
              >
                {status.charAt(0) + status.slice(1).toLowerCase()} ({undertimeStatusCounts[status]})
              </button>
            ))}
          </div>
          <table>
            <thead>
              <tr>
                {UNDERTIME_HEAD.map((heading) => <th key={heading}>{heading}</th>)}
              </tr>
            </thead>
            <tbody>
              {filteredUndertime.length === 0 ? (
                <tr><td colSpan={UNDERTIME_HEAD.length} className="reports-empty">No undertime filings match the current filters.</td></tr>
              ) : <DepartmentGroups rows={filteredUndertime} person={personOfRow} colSpan={UNDERTIME_HEAD.length} renderRow={(filing) => (
                <tr key={filing.id}>
                  <td>{employeeName(filing)}</td>
                  <td>{filing.employee.department.name}</td>
                  <td>{formatDate(filing.attendanceRecord.attendanceDate)}</td>
                  <td>{undertimeMinutes(filing)}</td>
                  <td>{filing.reason ?? "—"}</td>
                  <td>{formatDate(filing.filingDate)}</td>
                  <td><Badge tone={statusTone(filing.status)}>{filing.status}</Badge></td>
                  <td>{undertimeReviewer(filing)}</td>
                </tr>
              )} />}
            </tbody>
          </table>
        </section>
        </PrintFrame>
      )}

      {(tab === "ALL" || tab === "schedules") && (
        <PrintFrame title={partTitle("schedules")} rangeLabel={generatedRangeLabel} signatories={signatories}>
        <section className="table-card reports-table-card">
          {tab === "ALL" && <div className="reports-table-label">Schedules</div>}
          <table>
            <thead>
              <tr>
                <th>Employee</th><th>Department</th><th>Position</th><th>Shift</th>
                <th>Time</th><th>Effective Dates</th>
              </tr>
            </thead>
            <tbody>
              {filteredSchedules.length === 0 ? (
                <tr><td colSpan={6} className="reports-empty">No schedule records match the current filters.</td></tr>
              ) : <DepartmentGroups rows={filteredSchedules} person={personOfRow} colSpan={6} renderRow={(schedule) => (
                <tr key={schedule.id}>
                  <td>{employeeName(schedule)}</td>
                  <td>{schedule.employee.department.name}</td>
                  <td>{schedule.employee.position?.title ?? "—"}</td>
                  <td>{schedule.shift.name}</td>
                  {/* One line each, so every row lines up the same. */}
                  <td className="reports-nowrap">{schedule.shift.startTime} – {schedule.shift.endTime}</td>
                  <td className="reports-nowrap">
                    {/* Fixed-width start/end slots keep the dash and
                        "Present" in one straight column down the table. */}
                    <span className="reports-date-range">
                      <span>{formatDate(schedule.startsOn)}</span>
                      <span>–</span>
                      <span>
                        {schedule.endsOn
                          ? formatDate(schedule.endsOn)
                          : <span className="reports-ongoing">Present</span>}
                      </span>
                    </span>
                  </td>
                </tr>
              )} />}
            </tbody>
          </table>
        </section>
        </PrintFrame>
      )}

      {(tab === "ALL" || tab === "employees") && (
        <PrintFrame title={partTitle("employees")} rangeLabel={generatedRangeLabel} signatories={signatories}>
        <section className="table-card reports-table-card">
          {tab === "ALL" && <div className="reports-table-label">List of Employees</div>}
          <table>
            <thead>
              <tr>
                <th>Name</th><th>Department</th><th>Sex</th><th>Hired Date</th>
              </tr>
            </thead>
            <tbody>
              {filteredEmployeesList.length === 0 ? (
                <tr><td colSpan={4} className="reports-empty">No employees match the current filters.</td></tr>
              ) : <DepartmentGroups rows={filteredEmployeesList} person={personSelf} colSpan={4} renderRow={(e) => (
                <tr key={e.id}>
                  <td>{e.firstName} {e.lastName}</td>
                  <td>{e.department.name}</td>
                  <td>{formatSex(e.sex)}</td>
                  <td>{formatDate(e.hireDate)}</td>
                </tr>
              )} />}
            </tbody>
          </table>
        </section>
        </PrintFrame>
      )}

      {(tab === "ALL" || tab === "leaveBalances") && (
        <PrintFrame title={partTitle("leaveBalances")} rangeLabel={generatedRangeLabel} signatories={signatories}>
        <section className="table-card reports-table-card">
          {tab === "ALL" && <div className="reports-table-label">Remaining Leave</div>}
          <table>
            <thead>
              <tr>
                <th>Name</th><th>Department</th><th>Sex</th><th>Leave Type</th>
                <th>Remaining</th><th>Used</th><th>Dates Used</th>
              </tr>
            </thead>
            <tbody>
              {filteredLeaveBalances.length === 0 ? (
                <tr><td colSpan={7} className="reports-empty">No leave balance records match the current filters.</td></tr>
              ) : <DepartmentGroups rows={filteredLeaveBalances} person={personOfRow} colSpan={7} renderRow={(b) => (
                <tr key={`${b.employeeId}-${b.leaveTypeId}`}>
                  <td>{b.employee.firstName} {b.employee.lastName}</td>
                  <td>{b.employee.department.name}</td>
                  <td>{formatSex(b.employee.sex)}</td>
                  <td>{b.leaveTypeName}</td>
                  <td>{formatDays(b.remainingDays)}</td>
                  <td>{formatDays(b.usedDays)}</td>
                  <td className="reports-dates-used">
                    {b.usedDates.length === 0 ? "—" : (
                      <span className="reports-dates-grid">
                        {usedDateRanges(b.usedDates).map((range, index) => <span key={index}>{range}</span>)}
                      </span>
                    )}
                  </td>
                </tr>
              )} />}
            </tbody>
          </table>
        </section>
        </PrintFrame>
      )}

      {(tab === "ALL" || tab === "vlMonetization") && (
        <PrintFrame title={partTitle("vlMonetization")} rangeLabel={generatedRangeLabel} signatories={signatories}>
        <section className="table-card reports-table-card">
          {tab === "ALL" && <div className="reports-table-label">VL Monetization</div>}
          <table>
            <thead>
              <tr>
                {VL_MONETIZATION_HEAD.map((heading) => <th key={heading}>{heading}</th>)}
              </tr>
            </thead>
            <tbody>
              {filteredVlMonetizations.length === 0 ? (
                <tr><td colSpan={VL_MONETIZATION_HEAD.length} className="reports-empty">No VL has been monetized for this leave year.</td></tr>
              ) : <DepartmentGroups rows={filteredVlMonetizations} person={personOfRow} colSpan={VL_MONETIZATION_HEAD.length} renderRow={(m) => (
                <tr key={m.id}>
                  {vlMonetizationCells(m).map((cell, index) => <td key={index}>{cell}</td>)}
                </tr>
              )} />}
            </tbody>
          </table>
        </section>
        </PrintFrame>
      )}
      </div>
    </>
  );
}
