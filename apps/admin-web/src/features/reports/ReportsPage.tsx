import { useEffect, useMemo, useState } from "react";
import { BarChart3, CalendarClock, CheckCircle2, Clock, Download, FileText } from "lucide-react";
import { jsPDF } from "jspdf";
import { autoTable } from "jspdf-autotable";
import { StatCard } from "../../components/ui/StatCard";
import { Badge } from "../../components/ui/Badge";
import { DropdownFilter } from "../../components/ui/DropdownFilter";
import { apiRequest } from "../../lib/api";
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
    employee: { firstName: string; lastName: string; department: { name: string } };
  }[];
  leaves: {
    id: string;
    startDate: string;
    endDate: string;
    totalDays: string;
    status: string;
    employee: { firstName: string; lastName: string; department: { name: string } };
    leaveType: { name: string };
  }[];
  schedules: {
    id: string;
    startsOn: string;
    endsOn?: string | null;
    employee: { firstName: string; lastName: string; department: { name: string } };
    shift: { name: string; startTime: string; endTime: string };
  }[];
};

type ReportTab = "ALL" | "attendance" | "leave" | "schedules";

type EmployeeOption = {
  department: { name: string };
};

function employeeName(row: { employee: { firstName: string; lastName: string } }) {
  return `${row.employee.firstName} ${row.employee.lastName}`;
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString();
}

function statusTone(status: string) {
  if (status === "PRESENT" || status === "APPROVED") return "success";
  if (status === "ABSENT" || status === "REJECTED") return "danger";
  return "warning";
}

function isInDateRange(dateStr: string, from: string, to: string) {
  if (!from && !to) return true;
  const date = new Date(dateStr).getTime();
  const fromTime = from ? new Date(from).getTime() : -Infinity;
  const toTime = to ? new Date(to + "T23:59:59").getTime() : Infinity;
  return date >= fromTime && date <= toTime;
}

