import { useEffect, useMemo, useState, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2, Eye, Plus, X } from "lucide-react";
import { apiRequest } from "../../lib/api";
import "./SchedulesPage.css";

type Employee = {
  id: string;
  firstName: string;
  lastName: string;
  department: { name: string };
  position: { title: string };
};

type Shift = {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  gracePeriodMinutes: number;
};

type Schedule = {
  id: string;
  startsOn: string;
  endsOn?: string | null;
  employee: Employee;
  shift: Shift;
};

type Notification = { type: "success" | "error"; message: string } | null;

function getName(employee: Employee) {
  return `${employee.firstName} ${employee.lastName}`;
}

function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleDateString() : "Ongoing";
}

export function SchedulesPage() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [departmentFilter, setDepartmentFilter] = useState("ALL");
  const [shiftFilter, setShiftFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ACTIVE");
  const [viewSchedule, setViewSchedule] = useState<Schedule | null>(null);
  const [form, setForm] = useState({ employeeId: "", shiftId: "", startsOn: "", endsOn: "" });
  const [shiftForm, setShiftForm] = useState({ name: "", startTime: "", endTime: "", gracePeriodMinutes: "0" });
  const [isSaving, setIsSaving] = useState(false);
  const [notification, setNotification] = useState<Notification>(null);

  const loadData = () => {
    const params = new URLSearchParams();
    if (departmentFilter !== "ALL") params.set("department", departmentFilter);
    if (shiftFilter !== "ALL") params.set("shiftId", shiftFilter);
    if (statusFilter !== "ALL") params.set("status", statusFilter);
    const query = params.toString();
    Promise.all([
      apiRequest<Schedule[]>(`/schedules${query ? `?${query}` : ""}`),
      apiRequest<Employee[]>("/employees"),
      apiRequest<Shift[]>("/schedules/shifts"),
    ])
      .then(([scheduleRows, employeeRows, shiftRows]) => {
        setSchedules(scheduleRows);
        setEmployees(employeeRows);
        setShifts(shiftRows);
        setForm((current) => ({
          ...current,
          employeeId: current.employeeId || employeeRows[0]?.id || "",
          shiftId: current.shiftId || shiftRows[0]?.id || "",
        }));
      })
      .catch(() => undefined);
  };

  useEffect(loadData, [departmentFilter, shiftFilter, statusFilter]);

  useEffect(() => {
    if (!notification) return;
    const timeoutId = window.setTimeout(() => setNotification(null), 3500);
    return () => window.clearTimeout(timeoutId);
  }, [notification]);

  const departments = useMemo(() => Array.from(new Set(employees.map((employee) => employee.department.name))).sort(), [employees]);

  const createSchedule = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSaving(true);
    try {
      const created = await apiRequest<Schedule>("/schedules", {
        method: "POST",
        body: JSON.stringify({
          employeeId: form.employeeId,
          shiftId: form.shiftId,
          startsOn: form.startsOn,
          ...(form.endsOn ? { endsOn: form.endsOn } : {}),
        }),
      });
      setSchedules((current) => [created, ...current]);
      setNotification({ type: "success", message: "Schedule assignment was added successfully." });
    } catch (err) {
      setNotification({ type: "error", message: err instanceof Error ? err.message : "Unable to add schedule." });
    } finally {
      setIsSaving(false);
    }
  };

  const createShift = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSaving(true);
    try {
      const created = await apiRequest<Shift>("/schedules/shifts", {
        method: "POST",
        body: JSON.stringify({
          name: shiftForm.name.trim(),
          startTime: shiftForm.startTime,
          endTime: shiftForm.endTime,
          gracePeriodMinutes: Number(shiftForm.gracePeriodMinutes || 0),
        }),
      });
      setShifts((current) => [...current, created].sort((a, b) => a.startTime.localeCompare(b.startTime)));
      setShiftForm({ name: "", startTime: "", endTime: "", gracePeriodMinutes: "0" });
      setNotification({ type: "success", message: "Shift was added successfully." });
    } catch (err) {
      setNotification({ type: "error", message: err instanceof Error ? err.message : "Unable to add shift." });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      {notification && (
        <div className={`schedules-notification ${notification.type}`} role="status">
          {notification.type === "success" ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
          <span>{notification.message}</span>
        </div>
      )}

      <form className="schedule-form" onSubmit={createSchedule}>
        <select value={form.employeeId} onChange={(event) => setForm((current) => ({ ...current, employeeId: event.target.value }))} required>
          {employees.map((employee) => <option key={employee.id} value={employee.id}>{getName(employee)}</option>)}
        </select>
        <select value={form.shiftId} onChange={(event) => setForm((current) => ({ ...current, shiftId: event.target.value }))} required>
          {shifts.map((shift) => <option key={shift.id} value={shift.id}>{shift.name} ({shift.startTime} - {shift.endTime})</option>)}
        </select>
        <input type="date" value={form.startsOn} onChange={(event) => setForm((current) => ({ ...current, startsOn: event.target.value }))} required />
        <input type="date" value={form.endsOn} onChange={(event) => setForm((current) => ({ ...current, endsOn: event.target.value }))} />
        <button className="add-schedule-button" disabled={isSaving}><Plus size={15} /> Assign Shift</button>
      </form>

      <form className="schedule-form shift-form" onSubmit={createShift}>
        <input value={shiftForm.name} onChange={(event) => setShiftForm((current) => ({ ...current, name: event.target.value }))} placeholder="Shift name" required />
        <input type="time" value={shiftForm.startTime} onChange={(event) => setShiftForm((current) => ({ ...current, startTime: event.target.value }))} required />
        <input type="time" value={shiftForm.endTime} onChange={(event) => setShiftForm((current) => ({ ...current, endTime: event.target.value }))} required />
        <input type="number" min="0" value={shiftForm.gracePeriodMinutes} onChange={(event) => setShiftForm((current) => ({ ...current, gracePeriodMinutes: event.target.value }))} aria-label="Grace period minutes" />
        <button className="add-schedule-button" disabled={isSaving}><Plus size={15} /> Add Shift</button>
      </form>

      <div className="schedules-toolbar">
        <div className="filter-tabs">
          <button className={departmentFilter === "ALL" && shiftFilter === "ALL" && statusFilter === "ALL" ? "active" : ""} onClick={() => { setDepartmentFilter("ALL"); setShiftFilter("ALL"); setStatusFilter("ALL"); }}>All Schedules</button>
          <select className="schedule-select" value={departmentFilter} onChange={(event) => setDepartmentFilter(event.target.value)}>
            <option value="ALL">All Departments</option>
            {departments.map((department) => <option key={department} value={department}>{department}</option>)}
          </select>
          <select className="schedule-select" value={shiftFilter} onChange={(event) => setShiftFilter(event.target.value)}>
            <option value="ALL">All Shifts</option>
            {shifts.map((shift) => <option key={shift.id} value={shift.id}>{shift.name}</option>)}
          </select>
          <select className="schedule-select" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="ALL">All Status</option>
            <option value="ACTIVE">Active</option>
            <option value="ENDED">Ended</option>
          </select>
        </div>
      </div>

      <section className="table-card schedules-table-card">
        <table>
          <thead>
            <tr><th>Employee</th><th>Department</th><th>Position</th><th>Shift</th><th>Time</th><th>Grace Period</th><th>Effective Dates</th><th>Action</th></tr>
          </thead>
          <tbody>
            {schedules.length === 0 ? (
              <tr><td colSpan={8} className="schedules-empty-state">No schedule assignments found.</td></tr>
            ) : (
              schedules.map((schedule) => (
                <tr key={schedule.id}>
                  <td data-label="Employee">{getName(schedule.employee)}</td>
                  <td data-label="Department">{schedule.employee.department.name}</td>
                  <td data-label="Position">{schedule.employee.position.title}</td>
                  <td data-label="Shift">{schedule.shift.name}</td>
                  <td data-label="Time">{schedule.shift.startTime} - {schedule.shift.endTime}</td>
                  <td data-label="Grace Period">{schedule.shift.gracePeriodMinutes} minutes</td>
                  <td data-label="Effective Dates">{formatDate(schedule.startsOn)} - {formatDate(schedule.endsOn)}</td>
                  <td data-label="Action">
                    <button className="schedule-view-button" onClick={() => setViewSchedule(schedule)}>
                      <Eye size={14} /> View
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      {viewSchedule && (
        <div className="schedule-modal-backdrop" role="presentation">
          <section className="schedule-modal" role="dialog" aria-modal="true" aria-labelledby="schedule-modal-title">
            <div className="schedule-modal-header">
              <div>
                <h2 id="schedule-modal-title">Schedule Details</h2>
                <p>{getName(viewSchedule.employee)}</p>
              </div>
              <button className="icon-button" onClick={() => setViewSchedule(null)} aria-label="Close schedule details">
                <X size={18} />
              </button>
            </div>
            <div className="schedule-detail-grid">
              <div><span>Employee</span><strong>{getName(viewSchedule.employee)}</strong></div>
              <div><span>Department</span><strong>{viewSchedule.employee.department.name}</strong></div>
              <div><span>Position</span><strong>{viewSchedule.employee.position.title}</strong></div>
              <div><span>Shift</span><strong>{viewSchedule.shift.name}</strong></div>
              <div><span>Time</span><strong>{viewSchedule.shift.startTime} - {viewSchedule.shift.endTime}</strong></div>
              <div><span>Grace Period</span><strong>{viewSchedule.shift.gracePeriodMinutes} minutes</strong></div>
              <div><span>Effective Dates</span><strong>{formatDate(viewSchedule.startsOn)} - {formatDate(viewSchedule.endsOn)}</strong></div>
            </div>
            <div className="schedule-detail-actions">
              <button type="button" className="outline-button" onClick={() => setViewSchedule(null)}>Close</button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
