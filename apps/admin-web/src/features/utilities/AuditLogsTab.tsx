import { useEffect, useState } from "react";
import { ChevronDown, Eye, Filter, FileSpreadsheet, FileText, Printer, X } from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { DropdownFilter } from "../../components/ui/DropdownFilter";
import { apiRequest } from "../../lib/api";
import type { Notification } from "./UtilitiesPage";

type AuditLog = {
  id: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  entityName?: string | null;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
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

type BadgeTone = "neutral" | "success" | "danger" | "warning" | "role";

const MODULE_OPTIONS = [
  { value: "Leave", label: "Leave" },
  { value: "Schedules", label: "Schedules" },
  { value: "Employees", label: "Employees" },
  { value: "Attendance", label: "Attendance" },
];

const AUDIT_PAGE_SIZE = 25;

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
  if (/(CREATE|ADD|APPROVE|RESTORE)/.test(action)) return "success";
  if (/(MARK|UPDATE|EDIT)/.test(action)) return "role";
  return "neutral";
}

function moduleLabel(entityType: string) {
  if (entityType === "LeaveType" || entityType === "LeaveRequest" || entityType === "LeaveBalance") return "Leave";
  if (entityType === "Shift" || entityType === "EmployeeSchedule") return "Schedules";
  if (entityType === "Employee") return "Employees";
  if (entityType === "AttendanceRecord") return "Attendance";
  return entityType;
}

function affectedRecordLabel(log: AuditLog) {
  if (log.entityName) return log.entityName;
  if (log.entityId) return log.entityId.slice(0, 8);
  return "—";
}

// Builds a Field / (Previous /) Value table for the "Changes" section of the
// detail modal — Create actions only have newValues, Update actions have both.
function buildChangeRows(log: AuditLog) {
  const oldValues = log.oldValues ?? {};
  const newValues = log.newValues ?? {};
  const keys = Array.from(new Set([...Object.keys(oldValues), ...Object.keys(newValues)]));
  const stringify = (value: unknown) => (value === undefined ? undefined : JSON.stringify(value).replace(/,/g, ", "));
  return keys.map((key) => {
    const before = (oldValues as Record<string, unknown>)[key];
    const after = (newValues as Record<string, unknown>)[key];
    return {
      key,
      before: stringify(before),
      after: stringify(after),
      changed: log.oldValues != null && JSON.stringify(before) !== JSON.stringify(after),
    };
  });
}

async function exportToExcel(rows: AuditLog[]) {
  const XLSX = await import("xlsx");
  const data = rows.map((log) => ({
    "Date/Time": formatDateTime(log.createdAt),
    Actor: actorName(log),
    Module: moduleLabel(log.entityType),
    Action: formatAction(log.action),
    "Affected Record": affectedRecordLabel(log),
  }));
  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Audit Logs");
  XLSX.writeFile(workbook, `audit-logs-${Date.now()}.xlsx`);
}

async function exportToPdf(rows: AuditLog[]) {
  const { jsPDF } = await import("jspdf");
  const autoTable = (await import("jspdf-autotable")).default;
  const doc = new jsPDF({ orientation: "landscape" });
  doc.setFontSize(14);
  doc.text("Audit Logs", 14, 16);
  autoTable(doc, {
    startY: 22,
    head: [["Date/Time", "Actor", "Module", "Action", "Affected Record"]],
    body: rows.map((log) => [
      formatDateTime(log.createdAt),
      actorName(log),
      moduleLabel(log.entityType),
      formatAction(log.action),
      affectedRecordLabel(log),
    ]),
    styles: { fontSize: 8 },
    headStyles: { fillColor: [26, 58, 92] },
  });
  doc.save(`audit-logs-${Date.now()}.pdf`);
}

