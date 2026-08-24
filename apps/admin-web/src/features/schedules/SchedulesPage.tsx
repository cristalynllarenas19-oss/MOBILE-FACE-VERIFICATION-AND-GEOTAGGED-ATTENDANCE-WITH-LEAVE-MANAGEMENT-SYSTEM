import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, Archive, CheckCircle2, ChevronDown, Eye, Pencil, RotateCcw, Plus, Search, X } from "lucide-react";
import { apiRequest } from "../../lib/api";
import { Badge } from "../../components/ui/Badge";
import { ConfirmDialog, type ConfirmDialogConfig } from "../../components/ui/ConfirmDialog";
import { useActiveDepartments } from "../../lib/departments";
import { PermissionCode, permissions } from "../../types/rbac";
import "./SchedulesPage.css";

type Employee = {
  id: string;
  firstName: string;
  lastName: string;
  employmentStatus?: string;
  attendanceMode?: string;
  department: { name: string };
  position: { title: string };
};

type Shift = {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  workingDays: number[];
};

type Schedule = {
  id: string;
  startsOn: string;
  endsOn?: string | null;
  workingDays: number[];
  isActive: boolean;
  employee: Employee;
  shift: Shift;
};

type Notification = { type: "success" | "error"; message: string } | null;

function getName(employee: Employee) {
  return `${employee.firstName} ${employee.lastName}`;
}

function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleDateString() : "Present";
}

function toDateInputValue(value?: string | null) {
  return value ? new Date(value).toISOString().slice(0, 10) : "";
}

// value matches JS Date.getDay() (0=Sunday..6=Saturday); displayed Mon-first.
// Sunday is excluded — it's a fixed company-wide day off, never selectable.
const WEEKDAYS = [
  { label: "Monday", short: "Mon", value: 1 },
  { label: "Tuesday", short: "Tue", value: 2 },
  { label: "Wednesday", short: "Wed", value: 3 },
  { label: "Thursday", short: "Thu", value: 4 },
  { label: "Friday", short: "Fri", value: 5 },
  { label: "Saturday", short: "Sat", value: 6 },
];

function formatWorkingDays(days: number[]): string {
  if (days.length === 6) return "Every day (except Sunday)";
  if (days.length === 0) return "No days selected";
  const byValue = new Map(WEEKDAYS.map((d) => [d.value, d.short]));
  return WEEKDAYS.filter((d) => days.includes(d.value))
    .map((d) => byValue.get(d.value))
    .join(", ");
}

const emptyForm = { employeeId: "", shiftId: "", startsOn: "", endsOn: "", workingDays: [1, 2, 3, 4, 5] as number[] };
const emptyEditForm = { shiftId: "", startsOn: "", endsOn: "", workingDays: [1, 2, 3, 4, 5] as number[] };

// ── Shared floating-panel dropdown ──
const SEARCH_THRESHOLD = 6;
const SCHEDULES_PAGE_SIZE = 6;

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

