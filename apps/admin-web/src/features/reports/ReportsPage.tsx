import { useEffect, useMemo, useState } from "react";
import { Download, FileText, Printer } from "lucide-react";
import { jsPDF } from "jspdf";
import { autoTable } from "jspdf-autotable";
import { StatCard } from "../../components/ui/StatCard";
import { Badge } from "../../components/ui/Badge";
import { DropdownFilter } from "../../components/ui/DropdownFilter";
import { EmployeeSearchSelect, matchesEmployeeQuery } from "../../components/ui/EmployeeSearchSelect";
import { apiRequest } from "../../lib/api";
import { useActiveDepartments } from "../../lib/departments";
import { formatEmploymentStatus } from "../../types/employment";
import logo from "../../assets/unileaf-logo.png";
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
};

type ReportTab = "ALL" | "attendance" | "leave" | "undertime" | "schedules" | "employees" | "leaveBalances";
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
};

// "All Reports" bundles these four tabs — spelled out in the print/PDF
// header since "All Reports" alone doesn't say what's included.
const ALL_REPORTS_INCLUDES = ["DTR", "Attendance", REPORT_TYPE_LABELS.leave, REPORT_TYPE_LABELS.undertime, REPORT_TYPE_LABELS.schedules].join(" | ");

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
  URL.revokeObjectURL(url);
}

