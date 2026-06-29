import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Eye, Pencil, Plus, Search, X } from "lucide-react";
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

function toDateInputValue(value?: string | null) {
  return value ? new Date(value).toISOString().slice(0, 10) : "";
}

const emptyForm = { employeeId: "", shiftId: "", startsOn: "", endsOn: "" };
const emptyEditForm = { shiftId: "", startsOn: "", endsOn: "" };

// ── Shared floating-panel dropdown ──
const SEARCH_THRESHOLD = 6;

function FormDropdown({
  label,
  placeholder,
  value,
  options,
  onChange,
  required,
  clearValue,
}: {
  label: string;
  placeholder: string;
  value: string;
  options: { value: string; label: string; sub?: string }[];
  onChange: (value: string) => void;
  required?: boolean;
  clearValue?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = options.find((o) => o.value === value) ?? null;
  const showSearch = options.length > SEARCH_THRESHOLD;
  const filteredOptions = useMemo(() => {
    if (!showSearch || !query.trim()) return options;
    const needle = query.trim().toLowerCase();
    return options.filter(
      (o) => o.label.toLowerCase().includes(needle) || o.sub?.toLowerCase().includes(needle),
    );
  }, [options, query, showSearch]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    if (showSearch) searchRef.current?.focus();
    return () => document.removeEventListener("mousedown", handler);
  }, [open, showSearch]);

  return (
    <div className="schedule-field" ref={ref}>
      <label className="schedule-field-label">{label}</label>
      {/* Hidden native select for form validation */}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        tabIndex={-1}
        aria-hidden="true"
        className="sfd-hidden-select"
      >
        <option value="" />
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      <button
        type="button"
        className={`sfd-trigger ${open ? "open" : ""} ${!value ? "sfd-placeholder" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="sfd-trigger-text">
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown size={13} className="sfd-chevron" />
      </button>

      {open && (
        <div className="sfd-menu" role="listbox">
          <div className="sfd-menu-header">
            <span className="sfd-menu-label">{label}</span>
            {clearValue !== undefined && value !== clearValue && (
              <button
                type="button"
                className="sfd-clear"
                onClick={() => {
                  onChange(clearValue);
                  setOpen(false);
                }}
              >
                <X size={12} /> Clear
              </button>
            )}
          </div>

          {showSearch && (
            <div className="sfd-search-wrap">
              <Search size={13} className="sfd-search-icon" />
              <input
                ref={searchRef}
                type="text"
                className="sfd-search-input"
                placeholder={`Search ${label.toLowerCase()}...`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          )}

          <div className="sfd-options-list">
            {filteredOptions.length === 0 ? (
              <div className="sfd-no-results">No matches found.</div>
            ) : (
              filteredOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={opt.value === value}
                  className={`sfd-option ${opt.value === value ? "selected" : ""}`}
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                >
                  {opt.label}
                  {opt.sub && <span className="sfd-option-sub">{opt.sub}</span>}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
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
  const [editSchedule, setEditSchedule] = useState<Schedule | null>(null);
  const [editForm, setEditForm] = useState(emptyEditForm);
  const [form, setForm] = useState(emptyForm);
  const [isSaving, setIsSaving] = useState(false);
  const [isEditSaving, setIsEditSaving] = useState(false);
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
      setForm(emptyForm);
      setNotification({ type: "success", message: "Schedule assignment added successfully." });
    } catch (err) {
      setNotification({
        type: "error",
        message: err instanceof Error ? err.message : "Unable to add schedule.",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const openEdit = (schedule: Schedule) => {
    setEditSchedule(schedule);
    setEditForm({
      shiftId: schedule.shift.id,
      startsOn: toDateInputValue(schedule.startsOn),
      endsOn: toDateInputValue(schedule.endsOn),
    });
  };

  const saveEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editSchedule) return;
    setIsEditSaving(true);
    try {
      const updated = await apiRequest<Schedule>(`/schedules/${editSchedule.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          shiftId: editForm.shiftId,
          startsOn: editForm.startsOn,
          endsOn: editForm.endsOn || null,
        }),
      });
      setSchedules((current) => current.map((s) => (s.id === updated.id ? updated : s)));
      setEditSchedule(null);
      setNotification({ type: "success", message: "Schedule updated successfully." });
    } catch (err) {
      setNotification({
        type: "error",
        message: err instanceof Error ? err.message : "Unable to update schedule.",
      });
    } finally {
      setIsEditSaving(false);
    }
  };

  const isAllActive =
    departmentFilter === "ALL" && shiftFilter === "ALL" && statusFilter === "ALL";

  return (
    <>
      {notification && (
        <div className={`schedules-notification ${notification.type}`} role="status">
          {notification.type === "success" ? (
            <CheckCircle2 size={17} />
          ) : (
            <AlertTriangle size={17} />
          )}
          <span>{notification.message}</span>
        </div>
      )}

      {canWrite && (
        <section className="schedule-form-card">
          <div className="schedule-form-card-header">
            <h3 className="schedule-form-card-title">Assign Shift to Employee</h3>
          </div>

          <form className="schedule-form" onSubmit={createSchedule}>
            <FormDropdown
              label="Employee"
              placeholder="Select employee…"
              value={form.employeeId}
              onChange={(v) => setForm((c) => ({ ...c, employeeId: v }))}
              required
              options={employees.map((emp) => ({
                value: emp.id,
                label: getName(emp),
                sub: `${emp.department.name} · ${emp.position.title}`,
              }))}
            />

            <FormDropdown
              label="Shift"
              placeholder="Select shift…"
              value={form.shiftId}
              onChange={(v) => setForm((c) => ({ ...c, shiftId: v }))}
              required
              options={shifts.map((s) => ({
                value: s.id,
                label: s.name,
                sub: `${s.startTime} – ${s.endTime}`,
              }))}
            />

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
              <label className="schedule-field-label">
                End Date <span className="optional-tag">optional</span>
              </label>
              <input
                type="date"
                value={form.endsOn}
                onChange={(e) => setForm((c) => ({ ...c, endsOn: e.target.value }))}
              />
            </div>

            <div className="schedule-field schedule-field--action">
              <label className="schedule-field-label">&nbsp;</label>
              <button
                className="add-schedule-button"
                disabled={isSaving || !form.employeeId || !form.shiftId || !form.startsOn}
              >
                <Plus size={15} /> {isSaving ? "Saving…" : "Assign Shift"}
              </button>
            </div>
          </form>
        </section>
      )}

      {/* ── Toolbar with panel-style dropdowns ── */}
      <div className="schedules-toolbar">
        <div className="filter-tabs">
          <button
            className={isAllActive ? "active" : ""}
            onClick={() => {
              setDepartmentFilter("ALL");
              setShiftFilter("ALL");
              setStatusFilter("ALL");
            }}
          >
            All Schedules
          </button>

          {/* Department dropdown — panel style */}
          <FormDropdown
            label="Department"
            placeholder="All Departments"
            value={departmentFilter}
            onChange={setDepartmentFilter}
            clearValue="ALL"
            options={[
              { value: "ALL", label: "All Departments" },
              ...departments.map((d) => ({ value: d, label: d })),
            ]}
          />

          {/* Shift dropdown — panel style */}
          <FormDropdown
            label="Shift"
            placeholder="All Shifts"
            value={shiftFilter}
            onChange={setShiftFilter}
            clearValue="ALL"
            options={[
              { value: "ALL", label: "All Shifts" },
              ...shifts.map((s) => ({
                value: s.id,
                label: s.name,
                sub: `${s.startTime} – ${s.endTime}`,
              })),
            ]}
          />

          {/* Status dropdown — panel style */}
          <FormDropdown
            label="Status"
            placeholder="All Status"
            value={statusFilter}
            onChange={setStatusFilter}
            clearValue="ALL"
            options={[
              { value: "ALL", label: "All Status" },
              { value: "ACTIVE", label: "Active" },
              { value: "ENDED", label: "Ended" },
            ]}
          />
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
              <tr>
                <td colSpan={8} className="schedules-empty-state">
                  No schedule assignments found.
                </td>
              </tr>
            ) : (
              schedules.map((schedule) => (
                <tr key={schedule.id}>
                  <td data-label="Employee">{getName(schedule.employee)}</td>
                  <td data-label="Department">{schedule.employee.department.name}</td>
                  <td data-label="Position">{schedule.employee.position.title}</td>
                  <td data-label="Shift">{schedule.shift.name}</td>
                  <td data-label="Time">
                    {schedule.shift.startTime} – {schedule.shift.endTime}
                  </td>
                  <td data-label="Grace Period">{schedule.shift.gracePeriodMinutes} min</td>
                  <td data-label="Effective Dates">
                    {formatDate(schedule.startsOn)} – {formatDate(schedule.endsOn)}
                  </td>
                  <td data-label="Action">
                    <button
                      className="schedule-view-button"
                      onClick={() => setViewSchedule(schedule)}
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

      {/* ── View Schedule Modal ── */}
      {viewSchedule && (
        <div className="schedule-modal-backdrop" role="presentation">
          <section
            className="schedule-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="schedule-modal-title"
          >
            <div className="schedule-modal-header">
              <div>
                <h2 id="schedule-modal-title">Schedule Details</h2>
                <p>{getName(viewSchedule.employee)}</p>
              </div>
              <button
                className="icon-button"
                onClick={() => setViewSchedule(null)}
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
            <div className="schedule-detail-grid">
              <div>
                <span>Employee</span>
                <strong>{getName(viewSchedule.employee)}</strong>
              </div>
              <div>
                <span>Department</span>
                <strong>{viewSchedule.employee.department.name}</strong>
              </div>
              <div>
                <span>Position</span>
                <strong>{viewSchedule.employee.position.title}</strong>
              </div>
              <div>
                <span>Shift</span>
                <strong>{viewSchedule.shift.name}</strong>
              </div>
              <div>
                <span>Time</span>
                <strong>
                  {viewSchedule.shift.startTime} – {viewSchedule.shift.endTime}
                </strong>
              </div>
              <div>
                <span>Grace Period</span>
                <strong>{viewSchedule.shift.gracePeriodMinutes} minutes</strong>
              </div>
              <div>
                <span>Effective Dates</span>
                <strong>
                  {formatDate(viewSchedule.startsOn)} – {formatDate(viewSchedule.endsOn)}
                </strong>
              </div>
            </div>
            <div className="schedule-detail-actions">
              {canWrite && (
                <button
                  type="button"
                  className="schedule-edit-trigger-button"
                  onClick={() => {
                    openEdit(viewSchedule);
                    setViewSchedule(null);
                  }}
                >
                  <Pencil size={14} /> Edit
                </button>
              )}
              <button
                type="button"
                className="outline-button"
                onClick={() => setViewSchedule(null)}
              >
                Close
              </button>
            </div>
          </section>
        </div>
      )}

      {/* ── Edit Schedule Modal ── */}
      {editSchedule && (
        <div className="schedule-modal-backdrop" role="presentation">
          <section
            className="schedule-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="schedule-edit-modal-title"
          >
            <div className="schedule-modal-header">
              <div>
                <h2 id="schedule-edit-modal-title">Edit Shift Assignment</h2>
                <p>{getName(editSchedule.employee)}</p>
              </div>
              <button
                className="icon-button"
                onClick={() => setEditSchedule(null)}
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={saveEdit}>
              <div className="schedule-form schedule-edit-form">
                <FormDropdown
                  label="Shift"
                  placeholder="Select shift…"
                  value={editForm.shiftId}
                  onChange={(v) => setEditForm((c) => ({ ...c, shiftId: v }))}
                  required
                  options={shifts.map((s) => ({
                    value: s.id,
                    label: s.name,
                    sub: `${s.startTime} – ${s.endTime}`,
                  }))}
                />

                <div className="schedule-field">
                  <label className="schedule-field-label">Start Date</label>
                  <input
                    type="date"
                    value={editForm.startsOn}
                    onChange={(e) => setEditForm((c) => ({ ...c, startsOn: e.target.value }))}
                    required
                  />
                </div>

                <div className="schedule-field">
                  <label className="schedule-field-label">
                    End Date <span className="optional-tag">optional</span>
                  </label>
                  <input
                    type="date"
                    value={editForm.endsOn}
                    onChange={(e) => setEditForm((c) => ({ ...c, endsOn: e.target.value }))}
                  />
                </div>
              </div>

              <div className="schedule-detail-actions">
                <button
                  type="button"
                  className="outline-button"
                  onClick={() => setEditSchedule(null)}
                  disabled={isEditSaving}
                >
                  Cancel
                </button>
                <button
                  className="add-schedule-button"
                  disabled={isEditSaving || !editForm.shiftId || !editForm.startsOn}
                >
                  {isEditSaving ? "Saving…" : "Save Changes"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}