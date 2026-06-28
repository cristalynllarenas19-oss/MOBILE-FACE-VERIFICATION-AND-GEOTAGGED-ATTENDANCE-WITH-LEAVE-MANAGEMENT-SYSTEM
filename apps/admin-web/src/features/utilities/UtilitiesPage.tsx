import { useEffect, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  Eye,
  History,
  Plus,
  Search,
  X,
} from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { DropdownFilter } from "../../components/ui/DropdownFilter";
import { apiRequest } from "../../lib/api";
import { PermissionCode, permissions } from "../../types/rbac";
import "./UtilitiesPage.css";

type EmploymentStatus = "REGULAR" | "PROBATIONARY" | "CONTRACTUAL" | "SEPARATED";

type LeaveType = {
  id: string;
  name: string;
  defaultDays: string;
  requiresDocument: boolean;
  applicableStatuses: EmploymentStatus[];
};

type Shift = {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  gracePeriodMinutes: number;
};

type AuditLog = {
  id: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  oldValues?: unknown;
  newValues?: unknown;
  createdAt: string;
  actor?: {
    email: string;
    employee?: { firstName: string; lastName: string } | null;
  } | null;
};

type AuditLogPage = {
  items: AuditLog[];
  total: number;
  page: number;
  pageSize: number;
};

type Notification = { type: "success" | "error"; message: string } | null;
type UtilTab = "leave-types" | "shifts" | "audit-logs";
type BadgeTone = "neutral" | "success" | "danger" | "warning" | "role";

const ENTITY_TYPE_OPTIONS = [
  { value: "LeaveRequest", label: "Leave Requests" },
  { value: "LeaveType", label: "Leave Types" },
  { value: "AttendanceRecord", label: "Attendance Records" },
  { value: "Employee", label: "Employees" },
  { value: "Shift", label: "Shifts" },
];

const EMPLOYMENT_STATUS_OPTIONS: { value: EmploymentStatus; label: string }[] = [
  { value: "REGULAR", label: "Regular" },
  { value: "PROBATIONARY", label: "Probationary" },
  { value: "CONTRACTUAL", label: "Contractual" },
  { value: "SEPARATED", label: "Separated" },
];

// Every leave type always includes Regular — admins only choose which of these
// additional classifications also get it.
const OPTIONAL_STATUS_OPTIONS = EMPLOYMENT_STATUS_OPTIONS.filter((o) => o.value !== "REGULAR");

const EMPLOYMENT_STATUS_COLORS: Record<EmploymentStatus, string> = {
  REGULAR: "#2979d0",
  PROBATIONARY: "#d97706",
  CONTRACTUAL: "#7c3aed",
  SEPARATED: "#94a3b8",
};

function formatEmploymentStatus(status: EmploymentStatus) {
  return status.charAt(0) + status.slice(1).toLowerCase();
}

function formatDefaultDays(type: LeaveType) {
  return type.name.trim().toLowerCase() === "sick leave" ? "As needed" : type.defaultDays;
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString();
}

function formatAction(action: string) {
  return action.replace(/_/g, " ");
}

function actorName(log: AuditLog) {
  if (!log.actor) return "System";
  if (log.actor.employee) return `${log.actor.employee.firstName} ${log.actor.employee.lastName}`;
  return log.actor.email;
}

function actionTone(action: string): BadgeTone {
  if (/(REJECT|ARCHIVE|DELETE|REMOVE)/.test(action)) return "danger";
  if (/(APPROVE|CREATE|ADD)/.test(action)) return "success";
  if (/(MARK|UPDATE|EDIT)/.test(action)) return "role";
  return "neutral";
}

function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(intervalId);
  }, []);
  return now;
}

