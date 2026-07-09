import { useEffect, useMemo, useState } from "react";
import { Download, FileText, Printer } from "lucide-react";
import { jsPDF } from "jspdf";
import { autoTable } from "jspdf-autotable";
import { StatCard } from "../../components/ui/StatCard";
import { Badge } from "../../components/ui/Badge";
import { DropdownFilter } from "../../components/ui/DropdownFilter";
import { apiRequest } from "../../lib/api";
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
    workLocation?: { name: string } | null;
    employee: { firstName: string; lastName: string; department: { name: string } };
  }[];
  leaves: {
    id: string;
    startDate: string;
    endDate: string;
    totalDays: string;
    status: string;
    employee: { firstName: string; lastName: string; employmentStatus?: string; department: { name: string } };
    leaveType: { name: string };
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

type ReportTab = "ALL" | "attendance" | "leave" | "schedules" | "employees" | "leaveBalances";

type EmployeeOption = {
  department: { name: string };
};

function employeeName(row: { employee: { firstName: string; lastName: string } }) {
  return `${row.employee.firstName} ${row.employee.lastName}`;
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString();
}

function formatTime(value?: string | null) {
  return value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Pending";
}

const EMPLOYMENT_STATUS_LABELS: Record<string, string> = {
  REGULAR: "Regular Employee",
  CONTRACTUAL_SEASONAL: "Contractual Employee (Seasonal)",
  PIECE_RATE: "Piece-rate (Pakyawan) Worker",
  SEPARATED: "Separated",
};

function formatEmploymentStatus(status?: string) {
  if (!status) return "Unspecified";
  return EMPLOYMENT_STATUS_LABELS[status] ?? status;
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

function statusTone(status: string) {
  if (status === "PRESENT" || status === "APPROVED" || status === "SUPERVISOR_APPROVED") return "success";
  if (status === "ABSENT" || status === "REJECTED" || status === "NEEDS_REVISION") return "danger";
  return "warning";
}

function isInDateRange(dateStr: string, from: string, to: string) {
  if (!from && !to) return true;
  const date = new Date(dateStr).getTime();
  const fromTime = from ? new Date(from).getTime() : -Infinity;
  const toTime = to ? new Date(to + "T23:59:59").getTime() : Infinity;
  return date >= fromTime && date <= toTime;
}

export function ReportsPage({
  user,
}: {
  user?: { roles?: string[]; departmentId?: string; department?: string };
} = {}) {
 
  const roles = user?.roles ?? [];
  const isDepartmentLocked = roles.includes("SUPERVISOR") && !roles.includes("ADMIN");
  const lockedDepartmentName = isDepartmentLocked ? user?.department : undefined;

  const [data, setData] = useState<ReportData | null>(null);
  const [tab, setTab] = useState<ReportTab>("ALL");
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [filters, setFilters] = useState({
    from: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10),
    to: new Date().toISOString().slice(0, 10),
    department: "ALL",
  });
  const [leaveStatusFilter, setLeaveStatusFilter] = useState<"ALL" | "PENDING" | "APPROVED" | "REJECTED">("ALL");

  const loadReport = () => {
    const params = new URLSearchParams();
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    if (filters.department !== "ALL") params.set("department", filters.department);
    const query = params.toString();
    apiRequest<ReportData>(`/reports${query ? `?${query}` : ""}`).then(setData).catch(() => undefined);
  };

  useEffect(loadReport, [filters.from, filters.to, filters.department]);

  useEffect(() => {
    apiRequest<EmployeeOption[]>("/employees").then(setEmployees).catch(() => undefined);
  }, []);

  const departments = useMemo(
    () => Array.from(new Set(employees.map((e) => e.department.name))).sort(),
    [employees]
  );

  // --- Client-side filtering for all report types ---
  const filteredAttendance = useMemo(() => {
    if (!data) return [];
    return data.attendance.filter((record) => {
      const deptMatch = filters.department === "ALL" || record.employee.department.name === filters.department;
      const dateMatch = isInDateRange(record.attendanceDate, filters.from, filters.to);
      return deptMatch && dateMatch;
    });
  }, [data, filters]);

  const leavesInRange = useMemo(() => {
    if (!data) return [];
    return data.leaves.filter((request) => {
      const deptMatch = filters.department === "ALL" || request.employee.department.name === filters.department;
      // Show leave if it overlaps the date range at all
      const startInRange = isInDateRange(request.startDate, filters.from, filters.to);
      const endInRange = isInDateRange(request.endDate, filters.from, filters.to);
      const spanRange =
        new Date(request.startDate).getTime() <= new Date(filters.to + "T23:59:59").getTime() &&
        new Date(request.endDate).getTime() >= new Date(filters.from).getTime();
      return deptMatch && (startInRange || endInRange || spanRange);
    });
  }, [data, filters]);

  const leaveStatusCounts = useMemo(() => {
    const counts = { PENDING: 0, APPROVED: 0, REJECTED: 0 };
    for (const r of leavesInRange) {
      if (r.status === "PENDING") counts.PENDING += 1;
      else if (r.status === "APPROVED" || r.status === "SUPERVISOR_APPROVED") counts.APPROVED += 1;
      else if (r.status === "REJECTED" || r.status === "NEEDS_REVISION") counts.REJECTED += 1;
    }
    return counts;
  }, [leavesInRange]);

  const filteredLeaves = useMemo(() => {
    if (leaveStatusFilter === "ALL") return leavesInRange;
    return leavesInRange.filter((request) => {
      if (leaveStatusFilter === "APPROVED") return request.status === "APPROVED" || request.status === "SUPERVISOR_APPROVED";
      if (leaveStatusFilter === "REJECTED") return request.status === "REJECTED" || request.status === "NEEDS_REVISION";
      return request.status === leaveStatusFilter;
    });
  }, [leavesInRange, leaveStatusFilter]);

  const filteredSchedules = useMemo(() => {
    if (!data) return [];
    return data.schedules.filter((schedule) => {
      const deptMatch = filters.department === "ALL" || schedule.employee.department.name === filters.department;
      const startInRange = isInDateRange(schedule.startsOn, filters.from, filters.to);
      const endsOnOrOngoing = !schedule.endsOn || isInDateRange(schedule.endsOn, filters.from, filters.to);
      const active =
        new Date(schedule.startsOn).getTime() <= new Date(filters.to + "T23:59:59").getTime() &&
        (!schedule.endsOn || new Date(schedule.endsOn).getTime() >= new Date(filters.from).getTime());
      return deptMatch && (startInRange || endsOnOrOngoing || active);
    });
  }, [data, filters]);

  // Employee directory / leave balances are point-in-time snapshots, not
  // bounded by the from/to range — only the department filter applies.
  const filteredEmployeesList = useMemo(() => {
    if (!data) return [];
    return data.employees.filter((e) => filters.department === "ALL" || e.department.name === filters.department);
  }, [data, filters.department]);

  const filteredLeaveBalances = useMemo(() => {
    if (!data) return [];
    return data.leaveBalances.filter((b) => filters.department === "ALL" || b.employee.department.name === filters.department);
  }, [data, filters.department]);

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

  const tabCount =
    tab === "attendance" ? filteredAttendance.length
    : tab === "leave" ? filteredLeaves.length
    : tab === "schedules" ? filteredSchedules.length
    : tab === "employees" ? filteredEmployeesList.length
    : tab === "leaveBalances" ? filteredLeaveBalances.length
    : filteredAttendance.length + filteredLeaves.length + filteredSchedules.length;

  const departmentLabel = isDepartmentLocked
    ? lockedDepartmentName
    : filters.department === "ALL" ? "All Departments" : filters.department;

  const exportCsv = () => {
    const aRows = [
      ["Employee", "Department", "Site", "Date", "Time In", "Time Out", "Lunch Break", "Status"],
      ...filteredAttendance.map((r) => [
        employeeName(r), r.employee.department.name, r.workLocation?.name ?? "—", formatDate(r.attendanceDate),
        formatTime(r.timeInAt), formatTime(r.timeOutAt),
        r.lunchOutAt ? `${formatTime(r.lunchOutAt)} - ${formatTime(r.lunchInAt)}` : "—", r.status,
      ]),
    ];
    const lRows = [
      ["Employee", "Department", "Classification", "Leave Type", "Dates", "Days", "Status"],
      ...filteredLeaves.map((r) => [
        employeeName(r), r.employee.department.name, formatEmploymentStatus(r.employee.employmentStatus), r.leaveType.name,
        `${formatDate(r.startDate)} - ${formatDate(r.endDate)}`, r.totalDays, r.status,
      ]),
    ];
    const sRows = [
      ["Employee", "Department", "Position", "Shift", "Time", "Effective Dates"],
      ...filteredSchedules.map((s) => [
        employeeName(s), s.employee.department.name, s.employee.position?.title ?? "—", s.shift.name,
        `${s.shift.startTime} - ${s.shift.endTime}`, `${formatDate(s.startsOn)} - ${s.endsOn ? formatDate(s.endsOn) : "Ongoing"}`,
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
      : tab === "schedules" ? sRows
      : tab === "employees" ? eRows
      : tab === "leaveBalances" ? rbRows
      : [...aRows, [], ...lRows, [], ...sRows];
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${tab === "ALL" ? "all" : tab}-report.csv`;
    link.click();
    URL.revokeObjectURL(url);
    loadReport();
  };

  const exportPdf = async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" }) as any;
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 40;

    // Header matches the on-screen print header: centered logo with the
    // company name as a title below it, then department + result count as
    // plain text.
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
    doc.text("Universal Leaf Philippines, Inc.", pageWidth / 2, startY, { align: "center" });
    startY += 24;

    doc.setFontSize(9);
    doc.setTextColor(45, 74, 101);
    doc.text(`Department: ${departmentLabel}`, margin, startY);
    doc.text(`${tabCount} result${tabCount !== 1 ? "s" : ""}`, pageWidth - margin, startY, { align: "right" });
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
        ["Employee", "Department", "Site", "Date", "Time In", "Time Out", "Lunch Break", "Status"],
        filteredAttendance.map((r) => [
          employeeName(r), r.employee.department.name, r.workLocation?.name ?? "—", formatDate(r.attendanceDate),
          formatTime(r.timeInAt), formatTime(r.timeOutAt),
          r.lunchOutAt ? `${formatTime(r.lunchOutAt)} - ${formatTime(r.lunchInAt)}` : "—", r.status,
        ])
      );
    }
    if (tab === "ALL" || tab === "leave") {
      addSection("Leave",
        ["Employee", "Department", "Classification", "Leave Type", "Start Date", "End Date", "Days", "Status"],
        filteredLeaves.map((r) => [
          employeeName(r), r.employee.department.name, formatEmploymentStatus(r.employee.employmentStatus), r.leaveType.name,
          formatDate(r.startDate), formatDate(r.endDate), r.totalDays, r.status,
        ])
      );
    }
    if (tab === "ALL" || tab === "schedules") {
      addSection("Schedules",
        ["Employee", "Department", "Position", "Shift", "Time", "Effective Dates"],
        filteredSchedules.map((s) => [
          employeeName(s), s.employee.department.name, s.employee.position?.title ?? "—", s.shift.name,
          `${s.shift.startTime} - ${s.shift.endTime}`, `${formatDate(s.startsOn)} - ${s.endsOn ? formatDate(s.endsOn) : "Ongoing"}`,
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

    doc.save(`${tab === "ALL" ? "all" : tab}-report.pdf`);
    loadReport();
  };

  return (
    <>


      {/* ── Toolbar (screen only) ── */}
      <div className="reports-toolbar">
        <div className="reports-toolbar-left">
          <h2 className="reports-title">Reports</h2>
        </div>
        <div className="reports-result-count">
          <span>{tabCount} result{tabCount !== 1 ? "s" : ""}</span>
        </div>
      </div>

      {/* ── Filter Bar ── */}
      <div className="reports-filter-bar">
        <div className="reports-filter-group">
          <label className="reports-filter-label">Department</label>
          {isDepartmentLocked ? (
            <span className="cal-hint">{lockedDepartmentName}</span>
          ) : (
            <DropdownFilter
              className="reports-select"
              value={filters.department}
              onChange={(value) => setFilters((c) => ({ ...c, department: value }))}
              options={departments.map((d) => ({ value: d, label: d }))}
              allLabel="All Departments"
              menuLabel="Filter by department"
              ariaLabel="Report department"
            />
          )}
        </div>

        <div className="reports-filter-group">
          <label className="reports-filter-label">Report Type</label>
          <DropdownFilter
            className="reports-select"
            value={tab}
            onChange={(value) => setTab(value as ReportTab)}
            options={[
              { value: "attendance", label: "DTR / Attendance" },
              { value: "leave", label: "Leave" },
              { value: "schedules", label: "Schedules" },
              { value: "employees", label: "List of Employees" },
              { value: "leaveBalances", label: "Remaining Leave" },
            ]}
            allLabel="All Report Types"
            menuLabel="Filter by report type"
            ariaLabel="Report type"
          />
        </div>

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

        <div className="reports-filter-actions">
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

      {/* ── Printable region: print header + department/results text + the
          active table(s) — everything else is hidden via visibility:hidden
          on the rest of the document in @media print, so this doesn't rely
          on hiding every other element by name. ── */}
      <div className="reports-printable">
        <div className="reports-print-header">
          <img src={logo} alt="Universal Leaf Philippines, Inc." className="reports-print-logo" />
          <h1 className="reports-print-title">Universal Leaf Philippines, Inc.</h1>
        </div>
        <div className="reports-print-meta">
          <span>Department: {departmentLabel}</span>
          <span>{tabCount} result{tabCount !== 1 ? "s" : ""}</span>
        </div>

        {/* ── Tables ── */}
        {(tab === "ALL" || tab === "attendance") && (
        <section className="table-card reports-table-card">
          {tab === "ALL" && <div className="reports-table-label">DTR / Attendance</div>}
          <table>
            <thead>
              <tr>
                <th>Employee</th><th>Department</th><th>Site</th><th>Date</th>
                <th>Time In</th><th>Time Out</th><th>Lunch Break</th><th>Status</th>
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
                  <td>{formatTime(record.timeInAt)}</td>
                  <td>{formatTime(record.timeOutAt)}</td>
                  <td>{record.lunchOutAt ? `${formatTime(record.lunchOutAt)} – ${formatTime(record.lunchInAt)}` : "—"}</td>
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
            {(["PENDING", "APPROVED", "REJECTED"] as const).map((status) => (
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
                  <td><Badge tone={statusTone(request.status)}>{request.status.replace(/_/g, " ")}</Badge></td>
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
                      : <span className="reports-ongoing">Ongoing</span>}
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