// ── Working Days multi-select — separate from FormDropdown since it needs
// checkbox-multi-select + Clear/Apply instead of single-select-and-close ──
function WorkingDaysDropdown({
  value,
  onChange,
  required,
}: {
  value: number[];
  onChange: (value: number[]) => void;
  required?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<number[]>(value);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setDraft(value);
      setQuery("");
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const filteredDays = WEEKDAYS.filter((d) => d.label.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="schedule-field" ref={ref}>
      <label className="schedule-field-label">
        Working Days {required && <span className="optional-tag">required</span>}
      </label>

      <button
        type="button"
        className={`sfd-trigger ${open ? "open" : ""} sfd-placeholder`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="sfd-trigger-text">Select Working Days</span>
        <ChevronDown size={13} className="sfd-chevron" />
      </button>

      {open && (
        <div className="sfd-menu" role="listbox">
          <div className="sfd-menu-header">
            <span className="sfd-menu-label">Working Days</span>
          </div>

          <div className="sfd-search-wrap">
            <Search size={13} className="sfd-search-icon" />
            <input
              type="text"
              className="sfd-search-input"
              placeholder="Search day..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onClick={(e) => e.stopPropagation()}
            />
          </div>

          <div className="sfd-options-list">
            {filteredDays.length === 0 ? (
              <div className="sfd-no-results">No matches found.</div>
            ) : (
              filteredDays.map((day) => (
                <label key={day.value} className="wd-option">
                  <input
                    type="checkbox"
                    checked={draft.includes(day.value)}
                    onChange={() =>
                      setDraft((current) =>
                        current.includes(day.value)
                          ? current.filter((d) => d !== day.value)
                          : [...current, day.value],
                      )
                    }
                  />
                  {day.label}
                </label>
              ))
            )}
          </div>

          <div className="wd-menu-footer">
            <button type="button" className="wd-clear-button" onClick={() => setDraft([])}>
              Clear
            </button>
            <button
              type="button"
              className="wd-apply-button"
              onClick={() => {
                onChange(draft);
                setOpen(false);
              }}
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function SchedulesPage({
  user,
}: {
  user?: { permissions: PermissionCode[]; roles?: string[]; departmentId?: string; department?: string };
}) {
  const canWrite = user?.permissions.includes(permissions.schedulesWrite) ?? true;
  // Mirrors the backend's getSupervisorDepartmentScope: a Supervisor who is
  // also an Admin (or not a Supervisor at all) gets full, unscoped access.
  const roles = user?.roles ?? [];
  const isDepartmentLocked = roles.includes("SUPERVISOR") && !roles.includes("ADMIN");

  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [departmentFilter, setDepartmentFilter] = useState("ALL");
  const [shiftFilter, setShiftFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ACTIVE");
  const [showArchived, setShowArchived] = useState(false);
  const [modeFilter, setModeFilter] = useState<"ALL" | "FIELD" | "NON_FIELD">("ALL");
  const [page, setPage] = useState(1);
  const [viewSchedule, setViewSchedule] = useState<Schedule | null>(null);
  const [editSchedule, setEditSchedule] = useState<Schedule | null>(null);
  const [editForm, setEditForm] = useState(emptyEditForm);
  const [form, setForm] = useState(emptyForm);
  const [isSaving, setIsSaving] = useState(false);
  const [isEditSaving, setIsEditSaving] = useState(false);
  const [notification, setNotification] = useState<Notification>(null);
  const [confirmConfig, setConfirmConfig] = useState<ConfirmDialogConfig | null>(null);

  const loadData = () => {
    const params = new URLSearchParams();
    if (departmentFilter !== "ALL") params.set("department", departmentFilter);
    if (shiftFilter !== "ALL") params.set("shiftId", shiftFilter);
    if (statusFilter !== "ALL") params.set("status", statusFilter);
    if (showArchived) params.set("archived", "true");
    const query = params.toString();
    Promise.all([
      apiRequest<Schedule[]>(`/schedules${query ? `?${query}` : ""}`),
      apiRequest<Employee[]>("/employees"),
      apiRequest<Shift[]>("/schedules/shifts"),
    ])
      .then(([scheduleRows, employeeRows, shiftRows]) => {
        setSchedules(scheduleRows);
        // A separated employee can't be assigned a new shift — same rule
        // already applied to the schedules list itself.
        setEmployees(employeeRows.filter((emp) => emp.employmentStatus !== "SEPARATED"));
        setShifts(shiftRows);
      })
      .catch(() => undefined);
  };

  useEffect(loadData, [departmentFilter, shiftFilter, statusFilter, showArchived]);
  useEffect(() => setPage(1), [departmentFilter, shiftFilter, statusFilter, showArchived, modeFilter]);

  const visibleSchedules = schedules.filter((schedule) => {
    if (modeFilter === "FIELD") return schedule.employee.attendanceMode === "FIELD";
    if (modeFilter === "NON_FIELD") return schedule.employee.attendanceMode !== "FIELD";
    return true;
  });

  // Picking a shift pre-fills Working Days with that shift's own default —
  // still freely editable afterward for a part-timer on the same shift.
  useEffect(() => {
    const shift = shifts.find((s) => s.id === form.shiftId);
    if (shift) setForm((c) => ({ ...c, workingDays: shift.workingDays }));
  }, [form.shiftId, shifts]);

  const pageCount = Math.max(1, Math.ceil(visibleSchedules.length / SCHEDULES_PAGE_SIZE));
  const pageSafe = Math.min(page, pageCount);
  const pagedSchedules = visibleSchedules.slice((pageSafe - 1) * SCHEDULES_PAGE_SIZE, pageSafe * SCHEDULES_PAGE_SIZE);

  useEffect(() => {
    if (!notification) return;
    const timeoutId = window.setTimeout(() => setNotification(null), 3500);
    return () => window.clearTimeout(timeoutId);
  }, [notification]);

  const { departmentNames: departments } = useActiveDepartments();

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
          workingDays: form.workingDays,
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
      workingDays: schedule.workingDays,
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
          workingDays: editForm.workingDays,
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

  const setAssignmentStatus = async (schedule: Schedule, isActive: boolean) => {
    try {
      await apiRequest(`/schedules/${schedule.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ isActive }),
      });
      setNotification({
        type: "success",
        message: `Schedule for ${getName(schedule.employee)} ${isActive ? "restored" : "archived"} successfully.`,
      });
      setViewSchedule(null);
      loadData();
    } catch (err) {
      setNotification({
        type: "error",
        message: err instanceof Error ? err.message : "Unable to update schedule status.",
      });
    }
  };

  const requestArchive = (schedule: Schedule) => {
    setConfirmConfig({
      title: `Archive this schedule for ${getName(schedule.employee)}?`,
      description: "Archived schedules are hidden from the active list. You can restore it at any time.",
      confirmLabel: "Archive",
      tone: "danger",
      onConfirm: () => setAssignmentStatus(schedule, false),
    });
  };

  const requestRestore = (schedule: Schedule) => {
    setConfirmConfig({
      title: `Restore this schedule for ${getName(schedule.employee)}?`,
      description: "This schedule assignment will become active again.",
      confirmLabel: "Restore",
      tone: "primary",
      onConfirm: () => setAssignmentStatus(schedule, true),
    });
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

            <WorkingDaysDropdown
              value={form.workingDays}
              onChange={(v) => setForm((c) => ({ ...c, workingDays: v }))}
              required
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
                disabled={isSaving || !form.employeeId || !form.shiftId || !form.startsOn || form.workingDays.length === 0}
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
            className={isAllActive && !showArchived ? "active" : ""}
            onClick={() => {
              setDepartmentFilter("ALL");
              setShiftFilter("ALL");
              setStatusFilter("ALL");
              setShowArchived(false);
              setModeFilter("ALL");
            }}
          >
            All Schedules
          </button>

          {/* Department dropdown — panel style; hidden entirely for a
              Supervisor, who is already restricted to their own department */}
          {!isDepartmentLocked && (
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
          )}

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

          <button
            className={showArchived ? "active" : ""}
            onClick={() => setShowArchived((v) => !v)}
          >
            Archived
          </button>
        </div>

        <div className="filter-tabs schedules-mode-tabs">
          <button
            className={modeFilter === "NON_FIELD" ? "active" : ""}
            onClick={() => setModeFilter((v) => (v === "NON_FIELD" ? "ALL" : "NON_FIELD"))}
          >
            Non-Field
          </button>
          <button
            className={modeFilter === "FIELD" ? "active" : ""}
            onClick={() => setModeFilter((v) => (v === "FIELD" ? "ALL" : "FIELD"))}
          >
            Field
          </button>
        </div>
      </div>

      <section className="table-card schedules-table-card">
        <div className="schedules-table-scroll">
        <table className="schedules-fixed-table">
          <colgroup>
            <col style={{ width: "18%" }} />
            <col style={{ width: "14%" }} />
            <col style={{ width: "14%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "11%" }} />
            <col style={{ width: "15%" }} />
            <col style={{ width: "16%" }} />
          </colgroup>
          <thead>
            <tr>
              <th>Employee</th>
              <th>Department</th>
              <th>Position</th>
              <th>Shift</th>
              <th>Time</th>
              <th>Effective Dates</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {visibleSchedules.length === 0 ? (
              <tr>
                <td colSpan={7} className="schedules-empty-state">
                  No schedule assignments found.
                </td>
              </tr>
            ) : (
              pagedSchedules.map((schedule) => (
                <tr key={schedule.id}>
                  <td data-label="Employee" title={getName(schedule.employee)}>{getName(schedule.employee)}</td>
                  <td data-label="Department" title={schedule.employee.department.name}>{schedule.employee.department.name}</td>
                  <td data-label="Position" title={schedule.employee.position.title}>{schedule.employee.position.title}</td>
                  <td data-label="Shift" title={schedule.shift.name}>{schedule.shift.name}</td>
                  <td data-label="Time">
                    {schedule.shift.startTime} – {schedule.shift.endTime}
                  </td>
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
        </div>
        {pageCount > 1 && (
          <div className="schedules-pagination">
            <button type="button" className="outline-button" disabled={pageSafe <= 1} onClick={() => setPage(pageSafe - 1)}>
              Previous
            </button>
            <span>Page {pageSafe} of {pageCount}</span>
            <button type="button" className="outline-button" disabled={pageSafe >= pageCount} onClick={() => setPage(pageSafe + 1)}>
              Next
            </button>
          </div>
        )}
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
                <span>Effective Dates</span>
                <strong>
                  {formatDate(viewSchedule.startsOn)} – {formatDate(viewSchedule.endsOn)}
                </strong>
              </div>
              <div>
                <span>Working Days</span>
                <strong>{formatWorkingDays(viewSchedule.workingDays)}</strong>
              </div>
              <div>
                <span>Status</span>
                <Badge tone={viewSchedule.isActive ? "success" : "neutral"}>
                  {viewSchedule.isActive ? "Active" : "Archived"}
                </Badge>
              </div>
            </div>
            <div className="schedule-detail-actions">
              {canWrite && viewSchedule.isActive && (
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
              {canWrite && (
                viewSchedule.isActive ? (
                  <button
                    type="button"
                    className="schedule-archive-button"
                    onClick={() => requestArchive(viewSchedule)}
                  >
                    <Archive size={14} /> Archive
                  </button>
                ) : (
                  <button
                    type="button"
                    className="outline-button"
                    onClick={() => requestRestore(viewSchedule)}
                  >
                    <RotateCcw size={14} /> Restore
                  </button>
                )
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

                <WorkingDaysDropdown
                  value={editForm.workingDays}
                  onChange={(v) => setEditForm((c) => ({ ...c, workingDays: v }))}
                  required
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
                  disabled={isEditSaving || !editForm.shiftId || !editForm.startsOn || editForm.workingDays.length === 0}
                >
                  {isEditSaving ? "Saving…" : "Save Changes"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {confirmConfig && <ConfirmDialog config={confirmConfig} onCancel={() => setConfirmConfig(null)} />}
    </>
  );
}