async function saveBlob(blob: Blob, filename: string, description: string, mimeType: string, extension: string) {
  const showSaveFilePicker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;

  if (!showSaveFilePicker) {
    downloadBlob(blob, filename);
    return true;
  }

  try {
    const handle = await showSaveFilePicker({
      suggestedName: filename,
      types: [{ description, accept: { [mimeType]: [extension] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return false;
    downloadBlob(blob, filename);
    return true;
  }
}

function formatSex(sex?: string | null) {
  if (sex === "MALE") return "Male";
  if (sex === "FEMALE") return "Female";
  return "—";
}

function formatUsedDates(dates: { startDate: string; endDate: string }[]) {
  if (dates.length === 0) return "—";
  return dates
    .map((d) => {
      const start = formatDate(d.startDate);
      const end = formatDate(d.endDate);
      return start === end ? start : `${start} – ${end}`;
    })
    .join(", ");
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

export function ReportsPage({
  user,
}: {
  user?: { roles?: string[]; departmentId?: string; department?: string };
} = {}) {
 
  const roles = user?.roles ?? [];
  const isDepartmentLocked = roles.includes("SUPERVISOR") && !roles.includes("ADMIN");

  const [data, setData] = useState<ReportData | null>(null);
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
    apiRequest<ReportData>(`/reports${query ? `?${query}` : ""}`).then(setData).catch(() => undefined);
  };

  useEffect(loadReport, [filters.from, filters.to, filters.department]);

  const { departmentNames: departments } = useActiveDepartments();

  // --- Client-side filtering for all report types ---
  const filteredAttendance = useMemo(() => {
    if (!data) return [];
    return data.attendance.filter((record) => {
      const deptMatch = filters.department === "ALL" || record.employee.department.name === filters.department;
      const dateMatch = isInDateRange(record.attendanceDate, filters.from, filters.to);
      const statusMatch = attendanceStatusFilter === "ALL" || record.status === attendanceStatusFilter;
      return deptMatch && dateMatch && statusMatch && matchesEmployeeQuery(record.employee, search);
    });
  }, [data, filters, search, attendanceStatusFilter]);

  const leavesInRange = useMemo(() => {
    if (!data) return [];
    return data.leaves.filter((request) => {
      const deptMatch = filters.department === "ALL" || request.employee.department.name === filters.department;
      // Show leave if it overlaps the date range at all
      const startInRange = isInDateRange(request.startDate, filters.from, filters.to);
      const endInRange = isInDateRange(request.endDate, filters.from, filters.to);
      const spanRange =
        new Date(request.startDate).getTime() <= parseLocalDateFilter(filters.to, true) &&
        new Date(request.endDate).getTime() >= parseLocalDateFilter(filters.from);
      return deptMatch && (startInRange || endInRange || spanRange) && matchesEmployeeQuery(request.employee, search);
    });
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
    return (data.undertime ?? []).filter((filing) => {
      const deptMatch = filters.department === "ALL" || filing.employee.department.name === filters.department;
      return (
        deptMatch &&
        isInDateRange(filing.attendanceRecord.attendanceDate, filters.from, filters.to) &&
        matchesEmployeeQuery(filing.employee, search)
      );
    });
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
    return data.schedules.filter((schedule) => {
      const deptMatch = filters.department === "ALL" || schedule.employee.department.name === filters.department;
      const startInRange = isInDateRange(schedule.startsOn, filters.from, filters.to);
      const endsOnOrOngoing = !schedule.endsOn || isInDateRange(schedule.endsOn, filters.from, filters.to);
      const active =
        new Date(schedule.startsOn).getTime() <= parseLocalDateFilter(filters.to, true) &&
        (!schedule.endsOn || new Date(schedule.endsOn).getTime() >= parseLocalDateFilter(filters.from));
      return deptMatch && (startInRange || endsOnOrOngoing || active) && matchesEmployeeQuery(schedule.employee, search);
    });
  }, [data, filters, search]);

  // Employee directory / leave balances are point-in-time snapshots, not
  // bounded by the from/to range — only the department filter applies.
  const filteredEmployeesList = useMemo(() => {
    if (!data) return [];
    return data.employees.filter(
      (e) => (filters.department === "ALL" || e.department.name === filters.department) && matchesEmployeeQuery(e, search),
    );
  }, [data, filters.department, search]);

  const filteredLeaveBalances = useMemo(() => {
    if (!data) return [];
    return data.leaveBalances.filter(
      (b) =>
        (filters.department === "ALL" || b.employee.department.name === filters.department) &&
        matchesEmployeeQuery(b.employee, search),
    );
  }, [data, filters.department, search]);

  // Filtered totals for stat cards
  const filteredTotals = useMemo(() => ({
    attendanceRecords: filteredAttendance.length,
    approvedLeaves: filteredLeaves.filter((l) => l.status === "APPROVED").length,
    pendingLeaves: filteredLeaves.filter((l) => l.status === "PENDING").length,
    activeSchedules: filteredSchedules.filter((s) => !s.endsOn).length,
  }), [filteredAttendance, filteredLeaves, filteredSchedules]);

  if (!data) {
    return <section className="table-card reports-loading"><span className="reports-loading-dot" />Loading reports…</section>;
  }

  const generatedRangeLabel = `Generated: ${filters.from ? formatDate(filters.from) : "—"} to ${filters.to ? formatDate(filters.to) : "—"}`;

  const exportCsv = async () => {
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
        b.leaveTypeName, b.remainingDays.toFixed(0), b.usedDays.toFixed(0), formatUsedDates(b.usedDates),
      ]),
    ];
    const rows =
      tab === "attendance" ? aRows
      : tab === "leave" ? lRows
      : tab === "undertime" ? uRows
      : tab === "schedules" ? sRows
      : tab === "employees" ? eRows
      : tab === "leaveBalances" ? rbRows
      : [["ATTENDANCE"], ...aRows, [], ["LEAVE"], ...lRows, [], ["UNDERTIME"], ...uRows, [], [REPORT_TYPE_LABELS.schedules.toUpperCase()], ...sRows];
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    // Leading BOM tells Excel the file is UTF-8 — without it Excel reads it
    // as ANSI and "—" shows up as "â€”".
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const saved = await saveBlob(blob, `${tab === "ALL" ? "all" : tab}-report.csv`, "CSV file", "text/csv", ".csv");
    if (saved) loadReport();
  };

  const exportPdf = async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" }) as any;
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 40;

    // Header matches the on-screen print header: centered logo, the report
    // type as a title below it, then the generated date range as plain text.
    let startY = 32;
    try {
      const { dataUrl, width, height } = await loadImageDataUrl(logo);
      const maxSize = 140;
      const scale = Math.min(maxSize / width, maxSize / height);
      const drawWidth = width * scale;
      const drawHeight = height * scale;
      doc.addImage(dataUrl, "PNG", pageWidth / 2 - drawWidth / 2, startY, drawWidth, drawHeight);
      startY += drawHeight + 16;
    } catch {
      // Logo failed to load — still produce the report without it.
    }

    doc.setFontSize(16);
    doc.setTextColor(26, 58, 92);
    doc.text(REPORT_TYPE_LABELS[tab], pageWidth / 2, startY, { align: "center" });
    startY += 20;

    if (tab === "ALL") {
      doc.setFontSize(8);
      doc.setTextColor(107, 130, 153);
      doc.text(`Includes: ${ALL_REPORTS_INCLUDES}`, pageWidth / 2, startY, { align: "center" });
      startY += 14;
    }

    doc.setFontSize(9);
    doc.setTextColor(45, 74, 101);
    doc.text(generatedRangeLabel, pageWidth / 2, startY, { align: "center" });
    startY += 10;
    doc.setDrawColor(215, 226, 236);
    doc.line(margin, startY, pageWidth - margin, startY);
    startY += 18;

    const addSection = (title: string, head: string[], body: (string | number)[][]) => {
      if (body.length === 0) return;
      doc.setFontSize(10);
      doc.setTextColor(26, 58, 92);
      doc.text(title, 40, startY);
      autoTable(doc, {
        startY: startY + 8,
        head: [head],
        body,
        theme: "striped" as const,
        headStyles: { fillColor: [26, 58, 92] as [number, number, number], textColor: [255, 255, 255] as [number, number, number], fontSize: 8, fontStyle: "bold" as const },
        bodyStyles: { fontSize: 8, textColor: [30, 41, 59] as [number, number, number] },
        alternateRowStyles: { fillColor: [244, 247, 251] as [number, number, number] },
        margin: { left: 40, right: 40 },
      });
      startY = doc.lastAutoTable.finalY + 24;
    };

    if (tab === "ALL" || tab === "attendance") {
      addSection("DTR / Attendance",
        ["Employee", "Department", "Site", "Date", "Time In", "Time Out", "Lunch / Break", "Status"],
        filteredAttendance.map((r) => [
          employeeName(r), r.employee.department.name, r.workLocation?.name ?? "—", formatDate(r.attendanceDate),
          formatTime(r.timeInAt, r.status), formatTime(r.timeOutAt, r.status),
          r.lunchOutAt ? `${r.breakKind === "BREAK" ? "Break " : ""}${formatTime(r.lunchOutAt)} - ${formatTime(r.lunchInAt)}` : "—", r.status,
        ])
      );
    }
    if (tab === "ALL" || tab === "leave") {
      addSection("Leave",
        ["Employee", "Department", "Classification", "Leave Type", "Start Date", "End Date", "Days", "Status"],
        filteredLeaves.map((r) => [
          employeeName(r), r.employee.department.name, formatEmploymentStatus(r.employee.employmentStatus), r.leaveType.name,
          formatDate(r.startDate), formatDate(r.endDate), r.totalDays, leaveStatusText(r),
        ])
      );
    }
    if (tab === "ALL" || tab === "undertime") {
      addSection("Undertime", UNDERTIME_HEAD, filteredUndertime.map(undertimeCells));
    }
    if (tab === "ALL" || tab === "schedules") {
      addSection("Schedules",
        ["Employee", "Department", "Position", "Shift", "Time", "Effective Dates"],
        filteredSchedules.map((s) => [
          employeeName(s), s.employee.department.name, s.employee.position?.title ?? "—", s.shift.name,
          `${s.shift.startTime} - ${s.shift.endTime}`, `${formatDate(s.startsOn)} - ${s.endsOn ? formatDate(s.endsOn) : "Present"}`,
        ])
      );
    }
    if (tab === "employees") {
      addSection("List of Employees",
        ["Name", "Department", "Sex", "Hired Date"],
        filteredEmployeesList.map((e) => [`${e.firstName} ${e.lastName}`, e.department.name, formatSex(e.sex), formatDate(e.hireDate)])
      );
    }
    if (tab === "leaveBalances") {
      addSection("Remaining Leave",
        ["Name", "Department", "Sex", "Leave Type", "Remaining", "Used", "Dates Used"],
        filteredLeaveBalances.map((b) => [
          `${b.employee.firstName} ${b.employee.lastName}`, b.employee.department.name, formatSex(b.employee.sex),
          b.leaveTypeName, b.remainingDays.toFixed(0), b.usedDays.toFixed(0), formatUsedDates(b.usedDates),
        ])
      );
    }

    const blob = doc.output("blob") as Blob;
    const saved = await saveBlob(blob, `${tab === "ALL" ? "all" : tab}-report.pdf`, "PDF file", "application/pdf", ".pdf");
    if (saved) loadReport();
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
          <button className="report-export-button" onClick={exportCsv}>
            <Download size={14} />
            <span>Export CSV</span>
          </button>
          <button className="report-export-button" onClick={exportPdf}>
            <FileText size={14} />
            <span>Export PDF</span>
          </button>
          <button className="report-export-button" onClick={() => { window.print(); loadReport(); }}>
            <Printer size={14} />
            <span>Print</span>
          </button>
          </div>
        </div>
      </div>

      {/* ── Printable region: print header + department/results text + the
          active table(s) — everything else is hidden via visibility:hidden
          on the rest of the document in @media print, so this doesn't rely
          on hiding every other element by name. ── */}
      <div className="reports-printable">
        <div className="reports-print-header">
          <img src={logo} alt="Universal Leaf Philippines, Inc." className="reports-print-logo" />
          <div className="reports-print-heading">
            <h1 className="reports-print-title">{REPORT_TYPE_LABELS[tab]}</h1>
            {tab === "ALL" && <p className="reports-print-subtitle">Includes: {ALL_REPORTS_INCLUDES}</p>}
          </div>
        </div>
        <div className="reports-print-meta">
          <span>{generatedRangeLabel}</span>
        </div>

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
              ) : filteredAttendance.map((record) => (
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
              ))}
            </tbody>
          </table>
        </section>
      )}

      {(tab === "ALL" || tab === "leave") && (
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
              ) : filteredLeaves.map((request) => (
                <tr key={request.id}>
                  <td>{employeeName(request)}</td>
                  <td>{request.employee.department.name}</td>
                  <td>{formatEmploymentStatus(request.employee.employmentStatus)}</td>
                  <td>{request.leaveType.name}</td>
                  <td>{formatDate(request.startDate)} – {formatDate(request.endDate)}</td>
                  <td>{request.totalDays}</td>
                  <td><Badge tone={statusTone(request.status)}>{leaveStatusText(request)}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {(tab === "ALL" || tab === "undertime") && (
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
              ) : filteredUndertime.map((filing) => (
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
              ))}
            </tbody>
          </table>
        </section>
      )}

      {(tab === "ALL" || tab === "schedules") && (
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
              ) : filteredSchedules.map((schedule) => (
                <tr key={schedule.id}>
                  <td>{employeeName(schedule)}</td>
                  <td>{schedule.employee.department.name}</td>
                  <td>{schedule.employee.position?.title ?? "—"}</td>
                  <td>{schedule.shift.name}</td>
                  <td>{schedule.shift.startTime} – {schedule.shift.endTime}</td>
                  <td>
                    {formatDate(schedule.startsOn)} –{" "}
                    {schedule.endsOn
                      ? formatDate(schedule.endsOn)
                      : <span className="reports-ongoing">Present</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {tab === "employees" && (
        <section className="table-card reports-table-card">
          <table>
            <thead>
              <tr>
                <th>Name</th><th>Department</th><th>Sex</th><th>Hired Date</th>
              </tr>
            </thead>
            <tbody>
              {filteredEmployeesList.length === 0 ? (
                <tr><td colSpan={4} className="reports-empty">No employees match the current filters.</td></tr>
              ) : filteredEmployeesList.map((e) => (
                <tr key={e.id}>
                  <td>{e.firstName} {e.lastName}</td>
                  <td>{e.department.name}</td>
                  <td>{formatSex(e.sex)}</td>
                  <td>{formatDate(e.hireDate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {tab === "leaveBalances" && (
        <section className="table-card reports-table-card">
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
              ) : filteredLeaveBalances.map((b) => (
                <tr key={`${b.employeeId}-${b.leaveTypeId}`}>
                  <td>{b.employee.firstName} {b.employee.lastName}</td>
                  <td>{b.employee.department.name}</td>
                  <td>{formatSex(b.employee.sex)}</td>
                  <td>{b.leaveTypeName}</td>
                  <td>{b.remainingDays.toFixed(0)}</td>
                  <td>{b.usedDays.toFixed(0)}</td>
                  <td>{formatUsedDates(b.usedDates)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      </div>
    </>
  );
}