function formatTodayLabel(date: Date) {
  return date.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

const AUDIT_PAGE_SIZE = 25;

export function UtilitiesPage({ user }: { user?: { permissions: PermissionCode[] } }) {
  const canManageShifts = user?.permissions.includes(permissions.schedulesWrite) ?? true;
  const [tab, setTab] = useState<UtilTab>("leave-types");
  const [notification, setNotification] = useState<Notification>(null);
  const now = useNow();

  // ── Leave types ──
  const [leaveTypes, setLeaveTypes] = useState<LeaveType[]>([]);
  const [showAddType, setShowAddType] = useState(false);
  const [newTypeName, setNewTypeName] = useState("");
  const [newTypeDays, setNewTypeDays] = useState("15");
  const [newTypeDoc, setNewTypeDoc] = useState(false);
  const [newTypeClassifications, setNewTypeClassifications] = useState<EmploymentStatus[]>([]);
  const [isAddingType, setIsAddingType] = useState(false);
  const [leaveTypeClassificationFilter, setLeaveTypeClassificationFilter] = useState("ALL");
  const [viewLeaveType, setViewLeaveType] = useState<LeaveType | null>(null);

  // ── Shifts ──
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [showAddShift, setShowAddShift] = useState(false);
  const [shiftForm, setShiftForm] = useState({ name: "", startTime: "", endTime: "", gracePeriodMinutes: "0" });
  const [isAddingShift, setIsAddingShift] = useState(false);
  const [shiftSearch, setShiftSearch] = useState("");

  // ── Audit logs ──
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditPage, setAuditPage] = useState(1);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditLoadingMore, setAuditLoadingMore] = useState(false);
  const [entityTypeFilter, setEntityTypeFilter] = useState("ALL");
  const [auditSearch, setAuditSearch] = useState("");
  const [auditFrom, setAuditFrom] = useState("");
  const [auditTo, setAuditTo] = useState("");
  const [viewLog, setViewLog] = useState<AuditLog | null>(null);

  const hasActiveAuditFilters =
    entityTypeFilter !== "ALL" || auditSearch.trim() !== "" || auditFrom !== "" || auditTo !== "";

  const loadLeaveTypes = () => {
    apiRequest<LeaveType[]>("/leave-types").then(setLeaveTypes).catch(() => undefined);
  };

  const loadShifts = () => {
    apiRequest<Shift[]>("/schedules/shifts").then(setShifts).catch(() => undefined);
  };

  const loadAuditLogs = (page = 1, append = false) => {
    const params = new URLSearchParams();
    if (entityTypeFilter !== "ALL") params.set("entityType", entityTypeFilter);
    if (auditSearch.trim()) params.set("search", auditSearch.trim());
    if (auditFrom) params.set("from", auditFrom);
    if (auditTo) params.set("to", auditTo);
    params.set("page", String(page));
    params.set("pageSize", String(AUDIT_PAGE_SIZE));

    if (append) setAuditLoadingMore(true);
    else setAuditLoading(true);

    apiRequest<AuditLogPage>(`/audit-logs?${params.toString()}`)
      .then((res) => {
        setAuditLogs((current) => (append ? [...current, ...res.items] : res.items));
        setAuditTotal(res.total);
        setAuditPage(res.page);
      })
      .catch(() => undefined)
      .finally(() => {
        if (append) setAuditLoadingMore(false);
        else setAuditLoading(false);
      });
  };

  useEffect(loadLeaveTypes, []);
  useEffect(loadShifts, []);

  useEffect(() => {
    if (tab === "audit-logs") loadAuditLogs(1, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, entityTypeFilter, auditFrom, auditTo]);

  useEffect(() => {
    if (!notification) return;
    const id = window.setTimeout(() => setNotification(null), 3500);
    return () => window.clearTimeout(id);
  }, [notification]);

  const addLeaveType = async () => {
    const name = newTypeName.trim();
    if (!name || !newTypeDays) return;
    setIsAddingType(true);
    try {
      await apiRequest("/leave-types", {
        method: "POST",
        body: JSON.stringify({
          name,
          defaultDays: Number(newTypeDays),
          requiresDocument: newTypeDoc,
          applicableStatuses: ["REGULAR", ...newTypeClassifications],
        }),
      });
      closeAddTypeModal();
      setNotification({ type: "success", message: `"${name}" leave type added.` });
      loadLeaveTypes();
    } catch (err) {
      setNotification({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to add leave type.",
      });
    } finally {
      setIsAddingType(false);
    }
  };

  const closeAddTypeModal = () => {
    setShowAddType(false);
    setNewTypeName("");
    setNewTypeDays("15");
    setNewTypeDoc(false);
    setNewTypeClassifications([]);
  };

  const createShift = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsAddingShift(true);
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
      setShifts((current) =>
        [...current, created].sort((a, b) => a.startTime.localeCompare(b.startTime))
      );
      setShiftForm({ name: "", startTime: "", endTime: "", gracePeriodMinutes: "0" });
      setShowAddShift(false);
      setNotification({ type: "success", message: `"${created.name}" shift added successfully.` });
    } catch (err) {
      setNotification({
        type: "error",
        message: err instanceof Error ? err.message : "Unable to add shift.",
      });
    } finally {
      setIsAddingShift(false);
    }
  };

  const visibleLeaveTypes =
    leaveTypeClassificationFilter === "ALL"
      ? leaveTypes
      : leaveTypes.filter((type) => type.applicableStatuses.includes(leaveTypeClassificationFilter as EmploymentStatus));

  const visibleShifts = shifts.filter(
    (shift) => !shiftSearch.trim() || shift.name.toLowerCase().includes(shiftSearch.trim().toLowerCase())
  );

  return (
    <>
      {notification && (
        <div className={`utilities-notification ${notification.type}`} role="status">
          {notification.type === "success" ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
          <span>{notification.message}</span>
        </div>
      )}

      <div className="filter-tabs utilities-tabs">
        <button className={tab === "leave-types" ? "active" : ""} onClick={() => setTab("leave-types")}>
          <ClipboardList size={14} /> Leave Types
        </button>
        <button className={tab === "shifts" ? "active" : ""} onClick={() => setTab("shifts")}>
          <CalendarClock size={14} /> Shifts
        </button>
        <button className={tab === "audit-logs" ? "active" : ""} onClick={() => setTab("audit-logs")}>
          <History size={14} /> Audit Logs
        </button>
      </div>

      {tab === "leave-types" && (
        <>
          <div className="utilities-section-header">
            <h3>Leave Types</h3>
            <div className="utilities-section-header-controls">
              <DropdownFilter
                className="utilities-select"
                value={leaveTypeClassificationFilter}
                onChange={setLeaveTypeClassificationFilter}
                options={EMPLOYMENT_STATUS_OPTIONS}
                allLabel="All Classifications"
                menuLabel="Filter by classification"
                ariaLabel="Filter leave types by classification"
              />
              <button className="primary-button" onClick={() => setShowAddType(true)}>
                <Plus size={15} /> Add Leave Type
              </button>
            </div>
          </div>

          <section className="table-card utilities-table-card">
            <table>
              <thead>
                <tr>
                  <th>NAME</th>
                  <th>DEFAULT DAYS/YEAR</th>
                  <th>REQUIRES DOCUMENT</th>
                  <th>ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                {visibleLeaveTypes.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="utilities-empty-state">
                      {leaveTypes.length === 0
                        ? "No leave types configured."
                        : "No leave types match this classification."}
                    </td>
                  </tr>
                ) : (
                  visibleLeaveTypes.map((type) => (
                    <tr key={type.id}>
                      <td data-label="Name">{type.name}</td>
                      <td data-label="Default Days/Year">{formatDefaultDays(type)}</td>
                      <td data-label="Requires Document">
                        <Badge tone={type.requiresDocument ? "warning" : "neutral"}>
                          {type.requiresDocument ? "Required" : "Not required"}
                        </Badge>
                      </td>
                      <td data-label="Actions">
                        <button
                          type="button"
                          className="utilities-view-button"
                          onClick={() => setViewLeaveType(type)}
                        >
                          <Eye size={13} /> View
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

      {tab === "shifts" && (
        <>
          <div className="utilities-section-header">
            <h3>Shifts</h3>
            <div className="utilities-section-header-controls">
              <div className="utilities-search">
                <Search size={14} />
                <input
                  type="text"
                  value={shiftSearch}
                  onChange={(e) => setShiftSearch(e.target.value)}
                  placeholder="Search shift by name…"
                  aria-label="Search shifts by name"
                />
              </div>
              {canManageShifts && (
                <button className="primary-button" onClick={() => setShowAddShift(true)}>
                  <Plus size={15} /> Add Shift
                </button>
              )}
            </div>
          </div>

          <section className="table-card utilities-table-card">
            <table>
              <thead>
                <tr>
                  <th>NAME</th>
                  <th>TIME</th>
                  <th>GRACE PERIOD</th>
                </tr>
              </thead>
              <tbody>
                {visibleShifts.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="utilities-empty-state">
                      {shifts.length === 0 ? "No shifts configured." : "No shifts match your search."}
                    </td>
                  </tr>
                ) : (
                  visibleShifts.map((shift) => (
                    <tr key={shift.id}>
                      <td data-label="Name">{shift.name}</td>
                      <td data-label="Time">{shift.startTime} – {shift.endTime}</td>
                      <td data-label="Grace Period">{shift.gracePeriodMinutes} min</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </section>
        </>
      )}

      {tab === "audit-logs" && (
        <>
          <div className="utilities-section-header">
            <h3>Audit Logs</h3>
            <span className="utilities-today-badge">{formatTodayLabel(now)}</span>
          </div>

          <div className="utilities-audit-toolbar">
            <div className="utilities-search">
              <Search size={14} />
              <input
                type="text"
                value={auditSearch}
                onChange={(e) => setAuditSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") loadAuditLogs(1, false);
                }}
                placeholder="Search by actor name or email…"
                aria-label="Search audit logs by actor"
              />
            </div>

            <DropdownFilter
              className="utilities-select"
              value={entityTypeFilter}
              onChange={setEntityTypeFilter}
              options={ENTITY_TYPE_OPTIONS}
              allLabel="All Entity Types"
              menuLabel="Filter by entity type"
              ariaLabel="Filter by entity type"
            />

            <input
              type="date"
              value={auditFrom}
              onChange={(e) => setAuditFrom(e.target.value)}
              aria-label="Audit log from date"
            />
            <input
              type="date"
              value={auditTo}
              onChange={(e) => setAuditTo(e.target.value)}
              aria-label="Audit log to date"
            />
            <button className="outline-button" onClick={() => loadAuditLogs(1, false)}>
              Apply
            </button>

            <span className="utilities-audit-count">
              Showing {auditLogs.length} of {auditTotal} entries
            </span>
          </div>

          <section className="table-card utilities-table-card utilities-audit-table">
            <table>
              <thead>
                <tr>
                  <th>DATE/TIME</th>
                  <th>ACTOR</th>
                  <th>ACTION</th>
                  <th>ENTITY</th>
                  <th>DETAILS</th>
                </tr>
              </thead>
              <tbody>
                {auditLoading ? (
                  <tr>
                    <td colSpan={5} className="utilities-empty-state">
                      <span className="utilities-loading-dot" /> Loading audit logs…
                    </td>
                  </tr>
                ) : auditLogs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="utilities-empty-state">
                      {hasActiveAuditFilters
                        ? "No audit log entries match your current filters."
                        : "No audit log entries found."}
                    </td>
                  </tr>
                ) : (
                  auditLogs.map((log) => (
                    <tr key={log.id}>
                      <td data-label="Date/Time">{formatDateTime(log.createdAt)}</td>
                      <td data-label="Actor">{actorName(log)}</td>
                      <td data-label="Action">
                        <Badge tone={actionTone(log.action)}>{formatAction(log.action)}</Badge>
                      </td>
                      <td data-label="Entity">
                        {log.entityType}
                        {log.entityId && (
                          <>
                            {" · "}
                            <button
                              type="button"
                              className="utilities-entity-link"
                              onClick={() => setViewLog(log)}
                              title="View full audit log details"
                            >
                              {log.entityId.slice(0, 8)}
                            </button>
                          </>
                        )}
                      </td>
                      <td data-label="Details">
                        <button
                          type="button"
                          className="utilities-view-button"
                          onClick={() => setViewLog(log)}
                        >
                          <Eye size={13} /> View
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </section>

          {!auditLoading && auditLogs.length < auditTotal && (
            <div className="utilities-load-more">
              <button
                className="outline-button"
                onClick={() => loadAuditLogs(auditPage + 1, true)}
                disabled={auditLoadingMore}
              >
                {auditLoadingMore ? "Loading…" : "Load More"}
              </button>
            </div>
          )}
        </>
      )}

      {/* ── Add Leave Type modal ── */}
      {showAddType && (
        <div className="utilities-modal-backdrop" role="presentation">
          <section
            className="utilities-modal utilities-modal--sm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-type-title"
          >
            <div className="utilities-modal-header">
              <div>
                <h2 id="add-type-title">Add Leave Type</h2>
                <p>New type will be available immediately</p>
              </div>
              <button className="icon-button" onClick={closeAddTypeModal} aria-label="Close">
                <X size={18} />
              </button>
            </div>

            <div className="utilities-modal-body">
              <label className="utilities-field">
                <span className="utilities-field-label">
                  Leave Type Name <span className="utilities-required">*</span>
                </span>
                <input
                  className="utilities-input"
                  type="text"
                  value={newTypeName}
                  onChange={(e) => setNewTypeName(e.target.value)}
                  placeholder="e.g. Emergency Leave"
                  autoFocus
                />
              </label>

              <label className="utilities-field">
                <span className="utilities-field-label">
                  Default Days per Year <span className="utilities-required">*</span>
                </span>
                <input
                  className="utilities-input"
                  type="number"
                  min={1}
                  value={newTypeDays}
                  onChange={(e) => setNewTypeDays(e.target.value)}
                />
              </label>

              <label className="utilities-checkbox">
                <input
                  type="checkbox"
                  checked={newTypeDoc}
                  onChange={(e) => setNewTypeDoc(e.target.checked)}
                />
                <span>Requires supporting document</span>
              </label>

              <div className="utilities-field">
                <span className="utilities-field-label">Applicable Classifications</span>
                <div className="utilities-classification-options">
                  <label className="utilities-checkbox utilities-checkbox--locked">
                    <input type="checkbox" checked readOnly disabled />
                    <span>Regular (always included)</span>
                  </label>
                  {OPTIONAL_STATUS_OPTIONS.map((option) => (
                    <label className="utilities-checkbox" key={option.value}>
                      <input
                        type="checkbox"
                        checked={newTypeClassifications.includes(option.value)}
                        onChange={(e) =>
                          setNewTypeClassifications((current) =>
                            e.target.checked
                              ? [...current, option.value]
                              : current.filter((status) => status !== option.value)
                          )
                        }
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="utilities-modal-actions">
              <button
                className="primary-button"
                onClick={addLeaveType}
                disabled={isAddingType || !newTypeName.trim() || !newTypeDays}
              >
                {isAddingType ? "Saving…" : "Add Leave Type"}
              </button>
              <button className="outline-button" onClick={closeAddTypeModal} disabled={isAddingType}>
                Cancel
              </button>
            </div>
          </section>
        </div>
      )}

      {/* ── View Leave Type modal ── */}
      {viewLeaveType && (
        <div className="utilities-modal-backdrop" role="presentation">
          <section
            className="utilities-modal utilities-modal--sm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="view-type-title"
          >
            <div className="utilities-modal-header">
              <div>
                <h2 id="view-type-title">{viewLeaveType.name}</h2>
                <p>Leave type details</p>
              </div>
              <button className="icon-button" onClick={() => setViewLeaveType(null)} aria-label="Close">
                <X size={18} />
              </button>
            </div>

            <div className="utilities-modal-body">
              <div className="utilities-audit-detail-grid">
                <div>
                  <span>Default Days/Year</span>
                  <strong>{formatDefaultDays(viewLeaveType)}</strong>
                </div>
                <div>
                  <span>Requires Document</span>
                  <Badge tone={viewLeaveType.requiresDocument ? "warning" : "neutral"}>
                    {viewLeaveType.requiresDocument ? "Required" : "Not required"}
                  </Badge>
                </div>
              </div>

              <div className="utilities-field">
                <span className="utilities-field-label">Applicable Classifications</span>
                <div className="utilities-classification-chips">
                  {viewLeaveType.applicableStatuses.map((status) => (
                    <span
                      key={status}
                      className="utilities-classification-chip"
                      style={{
                        color: EMPLOYMENT_STATUS_COLORS[status],
                        borderColor: `${EMPLOYMENT_STATUS_COLORS[status]}55`,
                        background: `${EMPLOYMENT_STATUS_COLORS[status]}15`,
                      }}
                    >
                      {formatEmploymentStatus(status)}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="utilities-modal-actions">
              <button className="outline-button" onClick={() => setViewLeaveType(null)}>
                Close
              </button>
            </div>
          </section>
        </div>
      )}

      {/* ── Add Shift modal ── */}
      {canManageShifts && showAddShift && (
        <div className="utilities-modal-backdrop" role="presentation">
          <section
            className="utilities-modal utilities-modal--sm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-shift-title"
          >
            <div className="utilities-modal-header">
              <div>
                <h2 id="add-shift-title">Create Shift</h2>
                <p>New shift will be available to assign immediately</p>
              </div>
              <button className="icon-button" onClick={() => setShowAddShift(false)} aria-label="Close">
                <X size={18} />
              </button>
            </div>

            <form onSubmit={createShift}>
              <div className="utilities-modal-body">
                <label className="utilities-field">
                  <span className="utilities-field-label">
                    Shift Name <span className="utilities-required">*</span>
                  </span>
                  <input
                    className="utilities-input"
                    type="text"
                    value={shiftForm.name}
                    onChange={(e) => setShiftForm((c) => ({ ...c, name: e.target.value }))}
                    placeholder="e.g. Morning Shift"
                    required
                    autoFocus
                  />
                </label>

                <div className="utilities-field-row">
                  <label className="utilities-field">
                    <span className="utilities-field-label">
                      Start Time <span className="utilities-required">*</span>
                    </span>
                    <input
                      className="utilities-input"
                      type="time"
                      value={shiftForm.startTime}
                      onChange={(e) => setShiftForm((c) => ({ ...c, startTime: e.target.value }))}
                      required
                    />
                  </label>
                  <label className="utilities-field">
                    <span className="utilities-field-label">
                      End Time <span className="utilities-required">*</span>
                    </span>
                    <input
                      className="utilities-input"
                      type="time"
                      value={shiftForm.endTime}
                      onChange={(e) => setShiftForm((c) => ({ ...c, endTime: e.target.value }))}
                      required
                    />
                  </label>
                </div>

                <label className="utilities-field">
                  <span className="utilities-field-label">Grace Period (minutes)</span>
                  <input
                    className="utilities-input"
                    type="number"
                    min="0"
                    value={shiftForm.gracePeriodMinutes}
                    onChange={(e) => setShiftForm((c) => ({ ...c, gracePeriodMinutes: e.target.value }))}
                    placeholder="0"
                  />
                  <span className="utilities-hint">How many minutes late is still considered on time</span>
                </label>
              </div>

              <div className="utilities-modal-actions">
                <button
                  type="submit"
                  className="primary-button"
                  disabled={isAddingShift || !shiftForm.name.trim() || !shiftForm.startTime || !shiftForm.endTime}
                >
                  {isAddingShift ? "Saving…" : "Create Shift"}
                </button>
                <button
                  type="button"
                  className="outline-button"
                  onClick={() => setShowAddShift(false)}
                  disabled={isAddingShift}
                >
                  Cancel
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {/* ── Audit log detail modal ── */}
      {viewLog && (
        <div className="utilities-modal-backdrop" role="presentation">
          <section
            className="utilities-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="audit-view-title"
          >
            <div className="utilities-modal-header">
              <div>
                <h2 id="audit-view-title">Audit Log Detail</h2>
                <p>{formatDateTime(viewLog.createdAt)}</p>
              </div>
              <button className="icon-button" onClick={() => setViewLog(null)} aria-label="Close">
                <X size={18} />
              </button>
            </div>

            <div className="utilities-modal-body">
              <div className="utilities-audit-detail-grid">
                <div>
                  <span>Actor</span>
                  <strong>{actorName(viewLog)}</strong>
                </div>
                <div>
                  <span>Action</span>
                  <Badge tone={actionTone(viewLog.action)}>{formatAction(viewLog.action)}</Badge>
                </div>
                <div>
                  <span>Entity Type</span>
                  <strong>{viewLog.entityType}</strong>
                </div>
                <div>
                  <span>Entity ID</span>
                  <strong>{viewLog.entityId ?? "—"}</strong>
                </div>
              </div>

              {viewLog.oldValues != null && (
                <div className="utilities-audit-json-block">
                  <span className="utilities-field-label">Previous Values</span>
                  <pre>{JSON.stringify(viewLog.oldValues, null, 2)}</pre>
                </div>
              )}

              {viewLog.newValues != null && (
                <div className="utilities-audit-json-block">
                  <span className="utilities-field-label">New Values</span>
                  <pre>{JSON.stringify(viewLog.newValues, null, 2)}</pre>
                </div>
              )}

              {viewLog.oldValues == null && viewLog.newValues == null && (
                <p className="utilities-hint">No additional details were recorded for this entry.</p>
              )}
            </div>

            <div className="utilities-modal-actions">
              <button className="outline-button" onClick={() => setViewLog(null)}>
                Close
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