export function ReportsPage() {
  const [data, setData] = useState<ReportData | null>(null);
  const [tab, setTab] = useState<ReportTab>("ALL");
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [filters, setFilters] = useState({
    from: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10),
    to: new Date().toISOString().slice(0, 10),
    department: "ALL",
  });

  const loadReport = () => {
    const params = new URLSearchParams();
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    if (filters.department !== "ALL") params.set("department", filters.department);
    const query = params.toString();
    apiRequest<ReportData>(`/reports${query ? `?${query}` : ""}`).then(setData).catch(() => undefined);
  };

  useEffect(loadReport, []);

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

  const filteredLeaves = useMemo(() => {
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

  const exportCsv = () => {
    const aRows = [
      ["Employee", "Department", "Date", "Status", "Total Hours", "Late Minutes"],
      ...filteredAttendance.map((r) => [employeeName(r), r.employee.department.name, formatDate(r.attendanceDate), r.status, (r.totalMinutes / 60).toFixed(2), String(r.lateMinutes)]),
    ];
    const lRows = [
      ["Employee", "Department", "Leave Type", "Dates", "Days", "Status"],
      ...filteredLeaves.map((r) => [employeeName(r), r.employee.department.name, r.leaveType.name, `${formatDate(r.startDate)} - ${formatDate(r.endDate)}`, r.totalDays, r.status]),
    ];
    const sRows = [
      ["Employee", "Department", "Shift", "Time", "Starts On", "Ends On"],
      ...filteredSchedules.map((s) => [employeeName(s), s.employee.department.name, s.shift.name, `${s.shift.startTime} - ${s.shift.endTime}`, formatDate(s.startsOn), s.endsOn ? formatDate(s.endsOn) : "Ongoing"]),
    ];
    const rows = tab === "attendance" ? aRows : tab === "leave" ? lRows : tab === "schedules" ? sRows : [...aRows, [], ...lRows, [], ...sRows];
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${tab === "ALL" ? "all" : tab}-report.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const exportPdf = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" }) as any;
    const pageWidth = doc.internal.pageSize.getWidth();
    const rangeLabel = `${filters.from || "—"} to ${filters.to || "—"}`;
    const deptLabel = filters.department === "ALL" ? "All Departments" : filters.department;

    doc.setFontSize(14);
    doc.setTextColor(26, 58, 92);
    doc.text("Universal Leaf Philippines, Inc. — HR Report", pageWidth / 2, 36, { align: "center" });
    doc.setFontSize(9);
    doc.setTextColor(100, 116, 139);
    doc.text(
      `Period: ${rangeLabel}   |   Department: ${deptLabel}   |   Generated: ${new Date(data.generatedAt).toLocaleString()}`,
      pageWidth / 2, 52, { align: "center" }
    );

    let startY = 68;

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
        ["Employee", "Department", "Date", "Status", "Total Hours", "Late Min."],
        filteredAttendance.map((r) => [employeeName(r), r.employee.department.name, formatDate(r.attendanceDate), r.status, (r.totalMinutes / 60).toFixed(2), String(r.lateMinutes)])
      );
    }
    if (tab === "ALL" || tab === "leave") {
      addSection("Leave",
        ["Employee", "Department", "Leave Type", "Start Date", "End Date", "Days", "Status"],
        filteredLeaves.map((r) => [employeeName(r), r.employee.department.name, r.leaveType.name, formatDate(r.startDate), formatDate(r.endDate), r.totalDays, r.status])
      );
    }
    if (tab === "ALL" || tab === "schedules") {
      addSection("Schedules",
        ["Employee", "Department", "Shift", "Time", "Starts On", "Ends On"],
        filteredSchedules.map((s) => [employeeName(s), s.employee.department.name, s.shift.name, `${s.shift.startTime} - ${s.shift.endTime}`, formatDate(s.startsOn), s.endsOn ? formatDate(s.endsOn) : "Ongoing"])
      );
    }

    doc.save(`${tab === "ALL" ? "all" : tab}-report.pdf`);
  };

  const tabCount =
    tab === "attendance" ? filteredAttendance.length
    : tab === "leave" ? filteredLeaves.length
    : tab === "schedules" ? filteredSchedules.length
    : filteredAttendance.length + filteredLeaves.length + filteredSchedules.length;

  return (
    <>
      {/* ── Stat Cards ── */}
      <div className="reports-summary-grid">
        <StatCard label="Attendance Records" value={filteredTotals.attendanceRecords} icon={BarChart3} tone="cyan" />
        <StatCard label="Approved Leaves" value={filteredTotals.approvedLeaves} icon={CheckCircle2} tone="green" />
        <StatCard label="Pending Leaves" value={filteredTotals.pendingLeaves} icon={Clock} tone="yellow" />
        <StatCard label="Active Schedules" value={filteredTotals.activeSchedules} icon={CalendarClock} tone="blue" />
      </div>

      {/* ── Toolbar ── */}
      <div className="reports-toolbar">
        <div className="reports-toolbar-left">
          <h2 className="reports-title">Reports</h2>
          <span className="reports-meta">Generated {new Date(data.generatedAt).toLocaleString()}</span>
        </div>
        <div className="reports-result-count">
          <span>{tabCount} result{tabCount !== 1 ? "s" : ""}</span>
        </div>
      </div>

      {/* ── Filter Bar ── */}
      <div className="reports-filter-bar">
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
          <button className="report-generate-button" onClick={loadReport}>
            <BarChart3 size={14} />
            <span>Generate</span>
          </button>
          <button className="report-export-button" onClick={exportCsv}>
            <Download size={14} />
            <span>Export CSV</span>
          </button>
          <button className="report-export-button" onClick={exportPdf}>
            <FileText size={14} />
            <span>Export PDF</span>
          </button>
        </div>
      </div>

      {/* ── Tables ── */}
      {(tab === "ALL" || tab === "attendance") && (
        <section className="table-card reports-table-card">
          {tab === "ALL" && <div className="reports-table-label">DTR / Attendance</div>}
          <table>
            <thead>
              <tr>
                <th>Employee</th><th>Department</th><th>Date</th>
                <th>Status</th><th>Total Hours</th><th>Late Min.</th>
              </tr>
            </thead>
            <tbody>
              {filteredAttendance.length === 0 ? (
                <tr><td colSpan={6} className="reports-empty">No attendance records match the current filters.</td></tr>
              ) : filteredAttendance.map((record) => (
                <tr key={record.id}>
                  <td>{employeeName(record)}</td>
                  <td>{record.employee.department.name}</td>
                  <td>{formatDate(record.attendanceDate)}</td>
                  <td><Badge tone={statusTone(record.status)}>{record.status.replace(/_/g, " ")}</Badge></td>
                  <td>{(record.totalMinutes / 60).toFixed(2)}</td>
                  <td>{record.lateMinutes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {(tab === "ALL" || tab === "leave") && (
        <section className="table-card reports-table-card">
          {tab === "ALL" && <div className="reports-table-label">Leave</div>}
          <table>
            <thead>
              <tr>
                <th>Employee</th><th>Department</th><th>Leave Type</th>
                <th>Dates</th><th>Days</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredLeaves.length === 0 ? (
                <tr><td colSpan={6} className="reports-empty">No leave records match the current filters.</td></tr>
              ) : filteredLeaves.map((request) => (
                <tr key={request.id}>
                  <td>{employeeName(request)}</td>
                  <td>{request.employee.department.name}</td>
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
                <th>Employee</th><th>Department</th><th>Shift</th>
                <th>Time</th><th>Starts On</th><th>Ends On</th>
              </tr>
            </thead>
            <tbody>
              {filteredSchedules.length === 0 ? (
                <tr><td colSpan={6} className="reports-empty">No schedule records match the current filters.</td></tr>
              ) : filteredSchedules.map((schedule) => (
                <tr key={schedule.id}>
                  <td>{employeeName(schedule)}</td>
                  <td>{schedule.employee.department.name}</td>
                  <td>{schedule.shift.name}</td>
                  <td>{schedule.shift.startTime} – {schedule.shift.endTime}</td>
                  <td>{formatDate(schedule.startsOn)}</td>
                  <td>
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
    </>
  );
}