export function AuditLogsTab({
  notify,
}: {
  notify: (notification: Notification) => void;
}) {
  const [generatedAt, setGeneratedAt] = useState(() => new Date());
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditPage, setAuditPage] = useState(1);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditLoadingMore, setAuditLoadingMore] = useState(false);
  const [moduleFilter, setModuleFilter] = useState("ALL");
  const [auditSearch, setAuditSearch] = useState("");
  const [auditFrom, setAuditFrom] = useState("");
  const [auditTo, setAuditTo] = useState("");
  const [viewLog, setViewLog] = useState<AuditLog | null>(null);
  const [showRawJson, setShowRawJson] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const hasActiveAuditFilters =
    moduleFilter !== "ALL" ||
    auditSearch.trim() !== "" ||
    auditFrom !== "" ||
    auditTo !== "";

  const buildParams = () => {
    const params = new URLSearchParams();
    if (moduleFilter !== "ALL") params.set("module", moduleFilter);
    if (auditSearch.trim()) params.set("search", auditSearch.trim());
    if (auditFrom) params.set("from", auditFrom);
    if (auditTo) params.set("to", auditTo);
    return params;
  };

  const loadAuditLogs = (page = 1, append = false) => {
    const params = buildParams();
    params.set("page", String(page));
    params.set("pageSize", String(AUDIT_PAGE_SIZE));

    if (append) setAuditLoadingMore(true);
    else setAuditLoading(true);

    apiRequest<AuditLogPage>(`/audit-logs?${params.toString()}`)
      .then((res) => {
        setAuditLogs((current) => (append ? [...current, ...res.items] : res.items));
        setAuditTotal(res.total);
        setAuditPage(res.page);
        setGeneratedAt(new Date());
      })
      .catch(() => undefined)
      .finally(() => {
        if (append) setAuditLoadingMore(false);
        else setAuditLoading(false);
      });
  };

  useEffect(() => {
    loadAuditLogs(1, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleFilter, auditFrom, auditTo]);

  useEffect(() => {
    setShowRawJson(false);
  }, [viewLog]);

  const runExport = async (kind: "excel" | "pdf") => {
    setIsExporting(true);
    try {
      const params = buildParams();
      const rows = await apiRequest<AuditLog[]>(`/audit-logs/export?${params.toString()}`);
      if (kind === "excel") await exportToExcel(rows);
      else await exportToPdf(rows);
      notify({ type: "success", message: `Exported ${rows.length} audit log entries.` });
    } catch (err) {
      notify({ type: "error", message: err instanceof Error ? err.message : "Export failed." });
    } finally {
      setIsExporting(false);
    }
  };

  const changeRows = viewLog ? buildChangeRows(viewLog) : [];
  const hasRawJson = viewLog && (viewLog.oldValues != null || viewLog.newValues != null);

  return (
    <>
      <div className="utilities-toolbar-header">
        <div className="utilities-toolbar-header-left">
          <h3 className="utilities-toolbar-title">Audit Logs</h3>
          <span className="utilities-toolbar-meta">Generated {generatedAt.toLocaleString()}</span>
        </div>
        <div className="utilities-result-count">
          <span>{auditTotal} result{auditTotal !== 1 ? "s" : ""}</span>
        </div>
      </div>

      <div className="utilities-filter-bar">
        <div className="utilities-filter-group">
          <label className="utilities-filter-label">Search</label>
          <input
            type="text"
            value={auditSearch}
            onChange={(e) => setAuditSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") loadAuditLogs(1, false);
            }}
            placeholder="Actor name or email"
            aria-label="Search audit logs by actor"
          />
        </div>

        <div className="utilities-filter-group">
          <label className="utilities-filter-label">Module</label>
          <DropdownFilter
            className="utilities-filter-select"
            value={moduleFilter}
            onChange={setModuleFilter}
            options={MODULE_OPTIONS}
            allLabel="All Modules"
            menuLabel="Filter by module"
            ariaLabel="Filter by module"
          />
        </div>

        <div className="utilities-filter-group">
          <label className="utilities-filter-label">From</label>
          <input type="date" value={auditFrom} onChange={(e) => setAuditFrom(e.target.value)} aria-label="Audit log from date" />
        </div>

        <div className="utilities-filter-group">
          <label className="utilities-filter-label">To</label>
          <input type="date" value={auditTo} onChange={(e) => setAuditTo(e.target.value)} aria-label="Audit log to date" />
        </div>

        <div className="utilities-filter-actions">
          <button className="utilities-generate-button" onClick={() => loadAuditLogs(1, false)}>
            <Filter size={14} />
            <span>Apply</span>
          </button>
          <button className="utilities-export-button" disabled={isExporting} onClick={() => runExport("excel")}>
            <FileSpreadsheet size={14} />
            <span>Excel</span>
          </button>
          <button className="utilities-export-button" disabled={isExporting} onClick={() => runExport("pdf")}>
            <FileText size={14} />
            <span>PDF</span>
          </button>
          <button className="utilities-export-button" onClick={() => window.print()}>
            <Printer size={14} />
            <span>Print</span>
          </button>
        </div>
      </div>

      <section className="table-card utilities-table-card utilities-audit-table">
        <table>
          <thead>
            <tr>
              <th>DATE/TIME</th>
              <th>ACTOR</th>
              <th>MODULE</th>
              <th>ACTION</th>
              <th>AFFECTED RECORD</th>
              <th>DETAILS</th>
            </tr>
          </thead>
          <tbody>
            {auditLoading ? (
              <tr>
                <td colSpan={6} className="utilities-empty-state">
                  <span className="utilities-loading-dot" /> Loading audit logs…
                </td>
              </tr>
            ) : auditLogs.length === 0 ? (
              <tr>
                <td colSpan={6} className="utilities-empty-state">
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
                  <td data-label="Module">{moduleLabel(log.entityType)}</td>
                  <td data-label="Action">
                    <Badge tone={actionTone(log.action)}>{formatAction(log.action)}</Badge>
                  </td>
                  <td data-label="Affected Record">{affectedRecordLabel(log)}</td>
                  <td data-label="Details">
                    <button type="button" className="utilities-view-button" onClick={() => setViewLog(log)}>
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
          <button className="outline-button" onClick={() => loadAuditLogs(auditPage + 1, true)} disabled={auditLoadingMore}>
            {auditLoadingMore ? "Loading…" : "Load More"}
          </button>
        </div>
      )}

      {/* ── Audit log detail modal ── */}
      {viewLog && (
        <div className="utilities-modal-backdrop" role="presentation">
          <section className="utilities-modal" role="dialog" aria-modal="true" aria-labelledby="audit-view-title">
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
              <div className="utilities-audit-section-label">Audit Information</div>
              <div className="utilities-audit-detail-grid">
                <div>
                  <span>Date &amp; Time</span>
                  <strong>{formatDateTime(viewLog.createdAt)}</strong>
                </div>
                <div>
                  <span>Actor</span>
                  <strong>{actorName(viewLog)}</strong>
                </div>
                <div>
                  <span>Module</span>
                  <strong>{moduleLabel(viewLog.entityType)}</strong>
                </div>
                <div>
                  <span>Action</span>
                  <Badge tone={actionTone(viewLog.action)}>{formatAction(viewLog.action)}</Badge>
                </div>
                <div>
                  <span>Affected Record</span>
                  <strong>{affectedRecordLabel(viewLog)}</strong>
                </div>
              </div>

              {changeRows.length > 0 && (
                <>
                  <div className="utilities-audit-section-label">Changes</div>
                  <div className="utilities-audit-diff-table-wrap">
                    <table className="utilities-audit-diff-table">
                      <thead>
                        <tr>
                          <th>Field</th>
                          {viewLog.oldValues != null && <th>Previous Value</th>}
                          <th>{viewLog.oldValues != null ? "New Value" : "Value"}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {changeRows.map((row) => (
                          <tr key={row.key} className={row.changed ? "changed" : ""}>
                            <td>{row.key}</td>
                            {viewLog.oldValues != null && <td>{row.before ?? "—"}</td>}
                            <td>{row.after ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {hasRawJson && (
                <div className="utilities-field">
                  <button
                    type="button"
                    className="utilities-raw-json-toggle"
                    onClick={() => setShowRawJson((v) => !v)}
                  >
                    <ChevronDown size={13} className={showRawJson ? "open" : ""} />
                    {showRawJson ? "Hide raw JSON" : "Show raw JSON"}
                  </button>
                  {showRawJson && (
                    <>
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
                    </>
                  )}
                </div>
              )}

              {changeRows.length === 0 && !hasRawJson && (
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
