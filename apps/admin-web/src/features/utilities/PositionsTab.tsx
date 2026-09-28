import { useEffect, useMemo, useState } from "react";
import { Archive, Briefcase, Eye, Pencil, Plus, RotateCcw, Search, X } from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { ConfirmDialog, type ConfirmDialogConfig } from "../../components/ui/ConfirmDialog";
import { apiRequest } from "../../lib/api";
import { useActiveDepartments } from "../../lib/departments";
import { type Position, type PositionDepartmentScope, revalidatePositions, usePositions } from "../../lib/positions";
import { PermissionCode, permissions } from "../../types/rbac";
import type { Notification } from "./UtilitiesPage";
import "../employees/EmployeesPage.css";

const PAGE_SIZE = 10;

const SCOPE_OPTIONS: { value: PositionDepartmentScope; label: string }[] = [
  { value: "ALL", label: "All departments" },
  { value: "ALL_EXCEPT", label: "All except…" },
  { value: "ONLY", label: "Only…" },
];

function availabilityLabel(position: Position) {
  const names = position.departments.map((link) => link.department.name).sort().join(", ");
  if (position.departmentScope === "ALL") return "All departments";
  if (position.departmentScope === "ALL_EXCEPT") return names ? `All departments except ${names}` : "All departments";
  return names || "No departments";
}

