import { useEffect, useState } from "react";
import { Search, X } from "lucide-react";
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
  ipAddress?: string | null;
  createdAt: string;
  actor?: {
    email: string;
    employee?: { firstName: string; lastName: string } | null;
    userRoles?: { role: { name: string; code: string } }[];
  } | null;
};

type AuditLogPage = {
  items: AuditLog[];
  total: number;
  page: number;
  pageSize: number;
};

const AUDIT_PAGE_SIZE = 25;

function formatDateTime(value: string) {
  return new Date(value).toLocaleString();
}

function formatAction(action: string) {
  return action
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function moduleLabel(entityType: string) {
  if (entityType === "User" || entityType === "UserRole" || entityType === "RolePermission") return "Users";
  if (entityType === "LeaveType" || entityType === "LeaveRequest" || entityType === "LeaveBalance") return "Leave";
  if (entityType === "Shift" || entityType === "EmployeeSchedule") return "Schedules";
  if (entityType === "Employee") return "Employees";
  if (entityType === "AttendanceRecord") return "Attendance";
  if (entityType === "FaceProfile" || entityType === "FaceVerification") return "Face Verification";
  if (entityType === "WorkLocation" || entityType === "WorkLocationEmployee") return "Geotagging";
  return entityType;
}

function auditMeta(log: AuditLog) {
  return (((log.newValues as any)?._audit ?? (log.oldValues as any)?._audit ?? {}) as {
    module?: string;
    description?: string;
    actorRole?: string;
    userAgent?: string;
  });
}

function actorRoleLabel(log: AuditLog) {
  const metaRole = auditMeta(log).actorRole;
  if (metaRole) return formatAction(metaRole);
  const roles = log.actor?.userRoles?.map((userRole) => userRole.role.name || formatAction(userRole.role.code)) ?? [];
  return roles.length > 0 ? roles.join(", ") : "N/A";
}

export function AuditLogsTab({
  notify,
}: {
  notify: (notification: Notification) => void;
}) {
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditPage, setAuditPage] = useState(1);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditLoadingMore, setAuditLoadingMore] = useState(false);
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest">("newest");
  const [auditSearch, setAuditSearch] = useState("");
  const [auditFrom, setAuditFrom] = useState("");
  const [auditTo, setAuditTo] = useState("");

  const hasActiveAuditFilters =
    auditSearch.trim() !== "" ||
    auditFrom !== "" ||
    auditTo !== "";

  const buildParams = () => {
    const params = new URLSearchParams();
    params.set("sort", sortOrder);
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
  }, [sortOrder, auditFrom, auditTo]);

  const clearAuditSearch = () => {
    setAuditSearch("");
    loadAuditLogs(1, false);
  };

  return (
    <>
      <div className="utilities-toolbar-header">
        <div className="utilities-toolbar-header-left">
          <h3 className="utilities-toolbar-title">Audit Logs</h3>
        </div>
      </div>

      <div className="utilities-filter-bar utilities-audit-filter-bar">
        <div className="utilities-filter-group utilities-audit-search-group">
          <label className="utilities-filter-label">Search</label>
          <div className="utilities-search-input-wrap">
            <Search size={14} className="utilities-search-icon" />
            <input
              type="text"
              value={auditSearch}
              onChange={(e) => setAuditSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") loadAuditLogs(1, false);
              }}
              placeholder="User, employee, action, module, or description"
              aria-label="Search audit logs"
            />
            {auditSearch && (
              <button
                type="button"
                className="utilities-search-clear"
                onClick={clearAuditSearch}
                aria-label="Clear search"
              >
                <X size={13} />
              </button>
            )}
          </div>
        </div>

        <div className="utilities-filter-group">
          <label className="utilities-filter-label">Sort</label>
          <DropdownFilter
            className="utilities-filter-select"
            value={sortOrder}
            onChange={(value) => setSortOrder(value as "newest" | "oldest")}
            options={[{ value: "newest", label: "Newest first" }, { value: "oldest", label: "Oldest first" }]}
            allLabel="Sort"
            menuLabel="Sort audit logs"
            ariaLabel="Sort audit logs"
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
      </div>

      <section className="table-card utilities-table-card utilities-audit-table">
        <div className="utilities-table-scroll">
          <table>
            <thead>
              <tr>
                <th>DATE/TIME</th>
                <th>ROLE</th>
                <th>MODULE</th>
                <th>DESCRIPTION</th>
              </tr>
            </thead>
            <tbody>
              {auditLoading ? (
                <tr>
                  <td colSpan={4} className="utilities-empty-state">
                    <span className="utilities-loading-dot" /> Loading audit logs…
                  </td>
                </tr>
              ) : auditLogs.length === 0 ? (
                <tr>
                  <td colSpan={4} className="utilities-empty-state">
                    {hasActiveAuditFilters
                      ? "No audit log entries match your current filters."
                      : "No audit log entries found."}
                  </td>
                </tr>
              ) : (
                auditLogs.map((log) => (
                  <tr key={log.id}>
                    <td data-label="Date/Time">{formatDateTime(log.createdAt)}</td>
                    <td data-label="Role">{actorRoleLabel(log)}</td>
                    <td data-label="Module">{moduleLabel(log.entityType)}</td>
                    {/* What was done, spelled out right in the row — the
                        recorded description, or the bare action name for an
                        entry logged without one. */}
                    <td data-label="Description" className="utilities-audit-action">
                      {auditMeta(log).description ?? formatAction(log.action)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {auditTotal > AUDIT_PAGE_SIZE && (
          <div className="utilities-pagination utilities-pagination-footer">
            <button className="outline-button" onClick={() => loadAuditLogs(auditPage - 1, false)} disabled={auditLoadingMore || auditPage <= 1}>
              Previous
            </button>
            <span>Page {auditPage} of {Math.max(1, Math.ceil(auditTotal / AUDIT_PAGE_SIZE))}</span>
            <button className="outline-button" onClick={() => loadAuditLogs(auditPage + 1, false)} disabled={auditLoadingMore || auditPage >= Math.ceil(auditTotal / AUDIT_PAGE_SIZE)}>
              Next
            </button>
          </div>
        )}
      </section>
    </>
  );
}
