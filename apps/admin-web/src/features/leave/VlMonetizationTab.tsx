import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { DropdownFilter } from "../../components/ui/DropdownFilter";
import { NotificationModal, type NotificationConfig } from "../../components/ui/NotificationModal";
import { apiRequest } from "../../lib/api";
import { formatDays } from "../../lib/leaveDays";

type MonetizationRow = {
  employeeId: string;
  employeeNo: string;
  name: string;
  department: string | null;
  remainingDays: number;
  pendingDays: number;
  toMonetizeDays: number;
  monetizedDays: number | null;
  monetizedAt: string | null;
};

type MonetizationList = {
  year: number;
  leaveYearStart: string;
  leaveYearEnd: string;
  maxDays: number;
  // Every leave type ticked "Monetizable" in Edit Leave Type; the rows are
  // for leaveTypeId.
  leaveTypes: { id: string; name: string; maxDays: number }[];
  leaveTypeId: string | null;
  leaveTypeName: string | null;
  rows: MonetizationRow[];
};

export type LeaveYearSettings = {
  resetMonth: number;
  resetDay: number;
  currentLeaveYear: number;
};

const PAGE_SIZE = 10;

export function formatMonthDay(month: number, day: number) {
  return new Date(2025, month - 1, day).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Year-end leave monetization report. Which leave types are paid out, and
// how many days, is a rule on each type (Utilities → Leave Types → Edit →
// "Monetizable"); the payout runs on its own at the leave reset (see
// LeaveMonetizationService.runScheduled). The table shows who was (or will
// be) paid out how many days.
export function VlMonetizationTab({
  year,
  yearPicker,
  settings,
  departmentOptions,
  pagination,
}: {
  year: number;
  yearPicker: React.ReactNode;
  // Shown read-only here; it is edited in Utilities → Leave Types.
  settings: LeaveYearSettings | null;
  // Null for a department-locked Supervisor (the server already scopes them).
  departmentOptions: string[] | null;
  pagination: (page: number, pageCount: number, onChange: (page: number) => void) => React.ReactNode;
}) {
  const [data, setData] = useState<MonetizationList | null>(null);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("ALL");
  // Empty = the server's default (the first monetizable type).
  const [leaveTypeId, setLeaveTypeId] = useState("");
  const [page, setPage] = useState(1);
  const [notification, setNotification] = useState<NotificationConfig>(null);

  async function load() {
    setLoadError("");
    try {
      const typeQuery = leaveTypeId ? `&leaveTypeId=${encodeURIComponent(leaveTypeId)}` : "";
      setData(await apiRequest<MonetizationList>(`/leave-monetization?year=${year}${typeQuery}`));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load VL monetization.");
    }
  }

  useEffect(() => {
    setData(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, leaveTypeId, settings?.resetMonth, settings?.resetDay]);

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (data?.rows ?? []).filter(
      (row) =>
        (departmentFilter === "ALL" || row.department === departmentFilter) &&
        (!term || row.name.toLowerCase().includes(term) || row.employeeNo.toLowerCase().includes(term)),
    );
  }, [data, search, departmentFilter]);

  useEffect(() => setPage(1), [search, departmentFilter, year, leaveTypeId]);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pageCount);
  const pagedRows = rows.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);

  const paid = (data?.rows ?? []).filter((row) => row.monetizedDays !== null);
  const paidDays = paid.reduce((sum, row) => sum + (row.monetizedDays ?? 0), 0);

  return (
    <>
      <NotificationModal notification={notification} onClose={() => setNotification(null)} />

      <div className="leave-table-toolbar accrual-toolbar">
        <div className="leave-search">
          <Search size={14} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search employee name..."
            aria-label="Search VL monetization by employee name"
          />
        </div>
        {departmentOptions && (
          <DropdownFilter
            className="leave-select"
            value={departmentFilter}
            onChange={setDepartmentFilter}
            options={departmentOptions.map((name) => ({ value: name, label: name }))}
            allLabel="All Departments"
            menuLabel="Filter by Department"
            ariaLabel="Filter VL monetization by department"
          />
        )}
        {data && data.leaveTypes.length > 1 && (
          <DropdownFilter
            className="leave-select"
            value={leaveTypeId}
            onChange={setLeaveTypeId}
            // "" is the server's default type, the first one listed.
            options={data.leaveTypes.slice(1).map((type) => ({ value: type.id, label: type.name }))}
            allValue=""
            allLabel={data.leaveTypes[0].name}
            menuLabel="Leave Type"
            ariaLabel="Choose the monetizable leave type"
          />
        )}
        <div className="vl-monetization-year">{yearPicker}</div>
      </div>

      <section className="table-card leave-table-card">
        <div className="leave-table-scroll leave-table-scroll-fixed">
          <table>
            <thead>
              <tr>
                <th>EMPLOYEE</th>
                <th>DEPARTMENT</th>
                <th>REMAINING</th>
                <th>MONETIZED</th>
                <th>STATUS</th>
              </tr>
            </thead>
            <tbody>
              {loadError ? (
                <tr>
                  <td colSpan={5} className="leave-empty-state">{loadError}</td>
                </tr>
              ) : !data ? (
                <tr>
                  <td colSpan={5} className="leave-empty-state">Loading…</td>
                </tr>
              ) : !data.leaveTypeName ? (
                <tr>
                  <td colSpan={5} className="leave-empty-state">
                    No leave type is monetizable yet. Tick "Monetizable" on a leave type in Utilities → Leave Types.
                  </td>
                </tr>
              ) : pagedRows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="leave-empty-state">No employees match your search.</td>
                </tr>
              ) : (
                pagedRows.map((row) => (
                  <tr key={row.employeeId}>
                    <td data-label="Employee">{row.name}</td>
                    <td data-label="Department">{row.department ?? "—"}</td>
                    <td data-label="Remaining">
                      {formatDays(row.remainingDays)}
                      {row.pendingDays > 0 && <small className="vl-monetization-note"> ({formatDays(row.pendingDays)} pending)</small>}
                    </td>
                    <td data-label="Monetized">
                      {row.monetizedDays !== null ? formatDays(row.monetizedDays) : row.toMonetizeDays > 0 ? `${formatDays(row.toMonetizeDays)} (due)` : "—"}
                    </td>
                    <td data-label="Status">
                      {row.monetizedAt ? (
                        <Badge tone="success">{`Monetized ${formatDate(row.monetizedAt)}`}</Badge>
                      ) : row.toMonetizeDays > 0 ? (
                        <Badge tone="warning">Subject for monetization</Badge>
                      ) : (
                        <Badge tone="neutral">No VL left</Badge>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            {data && paid.length > 0 && (
              <tfoot>
                <tr>
                  <td colSpan={3}>Total monetized ({paid.length} employee{paid.length === 1 ? "" : "s"})</td>
                  <td colSpan={2}>{formatDays(paidDays)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        {pagination(pageSafe, pageCount, setPage)}
      </section>
    </>
  );
}

// Opened from Utilities → Leave Types ("Leave Reset").
export function LeaveYearSettingsModal({
  settings,
  onClose,
  onSaved,
}: {
  settings: LeaveYearSettings;
  onClose: () => void;
  onSaved: (settings: LeaveYearSettings) => void;
}) {
  const [resetMonth, setResetMonth] = useState(settings.resetMonth);
  const [resetDay, setResetDay] = useState(settings.resetDay);
  const [error, setError] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  async function save() {
    setError("");
    setIsSaving(true);
    try {
      const next = await apiRequest<LeaveYearSettings>("/leave-settings", {
        method: "PATCH",
        body: JSON.stringify({ resetMonth, resetDay }),
      });
      // PATCH returns the raw row; re-read for the computed leave year.
      onSaved(next.currentLeaveYear ? next : await apiRequest<LeaveYearSettings>("/leave-settings"));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save settings.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="leave-modal-backdrop" role="presentation">
      <section className="leave-modal leave-modal--sm" role="dialog" aria-modal="true" aria-labelledby="leave-year-settings-title">
        <div className="leave-modal-header">
          <div>
            <h2 id="leave-year-settings-title">Leave Reset</h2>
            <p>Leftover leave days are forfeited on the reset date, after monetizable days are paid out.</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close settings">
            <X size={18} />
          </button>
        </div>
        <div className="leave-modal-body vl-settings-body">
          <div className="vl-settings-field">
            <span className="vl-settings-label">Reset all leaves every</span>
            <MonthDayCalendar
              month={resetMonth}
              day={resetDay}
              onChange={(month, day) => {
                setResetMonth(month);
                setResetDay(day);
              }}
            />
            <small>New leave credits start on this day. Leaves dated before it use the old balance.</small>
          </div>
          {error && <p className="vl-settings-error">{error}</p>}
        </div>
        <div className="vl-settings-actions">
          <button type="button" className="outline-button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary-button" disabled={isSaving} onClick={save}>
            {isSaving ? "Saving…" : "Save"}
          </button>
        </div>
      </section>
    </div>
  );
}

// Calendar for the yearly reset date. The setting itself is just a month
// and day (it repeats every year), so this opens on its next occurrence and
// can be paged through any month and year; picking a day saves that day's
// month and day. Feb 29 can't be picked — it only exists every fourth year.
function nextOccurrence(month: number, day: number) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const thisYear = new Date(today.getFullYear(), month - 1, day);
  return thisYear >= today ? thisYear : new Date(today.getFullYear() + 1, month - 1, day);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function MonthDayCalendar({
  month,
  day,
  onChange,
}: {
  month: number;
  day: number;
  onChange: (month: number, day: number) => void;
}) {
  const [view, setView] = useState(() => {
    const next = nextOccurrence(month, day);
    return new Date(next.getFullYear(), next.getMonth(), 1);
  });
  const viewYear = view.getFullYear();
  const viewMonth = view.getMonth() + 1;
  const daysInMonth = new Date(viewYear, viewMonth, 0).getDate();
  const leadingBlanks = view.getDay();

  return (
    <div className="vl-month-day-calendar">
      <div className="vl-month-day-header">
        <button
          type="button"
          className="vl-month-day-nav"
          onClick={() => setView(new Date(viewYear, viewMonth - 2, 1))}
          aria-label="Previous month"
        >
          <ChevronLeft size={16} />
        </button>
        <strong>{view.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</strong>
        <button
          type="button"
          className="vl-month-day-nav"
          onClick={() => setView(new Date(viewYear, viewMonth, 1))}
          aria-label="Next month"
        >
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="vl-month-day-grid">
        {WEEKDAYS.map((label) => (
          <span key={label} className="vl-month-day-weekday">
            {label}
          </span>
        ))}
        {Array.from({ length: leadingBlanks }, (_, index) => (
          <span key={`blank-${index}`} />
        ))}
        {Array.from({ length: daysInMonth }, (_, index) => {
          const value = index + 1;
          const isSelected = viewMonth === month && value === day;
          const isLeapDay = viewMonth === 2 && value === 29;
          return (
            <button
              key={value}
              type="button"
              className={`vl-month-day-cell${isSelected ? " is-selected" : ""}`}
              onClick={() => onChange(viewMonth, value)}
              disabled={isLeapDay}
              title={isLeapDay ? "Feb 29 only exists every fourth year." : undefined}
              aria-pressed={isSelected}
            >
              {value}
            </button>
          );
        })}
      </div>
      <p className="vl-month-day-selected">
        Resets every <strong>{formatMonthDay(month, day)}</strong>
      </p>
    </div>
  );
}
