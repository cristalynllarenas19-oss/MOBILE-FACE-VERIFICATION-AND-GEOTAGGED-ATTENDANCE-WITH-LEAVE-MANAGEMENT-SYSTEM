import { useEffect, useMemo, useState, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2, Eye, Plus, Settings, X } from "lucide-react";
import { apiRequest } from "../../lib/api";
import { PermissionCode, permissions } from "../../types/rbac";
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

export function SchedulesPage({ user }: { user?: { permissions: PermissionCode[] } }) {
  const canWrite = user?.permissions.includes(permissions.schedulesWrite) ?? true;
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [departmentFilter, setDepartmentFilter] = useState("ALL");
  const [shiftFilter, setShiftFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ACTIVE");
  const [viewSchedule, setViewSchedule] = useState<Schedule | null>(null);
  const [showAddShift, setShowAddShift] = useState(false);
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

  const departments = useMemo(
    () => Array.from(new Set(employees.map((e) => e.department.name))).sort(),
    [employees]
  );

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
      setNotification({ type: "success", message: "Schedule assignment added successfully." });
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
      setShowAddShift(false);
      setNotification({ type: "success", message: `"${created.name}" shift added successfully.` });
    } catch (err) {
      setNotification({ type: "error", message: err instanceof Error ? err.message : "Unable to add shift." });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      {/* ── Toast ── */}
      {notification && (
        <div className={`schedules-notification ${notification.type}`} role="status">
          {notification.type === "success" ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
          <span>{notification.message}</span>
        </div>
      )}

      {/* ── Assign Shift Card ── */}
      {canWrite && (
        <section className="schedule-form-card">
          <div className="schedule-form-card-header">
            <h3 className="schedule-form-card-title">Assign Shift to Employee</h3>
            <button
              type="button"
              className="manage-shifts-btn"
              onClick={() => setShowAddShift(true)}
              title="Manage shift types"
            >
              <Settings size={14} />
              Manage Shifts
            </button>
          </div>

          <form className="schedule-form" onSubmit={createSchedule}>
            <div className="schedule-field">
              <label className="schedule-field-label">Employee</label>
              <select
                value={form.employeeId}
                onChange={(e) => setForm((c) => ({ ...c, employeeId: e.target.value }))}
                required
              >
                <option value="" disabled>Select employee…</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>{getName(emp)}</option>
                ))}
              </select>
            </div>

            <div className="schedule-field">
              <label className="schedule-field-label">Shift</label>
              <select
                value={form.shiftId}
                onChange={(e) => setForm((c) => ({ ...c, shiftId: e.target.value }))}
                required
              >
                <option value="" disabled>Select shift…</option>
                {shifts.map((shift) => (
                  <option key={shift.id} value={shift.id}>
                    {shift.name} ({shift.startTime} – {shift.endTime})
                  </option>
                ))}
              </select>
            </div>

            <div className="schedule-field">
              <label className="schedule-field-label">Start Date</label>
              <input
                type="date"
                value={form.startsOn}
                onChange={(e) => setForm((c) => ({ ...c, startsOn: e.target.value }))}
                required
              />
            </div>

            <div className="schedule-field">
              <label className="schedule-field-label">End Date <span className="optional-tag">optional</span></label>
              <input
                type="date"
                value={form.endsOn}
                onChange={(e) => setForm((c) => ({ ...c, endsOn: e.target.value }))}
              />
            </div>

            <div className="schedule-field schedule-field--action">
              <label className="schedule-field-label">&nbsp;</label>
              <button className="add-schedule-button" disabled={isSaving}>
                <Plus size={15} /> Assign Shift
              </button>
            </div>
          </form>
        </section>
      )}

      {/* ── Filters + Table ── */}
      <div className="schedules-toolbar">
        <div className="filter-tabs">
          <button
            className={departmentFilter === "ALL" && shiftFilter === "ALL" && statusFilter === "ALL" ? "active" : ""}
            onClick={() => { setDepartmentFilter("ALL"); setShiftFilter("ALL"); setStatusFilter("ALL"); }}
          >
            All Schedules
          </button>
          <select className="schedule-select" value={departmentFilter} onChange={(e) => setDepartmentFilter(e.target.value)}>
            <option value="ALL">All Departments</option>
            {departments.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <select className="schedule-select" value={shiftFilter} onChange={(e) => setShiftFilter(e.target.value)}>
            <option value="ALL">All Shifts</option>
            {shifts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select className="schedule-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="ALL">All Status</option>
            <option value="ACTIVE">Active</option>
            <option value="ENDED">Ended</option>
          </select>
        </div>
      </div>

      <section className="table-card schedules-table-card">
        <table>
          <thead>
            <tr>
              <th>Employee</th>
              <th>Department</th>
              <th>Position</th>
              <th>Shift</th>
              <th>Time</th>
              <th>Grace Period</th>
              <th>Effective Dates</th>
              <th>Action</th>
            </tr>
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
                  <td data-label="Time">{schedule.shift.startTime} – {schedule.shift.endTime}</td>
                  <td data-label="Grace Period">{schedule.shift.gracePeriodMinutes} min</td>
                  <td data-label="Effective Dates">{formatDate(schedule.startsOn)} – {formatDate(schedule.endsOn)}</td>
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

      {/* ── View Schedule Modal ── */}
      {viewSchedule && (
        <div className="schedule-modal-backdrop" role="presentation">
          <section className="schedule-modal" role="dialog" aria-modal="true" aria-labelledby="schedule-modal-title">
            <div className="schedule-modal-header">
              <div>
                <h2 id="schedule-modal-title">Schedule Details</h2>
                <p>{getName(viewSchedule.employee)}</p>
              </div>
              <button className="icon-button" onClick={() => setViewSchedule(null)} aria-label="Close">
                <X size={18} />
              </button>
            </div>
            <div className="schedule-detail-grid">
              <div><span>Employee</span><strong>{getName(viewSchedule.employee)}</strong></div>
              <div><span>Department</span><strong>{viewSchedule.employee.department.name}</strong></div>
              <div><span>Position</span><strong>{viewSchedule.employee.position.title}</strong></div>
              <div><span>Shift</span><strong>{viewSchedule.shift.name}</strong></div>
              <div><span>Time</span><strong>{viewSchedule.shift.startTime} – {viewSchedule.shift.endTime}</strong></div>
              <div><span>Grace Period</span><strong>{viewSchedule.shift.gracePeriodMinutes} minutes</strong></div>
              <div><span>Effective Dates</span><strong>{formatDate(viewSchedule.startsOn)} – {formatDate(viewSchedule.endsOn)}</strong></div>
            </div>
            <div className="schedule-detail-actions">
              <button type="button" className="outline-button" onClick={() => setViewSchedule(null)}>Close</button>
            </div>
          </section>
        </div>
      )}

      {/* ── Add Shift Type Modal ── */}
      {canWrite && showAddShift && (
        <div className="schedule-modal-backdrop" role="presentation">
          <section className="schedule-modal schedule-modal--sm" role="dialog" aria-modal="true" aria-labelledby="add-shift-title">
            <div className="schedule-modal-header">
              <div>
                <h2 id="add-shift-title">Create Shift Type</h2>
                <p>New shift will be available to assign immediately</p>
              </div>
              <button className="icon-button" onClick={() => setShowAddShift(false)} aria-label="Close">
                <X size={18} />
              </button>
            </div>

            <form onSubmit={createShift}>
              <div className="add-shift-body">
                <div className="add-shift-field">
                  <label className="add-shift-label">Shift Name <span className="add-type-required">*</span></label>
                  <input
                    className="add-shift-input"
                    type="text"
                    value={shiftForm.name}
                    onChange={(e) => setShiftForm((c) => ({ ...c, name: e.target.value }))}
                    placeholder="e.g. Morning Shift"
                    required
                    autoFocus
                  />
                </div>

                <div className="add-shift-row">
                  <div className="add-shift-field">
                    <label className="add-shift-label">Start Time <span className="add-type-required">*</span></label>
                    <input
                      className="add-shift-input"
                      type="time"
                      value={shiftForm.startTime}
                      onChange={(e) => setShiftForm((c) => ({ ...c, startTime: e.target.value }))}
                      required
                    />
                  </div>
                  <div className="add-shift-field">
                    <label className="add-shift-label">End Time <span className="add-type-required">*</span></label>
                    <input
                      className="add-shift-input"
                      type="time"
                      value={shiftForm.endTime}
                      onChange={(e) => setShiftForm((c) => ({ ...c, endTime: e.target.value }))}
                      required
                    />
                  </div>
                </div>

                <div className="add-shift-field">
                  <label className="add-shift-label">Grace Period (minutes)</label>
                  <input
                    className="add-shift-input"
                    type="number"
                    min="0"
                    value={shiftForm.gracePeriodMinutes}
                    onChange={(e) => setShiftForm((c) => ({ ...c, gracePeriodMinutes: e.target.value }))}
                    placeholder="0"
                  />
                  <span className="add-shift-hint">How many minutes late is still considered on time</span>
                </div>
              </div>

              <div className="schedule-detail-actions">
                <button type="submit" className="add-schedule-button" disabled={isSaving || !shiftForm.name.trim() || !shiftForm.startTime || !shiftForm.endTime}>
                  {isSaving ? "Saving…" : "Create Shift"}
                </button>
                <button type="button" className="outline-button" onClick={() => setShowAddShift(false)} disabled={isSaving}>
                  Cancel
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}