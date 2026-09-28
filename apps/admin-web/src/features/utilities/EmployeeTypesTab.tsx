import { useEffect, useMemo, useState } from "react";
import { Archive, Eye, IdCard, Pencil, Plus, RotateCcw, Search, X } from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { ConfirmDialog, type ConfirmDialogConfig } from "../../components/ui/ConfirmDialog";
import { apiRequest } from "../../lib/api";
import {
  type EmployeeType,
  revalidateEmployeeTypes,
  useEmployeeTypes,
} from "../../lib/employeeTypes";
import { PermissionCode, permissions } from "../../types/rbac";
import type { Notification } from "./UtilitiesPage";
import "../employees/EmployeesPage.css";

const PAGE_SIZE = 10;

// Regular and Permanent Seasonal types get leave; the rest don't.
function isEntitledToLeave(type: EmployeeType) {
  return type.employmentStatus === "REGULAR" || type.employmentStatus === "PERMANENT_SEASONAL";
}

function isSeasonal(type: EmployeeType) {
  return type.employmentStatus === "PERMANENT_SEASONAL" || type.employmentStatus === "PROBATIONARY_SEASONAL";
}

export function EmployeeTypesTab({
  user,
  notify,
}: {
  user?: { permissions: PermissionCode[] };
  notify: (notification: Notification) => void;
}) {
  // departments:write is the fallback so an admin whose session predates the
  // employee-types:write permission still sees the buttons (the backend
  // checks the live permission on every request anyway).
  const canManage =
    user?.permissions.some((code) => code === permissions.employeeTypesWrite || code === permissions.departmentsWrite) ?? true;

  const { all: employeeTypes, refresh } = useEmployeeTypes();

  const [showArchivedOnly, setShowArchivedOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<"create" | "edit">("create");
  const [editing, setEditing] = useState<EmployeeType | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [entitledToLeave, setEntitledToLeave] = useState(true);
  const [nameError, setNameError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const [viewType, setViewType] = useState<EmployeeType | null>(null);
  const [confirmConfig, setConfirmConfig] = useState<ConfirmDialogConfig | null>(null);

  // Always pull a fresh copy when the tab opens so Employee counts are current.
  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    setPage(1);
  }, [search, showArchivedOnly]);

  const activeCount = employeeTypes.filter((type) => type.isActive).length;

  const visibleTypes = useMemo(
    () =>
      employeeTypes.filter((type) => {
        if (showArchivedOnly ? type.isActive : !type.isActive) return false;
        if (search.trim() && !type.name.toLowerCase().includes(search.trim().toLowerCase())) return false;
        return true;
      }),
    [employeeTypes, showArchivedOnly, search],
  );

  const pageCount = Math.max(1, Math.ceil(visibleTypes.length / PAGE_SIZE));
  const pagedTypes = visibleTypes.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const reload = () => revalidateEmployeeTypes().catch(() => undefined);

  const openCreateForm = () => {
    setFormMode("create");
    setEditing(null);
    setName("");
    setDescription("");
    setEntitledToLeave(true);
    setNameError(null);
    setFormOpen(true);
  };

  const openEditForm = (type: EmployeeType) => {
    setFormMode("edit");
    setEditing(type);
    setName(type.name);
    setDescription(type.description ?? "");
    setEntitledToLeave(isEntitledToLeave(type));
    setNameError(null);
    setViewType(null);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
    setNameError(null);
  };

  // Switching is only allowed while nobody is on the type (their leave would
  // change otherwise); seasonal types keep their own rules.
  const entitlementLockReason =
    formMode === "edit" && editing
      ? isSeasonal(editing)
        ? "Seasonal employee types keep their own leave rules."
        : editing._count.employees > 0
          ? "Can't be changed while employees are assigned to this type."
          : null
      : null;

  const submitForm = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    setIsSaving(true);
    setNameError(null);
    const body = JSON.stringify({
      name: trimmedName,
      description: description.trim(),
      ...(entitlementLockReason ? {} : { entitledToLeave }),
    });
    try {
      if (formMode === "create") {
        await apiRequest("/employee-types", { method: "POST", body });
        notify({ type: "success", title: "Employee Type Created", message: `"${trimmedName}" is now available in every Employee Type dropdown.` });
      } else if (editing) {
        await apiRequest(`/employee-types/${editing.id}`, { method: "PATCH", body });
        notify({ type: "success", title: "Employee Type Updated", message: `"${trimmedName}" employee type updated.` });
      }
      closeForm();
      reload();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save employee type.";
      if (/already exists/i.test(message)) setNameError(message);
      else notify({ type: "error", title: "Couldn't Save Employee Type", message });
    } finally {
      setIsSaving(false);
    }
  };

  const setStatus = async (type: EmployeeType, isActive: boolean) => {
    try {
      await apiRequest(`/employee-types/${type.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ isActive }),
      });
      notify({
        type: "success",
        title: isActive ? "Employee Type Restored" : "Employee Type Archived",
        message: `"${type.name}" ${isActive ? "restored" : "archived"} successfully.`,
      });
      setViewType(null);
      reload();
    } catch (err) {
      notify({
        type: "error",
        title: "Couldn't Update Employee Type Status",
        message: err instanceof Error ? err.message : "Unable to update employee type status.",
      });
    }
  };

  const requestArchive = (type: EmployeeType) => {
    setConfirmConfig({
      title: `Archive "${type.name}"?`,
      description:
        type._count.employees > 0
          ? `${type._count.employees} employee(s) are currently assigned this type. They'll keep it, but it won't be selectable for new or edited employees until restored.`
          : "This employee type won't be selectable for new or edited employees until restored.",
      confirmLabel: "Archive",
      tone: "danger",
      onConfirm: () => setStatus(type, false),
    });
  };

  const requestRestore = (type: EmployeeType) => {
    setConfirmConfig({
      title: `Restore "${type.name}"?`,
      description: "This employee type will become available for new and edited employees again.",
      confirmLabel: "Restore",
      tone: "primary",
      onConfirm: () => setStatus(type, true),
    });
  };


  return (
    <>
      <div className="employees-filter-bar">
        <div className="employees-filter-group">
          <span className="employees-filter-label">View</span>
          <div className="filter-tabs">
            <button className={!showArchivedOnly ? "active" : ""} onClick={() => setShowArchivedOnly(false)}>
              All Employee Types ({activeCount})
            </button>
          </div>
        </div>

        <div className="employees-filter-group">
          <span className="employees-filter-label">Archive</span>
          <div className="filter-tabs">
            <button className={showArchivedOnly ? "active" : ""} onClick={() => setShowArchivedOnly(true)}>
              Archived Employee Types
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
              placeholder="Search employee types..."
              aria-label="Search employee types by name"
            />
            <button type="button" className="employee-search-clear" onClick={() => setSearch("")} aria-label="Clear search">
              <X size={13} />
            </button>
          </div>
        </div>

        <div className="employees-filter-actions">
          {canManage && (
            <button className="add-employee-button" onClick={openCreateForm}>
              <Plus size={15} /> Add Employee Type
            </button>
          )}
        </div>
      </div>

      <section className="table-card utilities-table-card">
        <div className="utilities-table-scroll">
          <table>
            <thead>
              <tr>
                <th>EMPLOYEE TYPE</th>
                <th>EMPLOYEES</th>
                <th>STATUS</th>
                <th>ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {pagedTypes.length === 0 ? (
                <tr>
                  <td colSpan={4} className="utilities-empty-state">
                    {employeeTypes.length === 0 ? (
                      <div className="utilities-empty-block">
                        <IdCard size={28} />
                        <p>No employee types have been created yet. Create your first employee type to begin.</p>
                      </div>
                    ) : (
                      "No employee types match your current filters."
                    )}
                  </td>
                </tr>
              ) : (
                pagedTypes.map((type) => (
                  <tr key={type.id}>
                    <td data-label="Employee Type">{type.name}</td>
                    <td data-label="Employees">{type._count.employees}</td>
                    <td data-label="Status">
                      <Badge tone={type.isActive ? "success" : "neutral"}>{type.isActive ? "Active" : "Archived"}</Badge>
                    </td>
                    <td data-label="Actions">
                      <button type="button" className="utilities-view-button" onClick={() => setViewType(type)}>
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

      {/* ── Add/Edit Employee Type modal ── */}
      {formOpen && (
        <div className="utilities-modal-backdrop" role="presentation">
          <section className="utilities-modal utilities-modal--sm" role="dialog" aria-modal="true" aria-labelledby="employee-type-form-title">
            <div className="utilities-modal-header">
              <div>
                <h2 id="employee-type-form-title">{formMode === "create" ? "Add Employee Type" : "Edit Employee Type"}</h2>
                <p>{formMode === "create" ? "New employee type will be available immediately" : "Changes apply immediately"}</p>
              </div>
            </div>

            <div className="utilities-modal-body">
              <label className="utilities-field">
                <span className="utilities-field-label">
                  Employee Type Name <span className="utilities-required">*</span>
                </span>
                <input
                  className="utilities-input"
                  type="text"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameError(null);
                  }}
                  placeholder="e.g. Temporary Employee"
                  autoFocus
                />
                {nameError && <span className="utilities-field-error">{nameError}</span>}
              </label>

              <div className="utilities-field">
                <span className="utilities-field-label">
                  Leave Entitlement <span className="utilities-required">*</span>
                </span>
                <div className="utilities-segmented">
                  <button
                    type="button"
                    className={entitledToLeave ? "active" : ""}
                    onClick={() => setEntitledToLeave(true)}
                    disabled={!!entitlementLockReason}
                  >
                    Entitled to leave
                  </button>
                  <button
                    type="button"
                    className={!entitledToLeave ? "active" : ""}
                    onClick={() => setEntitledToLeave(false)}
                    disabled={!!entitlementLockReason}
                  >
                    Not entitled to leave
                  </button>
                </div>
                {entitlementLockReason && (
                  <span className="utilities-field-hint">{entitlementLockReason}</span>
                )}
              </div>

              <label className="utilities-field">
                <span className="utilities-field-label">Description</span>
                <input
                  className="utilities-input"
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional"
                />
              </label>
            </div>

            <div className="utilities-modal-actions">
              <button className="primary-button" onClick={submitForm} disabled={isSaving || !name.trim()}>
                {isSaving ? "Saving…" : formMode === "create" ? "Add Employee Type" : "Save Changes"}
              </button>
              <button className="outline-button" onClick={closeForm} disabled={isSaving}>
                Cancel
              </button>
            </div>
          </section>
        </div>
      )}

      {/* ── View Employee Type modal ── */}
      {viewType && (
        <div className="utilities-modal-backdrop" role="presentation">
          <section className="utilities-modal utilities-modal--sm" role="dialog" aria-modal="true" aria-labelledby="view-employee-type-title">
            <div className="utilities-modal-header">
              <div>
                <h2 id="view-employee-type-title">{viewType.name}</h2>
                <p>{viewType.description || "Employee type details"}</p>
              </div>
              <button className="icon-button" onClick={() => setViewType(null)} aria-label="Close">
                <X size={18} />
              </button>
            </div>

            <div className="utilities-modal-body">
              <div className="utilities-audit-detail-grid">
                <div>
                  <span>Leave Entitlement</span>
                  <Badge tone={isEntitledToLeave(viewType) ? "success" : "neutral"}>
                    {isEntitledToLeave(viewType) ? "Entitled to leave" : "Not entitled to leave"}
                  </Badge>
                </div>
                <div>
                  <span>Employees</span>
                  <strong>{viewType._count.employees}</strong>
                </div>
                <div>
                  <span>Status</span>
                  <Badge tone={viewType.isActive ? "success" : "neutral"}>{viewType.isActive ? "Active" : "Archived"}</Badge>
                </div>
              </div>
            </div>

            <div className="utilities-modal-actions">
              {canManage && (
                <>
                  <button className="utilities-edit-button" onClick={() => openEditForm(viewType)}>
                    <Pencil size={13} /> Edit
                  </button>
                  {viewType.isActive ? (
                    <button className="utilities-archive-button" onClick={() => requestArchive(viewType)}>
                      <Archive size={13} /> Archive
                    </button>
                  ) : (
                    <button className="utilities-archive-button restore" onClick={() => requestRestore(viewType)}>
                      <RotateCcw size={13} /> Restore
                    </button>
                  )}
                </>
              )}
              <button className="outline-button" onClick={() => setViewType(null)}>
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
