import { useEffect, useMemo, useState } from "react";
import { Badge } from "../../components/ui/Badge";
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

type ReportTab = "attendance" | "leave" | "schedules";

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

export function ReportsPage() {
  const [data, setData] = useState<ReportData | null>(null);
  const [tab, setTab] = useState<ReportTab>("attendance");
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

  const departments = useMemo(() => Array.from(new Set(employees.map((employee) => employee.department.name))).sort(), [employees]);

  const statusSummary = useMemo(() => {
    if (!data) return [];
    return [
      ["Attendance Records", data.totals.attendanceRecords],
      ["Approved Leaves", data.totals.approvedLeaves],
      ["Pending Leaves", data.totals.pendingLeaves],
      ["Active Schedules", data.totals.activeSchedules],
    ] as const;
  }, [data]);

  if (!data) {
    return <section className="table-card reports-loading">Loading reports...</section>;
  }

  const exportCsv = () => {
    const rows =
      tab === "attendance"
        ? [["Employee", "Department", "Date", "Status", "Total Hours", "Late Minutes"], ...data.attendance.map((record) => [employeeName(record), record.employee.department.name, formatDate(record.attendanceDate), record.status, (record.totalMinutes / 60).toFixed(2), String(record.lateMinutes)])]
        : tab === "leave"
          ? [["Employee", "Department", "Leave Type", "Dates", "Days", "Status"], ...data.leaves.map((request) => [employeeName(request), request.employee.department.name, request.leaveType.name, `${formatDate(request.startDate)} - ${formatDate(request.endDate)}`, request.totalDays, request.status])]
          : [["Employee", "Department", "Shift", "Time", "Starts On", "Ends On"], ...data.schedules.map((schedule) => [employeeName(schedule), schedule.employee.department.name, schedule.shift.name, `${schedule.shift.startTime} - ${schedule.shift.endTime}`, formatDate(schedule.startsOn), schedule.endsOn ? formatDate(schedule.endsOn) : "Ongoing"])];
    const csv = rows.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${tab}-report.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="reports-summary-grid">
        {statusSummary.map(([label, value]) => (
          <div className="reports-summary-card" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>

      <div className="reports-toolbar">
        <div className="filter-tabs">
          <button className={tab === "attendance" ? "active" : ""} onClick={() => setTab("attendance")}>DTR Reports</button>
          <button className={tab === "leave" ? "active" : ""} onClick={() => setTab("leave")}>Leave Reports</button>
          <button className={tab === "schedules" ? "active" : ""} onClick={() => setTab("schedules")}>Schedule Reports</button>
        </div>
        <span>Generated {new Date(data.generatedAt).toLocaleString()}</span>
      </div>

      <div className="reports-filter-bar">
        <input type="date" value={filters.from} onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))} aria-label="Report start date" />
        <input type="date" value={filters.to} onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))} aria-label="Report end date" />
        <select value={filters.department} onChange={(event) => setFilters((current) => ({ ...current, department: event.target.value }))} aria-label="Report department">
          <option value="ALL">All Departments</option>
          {departments.map((department) => <option key={department} value={department}>{department}</option>)}
        </select>
        <button className="report-generate-button" onClick={loadReport}>Generate</button>
        <button className="report-export-button" onClick={exportCsv}>Export CSV</button>
      </div>

      {tab === "attendance" && (
        <section className="table-card reports-table-card">
          <table>
            <thead><tr><th>Employee</th><th>Department</th><th>Date</th><th>Status</th><th>Total Hours</th><th>Late Minutes</th></tr></thead>
            <tbody>
              {data.attendance.map((record) => (
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

      {tab === "leave" && (
        <section className="table-card reports-table-card">
          <table>
            <thead><tr><th>Employee</th><th>Department</th><th>Leave Type</th><th>Dates</th><th>Days</th><th>Status</th></tr></thead>
            <tbody>
              {data.leaves.map((request) => (
                <tr key={request.id}>
                  <td>{employeeName(request)}</td>
                  <td>{request.employee.department.name}</td>
                  <td>{request.leaveType.name}</td>
                  <td>{formatDate(request.startDate)} - {formatDate(request.endDate)}</td>
                  <td>{request.totalDays}</td>
                  <td><Badge tone={statusTone(request.status)}>{request.status.replace(/_/g, " ")}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {tab === "schedules" && (
        <section className="table-card reports-table-card">
          <table>
            <thead><tr><th>Employee</th><th>Department</th><th>Shift</th><th>Time</th><th>Starts On</th><th>Ends On</th></tr></thead>
            <tbody>
              {data.schedules.map((schedule) => (
                <tr key={schedule.id}>
                  <td>{employeeName(schedule)}</td>
                  <td>{schedule.employee.department.name}</td>
                  <td>{schedule.shift.name}</td>
                  <td>{schedule.shift.startTime} - {schedule.shift.endTime}</td>
                  <td>{formatDate(schedule.startsOn)}</td>
                  <td>{schedule.endsOn ? formatDate(schedule.endsOn) : "Ongoing"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