export function PositionsTab({
  user,
  notify,
}: {
  user?: { permissions: PermissionCode[] };
  notify: (notification: Notification) => void;
}) {
  const canManage = user?.permissions.includes(permissions.departmentsWrite) ?? true;

  const { positions, refresh } = usePositions();
  const { departments } = useActiveDepartments();

  const [showArchivedOnly, setShowArchivedOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Position | null>(null);
  const [title, setTitle] = useState("");
  const [scope, setScope] = useState<PositionDepartmentScope>("ALL");
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const [viewPosition, setViewPosition] = useState<Position | null>(null);
  const [confirmConfig, setConfirmConfig] = useState<ConfirmDialogConfig | null>(null);

  // Fresh copy whenever the tab opens so Employee counts are current.
  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  useEffect(() => setPage(1), [search, showArchivedOnly]);

  const activeCount = positions.filter((position) => position.isActive).length;

  const visiblePositions = useMemo(
    () =>
      positions.filter((position) => {
        if (showArchivedOnly ? position.isActive : !position.isActive) return false;
        if (search.trim() && !position.title.toLowerCase().includes(search.trim().toLowerCase())) return false;
        return true;
      }),
    [positions, showArchivedOnly, search],
  );

  const pageCount = Math.max(1, Math.ceil(visiblePositions.length / PAGE_SIZE));
  const pagedPositions = visiblePositions.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const reload = () => revalidatePositions().catch(() => undefined);

  const openForm = (position: Position | null) => {
    setEditing(position);
    setTitle(position?.title ?? "");
    setScope(position?.departmentScope ?? "ALL");
    setDepartmentIds(position?.departments.map((link) => link.departmentId) ?? []);
    setTitleError(null);
    setViewPosition(null);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
    setTitleError(null);
  };

  const toggleDepartment = (id: string) =>
    setDepartmentIds((current) => (current.includes(id) ? current.filter((d) => d !== id) : [...current, id]));

  const needsDepartments = scope !== "ALL";
  const canSubmit = Boolean(title.trim()) && (!needsDepartments || departmentIds.length > 0);

  const submitForm = async () => {
    const trimmedTitle = title.trim();
    if (!canSubmit) return;
    setIsSaving(true);
    setTitleError(null);
    const body = JSON.stringify({ title: trimmedTitle, departmentScope: scope, departmentIds: needsDepartments ? departmentIds : [] });
    try {
      if (editing) {
        await apiRequest(`/positions/${editing.id}`, { method: "PATCH", body });
        notify({ type: "success", title: "Position Updated", message: `"${trimmedTitle}" position updated.` });
      } else {
        await apiRequest("/positions", { method: "POST", body });
        notify({ type: "success", title: "Position Created", message: `"${trimmedTitle}" position created.` });
      }
      closeForm();
      reload();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save position.";
      if (/already exists/i.test(message)) setTitleError(message);
      else notify({ type: "error", title: "Couldn't Save Position", message });
    } finally {
      setIsSaving(false);
    }
  };

  const setStatus = async (position: Position, isActive: boolean) => {
    try {
      await apiRequest(`/positions/${position.id}/status`, { method: "PATCH", body: JSON.stringify({ isActive }) });
      notify({
        type: "success",
        title: isActive ? "Position Restored" : "Position Archived",
        message: `"${position.title}" ${isActive ? "restored" : "archived"} successfully.`,
      });
      setViewPosition(null);
      reload();
    } catch (err) {
      notify({
        type: "error",
        title: "Couldn't Update Position Status",
        message: err instanceof Error ? err.message : "Unable to update position status.",
      });
    }
  };

  const requestArchive = (position: Position) =>
    setConfirmConfig({
      title: `Archive "${position.title}"?`,
      description:
        position._count.employees > 0
          ? `${position._count.employees} employee(s) currently hold this position. They'll keep it, but it won't be selectable for new employees until restored.`
          : "This position won't be selectable for new employees until restored.",
      confirmLabel: "Archive",
      tone: "danger",
      onConfirm: () => setStatus(position, false),
    });

  const requestRestore = (position: Position) =>
    setConfirmConfig({
      title: `Restore "${position.title}"?`,
      description: "This position will become selectable for new employees again, in the departments it's available in.",
      confirmLabel: "Restore",
      tone: "primary",
      onConfirm: () => setStatus(position, true),
    });

  return (
    <>
      <div className="employees-filter-bar">
        <div className="employees-filter-group">
          <span className="employees-filter-label">View</span>
          <div className="filter-tabs">
            <button className={!showArchivedOnly ? "active" : ""} onClick={() => setShowArchivedOnly(false)}>
              All Positions ({activeCount})
            </button>
          </div>
        </div>

        <div className="employees-filter-group">
          <span className="employees-filter-label">Archive</span>
          <div className="filter-tabs">
            <button className={showArchivedOnly ? "active" : ""} onClick={() => setShowArchivedOnly(true)}>
              Archived Positions
            </button>
          </div>
        </div>

        <div className="employees-filter-group employees-filter-search-group">
          <label className="employees-filter-label">Search</label>
          <div className="employee-search">
            <Search size={14} className="employee-search-icon" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search positions..."
              aria-label="Search positions by name"
            />
            <button type="button" className="employee-search-clear" onClick={() => setSearch("")} aria-label="Clear search">
              <X size={13} />
            </button>
          </div>
        </div>

        <div className="employees-filter-actions">
          {canManage && (
            <button className="add-employee-button" onClick={() => openForm(null)}>
              <Plus size={15} /> Add Position
            </button>
          )}
        </div>
      </div>

      <section className="table-card utilities-table-card">
        <div className="utilities-table-scroll">
          <table>
            <thead>
              <tr>
                <th>POSITION</th>
                <th>EMPLOYEES</th>
                <th>STATUS</th>
                <th>ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {pagedPositions.length === 0 ? (
                <tr>
                  <td colSpan={4} className="utilities-empty-state">
                    {positions.length === 0 ? (
                      <div className="utilities-empty-block">
                        <Briefcase size={28} />
                        <p>No positions have been created yet. Create your first position to begin.</p>
                      </div>
                    ) : (
                      "No positions match your current filters."
                    )}
                  </td>
                </tr>
              ) : (
                pagedPositions.map((position) => (
                  <tr key={position.id}>
                    <td data-label="Position">{position.title}</td>
                    <td data-label="Employees">{position._count.employees}</td>
                    <td data-label="Status">
                      <Badge tone={position.isActive ? "success" : "neutral"}>{position.isActive ? "Active" : "Archived"}</Badge>
                    </td>
                    <td data-label="Actions">
                      <button type="button" className="utilities-view-button" onClick={() => setViewPosition(position)}>
                        <Eye size={13} /> View
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="utilities-pagination utilities-pagination-footer">
          <button className="outline-button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </button>
          <span>Page {page} of {pageCount}</span>
          <button className="outline-button" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>
            Next
          </button>
        </div>
      </section>

      {/* ── Add/Edit Position modal ── */}
      {formOpen && (
        <div className="utilities-modal-backdrop" role="presentation">
          <section className="utilities-modal utilities-modal--sm" role="dialog" aria-modal="true" aria-labelledby="position-form-title">
            <div className="utilities-modal-header">
              <div>
                <h2 id="position-form-title">{editing ? "Edit Position" : "Add Position"}</h2>
                <p>{editing ? "Changes apply immediately" : "New position will be available immediately"}</p>
              </div>
              <button className="icon-button" onClick={closeForm} disabled={isSaving} aria-label="Close">
                <X size={18} />
              </button>
            </div>

            <div className="utilities-modal-body">
              <label className="utilities-field">
                <span className="utilities-field-label">
                  Position Name <span className="utilities-required">*</span>
                </span>
                <input
                  className="utilities-input"
                  type="text"
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    setTitleError(null);
                  }}
                  placeholder="e.g. Senior Manager"
                  autoFocus
                />
                {titleError && <span className="utilities-field-error">{titleError}</span>}
              </label>

              <div className="utilities-field">
                <span className="utilities-field-label">
                  Available In <span className="utilities-required">*</span>
                </span>
                <div className="utilities-segmented">
                  {/* "All except…" is no longer offered; it only still appears
                      when editing a position already saved with that scope. */}
                  {SCOPE_OPTIONS.filter(
                    (option) => option.value !== "ALL_EXCEPT" || editing?.departmentScope === "ALL_EXCEPT",
                  ).map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={scope === option.value ? "active" : ""}
                      onClick={() => setScope(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <span className="utilities-field-hint">
                  {scope === "ALL"
                    ? "Offered in every department, including departments added later."
                    : scope === "ALL_EXCEPT"
                      ? "Offered in every department except the ones checked below, including departments added later."
                      : "Offered only in the departments checked below."}
                </span>
              </div>

              {needsDepartments && (
                <div className="utilities-field">
                  <span className="utilities-field-label">{scope === "ALL_EXCEPT" ? "Except" : "Departments"}</span>
                  <div className="utilities-classification-options">
                    {departments.map((department) => (
                      <label className="utilities-checkbox" key={department.id}>
                        <input
                          type="checkbox"
                          checked={departmentIds.includes(department.id)}
                          onChange={() => toggleDepartment(department.id)}
                        />
                        <span>{department.name}</span>
                      </label>
                    ))}
                  </div>
                  {departmentIds.length === 0 && <span className="utilities-field-error">Select at least one department.</span>}
                </div>
              )}
            </div>

            <div className="utilities-modal-actions">
              <button className="primary-button" onClick={submitForm} disabled={isSaving || !canSubmit}>
                {isSaving ? "Saving…" : editing ? "Save Changes" : "Add Position"}
              </button>
              <button className="outline-button" onClick={closeForm} disabled={isSaving}>
                Cancel
              </button>
            </div>
          </section>
        </div>
      )}

      {/* ── View Position modal ── */}
      {viewPosition && (
        <div className="utilities-modal-backdrop" role="presentation">
          <section className="utilities-modal utilities-modal--sm" role="dialog" aria-modal="true" aria-labelledby="view-position-title">
            <div className="utilities-modal-header">
              <div>
                <h2 id="view-position-title">{viewPosition.title}</h2>
                <p>Position details</p>
              </div>
              <button className="icon-button" onClick={() => setViewPosition(null)} aria-label="Close">
                <X size={18} />
              </button>
            </div>

            <div className="utilities-modal-body">
              <div className="utilities-audit-detail-grid">
                <div>
                  <span>Available In</span>
                  <strong>{availabilityLabel(viewPosition)}</strong>
                </div>
                <div>
                  <span>Employees</span>
                  <strong>{viewPosition._count.employees}</strong>
                </div>
                <div>
                  <span>Status</span>
                  <Badge tone={viewPosition.isActive ? "success" : "neutral"}>{viewPosition.isActive ? "Active" : "Archived"}</Badge>
                </div>
              </div>
            </div>

            <div className="utilities-modal-actions">
              {canManage && (
                <>
                  <button className="utilities-edit-button" onClick={() => openForm(viewPosition)}>
                    <Pencil size={13} /> Edit
                  </button>
                  {viewPosition.isActive ? (
                    <button className="utilities-archive-button" onClick={() => requestArchive(viewPosition)}>
                      <Archive size={13} /> Archive
                    </button>
                  ) : (
                    <button className="utilities-archive-button restore" onClick={() => requestRestore(viewPosition)}>
                      <RotateCcw size={13} /> Restore
                    </button>
                  )}
                </>
              )}
              <button className="outline-button" onClick={() => setViewPosition(null)}>
                Close
              </button>
            </div>
          </section>
        </div>
      )}

      {confirmConfig && <ConfirmDialog config={confirmConfig} onCancel={() => setConfirmConfig(null)} />}
    </>
  );
}
