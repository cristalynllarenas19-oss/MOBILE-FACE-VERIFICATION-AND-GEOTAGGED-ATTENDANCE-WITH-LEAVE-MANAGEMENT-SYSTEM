import { useEffect, useMemo, useState } from "react";
import { Archive, Building2, Eye, Pencil, Plus, RotateCcw, Search, X } from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { ConfirmDialog, type ConfirmDialogConfig } from "../../components/ui/ConfirmDialog";
import { DropdownFilter } from "../../components/ui/DropdownFilter";
import { apiRequest } from "../../lib/api";
import {
  type AttendanceMode,
  formatAttendanceMode as attendanceModeLabel,
  useAttendanceModeOptions,
} from "../../lib/attendanceModes";
import { PermissionCode, permissions } from "../../types/rbac";
import type { Notification } from "./UtilitiesPage";
import "../employees/EmployeesPage.css";

type Department = {
  id: string;
  name: string;
  isActive: boolean;
  attendanceMode: AttendanceMode;
  _count: { employees: number };
};

const PAGE_SIZE = 10;

function attendanceModeTone(mode: AttendanceMode): "neutral" | "role" | "warning" {
  if (mode === "FIELD") return "role";
  if (mode === "BOTH") return "warning";
  return "neutral";
}

export function DepartmentsTab({
  user,
  notify,
}: {
  user?: { permissions: PermissionCode[] };
  notify: (notification: Notification) => void;
}) {
  const canManage = user?.permissions.includes(permissions.departmentsWrite) ?? true;

  const [departments, setDepartments] = useState<Department[]>([]);
  const [showArchivedOnly, setShowArchivedOnly] = useState(false);
  const [modeFilter, setModeFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<"create" | "edit">("create");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [attendanceMode, setAttendanceMode] = useState<AttendanceMode>("BOTH");
  const [nameError, setNameError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const [viewDepartment, setViewDepartment] = useState<Department | null>(null);
  const [confirmConfig, setConfirmConfig] = useState<ConfirmDialogConfig | null>(null);

  const loadDepartments = () => {
    apiRequest<Department[]>("/departments").then(setDepartments).catch(() => undefined);
  };

  useEffect(loadDepartments, []);

  const { forDepartments: attendanceModeOptions } = useAttendanceModeOptions();

  useEffect(() => {
    setPage(1);
  }, [search, modeFilter, showArchivedOnly]);

  const activeDepartmentCount = departments.filter((department) => department.isActive).length;

  const visibleDepartments = useMemo(
    () =>
      departments.filter((department) => {
        if (showArchivedOnly ? department.isActive : !department.isActive) return false;
        if (modeFilter !== "ALL" && department.attendanceMode !== modeFilter) return false;
        if (search.trim() && !department.name.toLowerCase().includes(search.trim().toLowerCase())) return false;
        return true;
      }),
    [departments, showArchivedOnly, modeFilter, search],
  );

  const pageCount = Math.max(1, Math.ceil(visibleDepartments.length / PAGE_SIZE));
  const pagedDepartments = visibleDepartments.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const openCreateForm = () => {
    setFormMode("create");
    setEditingId(null);
    setName("");
    setAttendanceMode("BOTH");
    setNameError(null);
    setFormOpen(true);
  };

  const openEditForm = (department: Department) => {
    setFormMode("edit");
    setEditingId(department.id);
    setName(department.name);
    setAttendanceMode(department.attendanceMode);
    setNameError(null);
    setViewDepartment(null);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setName("");
    setAttendanceMode("BOTH");
    setNameError(null);
  };

  const submitForm = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    setIsSaving(true);
    setNameError(null);
    try {
      if (formMode === "create") {
        await apiRequest("/departments", { method: "POST", body: JSON.stringify({ name: trimmedName, attendanceMode }) });
        notify({ type: "success", message: `"${trimmedName}" department created.` });
      } else if (editingId) {
        await apiRequest(`/departments/${editingId}`, { method: "PATCH", body: JSON.stringify({ name: trimmedName, attendanceMode }) });
        notify({ type: "success", message: `"${trimmedName}" department updated.` });
      }
      closeForm();
      loadDepartments();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save department.";
      if (/already exists/i.test(message)) setNameError(message);
      else notify({ type: "error", message });
    } finally {
      setIsSaving(false);
    }
  };

  const setStatus = async (department: Department, isActive: boolean) => {
    try {
      await apiRequest(`/departments/${department.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ isActive }),
      });
      notify({
        type: "success",
        message: `"${department.name}" ${isActive ? "restored" : "archived"} successfully.`,
      });
      setViewDepartment(null);
      loadDepartments();
    } catch (err) {
      notify({
        type: "error",
        message: err instanceof Error ? err.message : "Unable to update department status.",
      });
    }
  };

  const requestArchive = (department: Department) => {
    setConfirmConfig({
      title: `Archive "${department.name}"?`,
      description:
        department._count.employees > 0
          ? `${department._count.employees} employee(s) are currently in this department. They'll keep their assignment, but this department won't be selectable for new or edited employees until restored.`
          : "This department won't be selectable for new or edited employees until restored.",
      confirmLabel: "Archive",
      tone: "danger",
      onConfirm: () => setStatus(department, false),
    });
  };

  const requestRestore = (department: Department) => {
    setConfirmConfig({
      title: `Restore "${department.name}"?`,
      description: "This department will become available for new and edited employees again.",
      confirmLabel: "Restore",
      tone: "primary",
      onConfirm: () => setStatus(department, true),
    });
  };

  return (
    <>
      <div className="employees-filter-bar">
        <div className="employees-filter-group">
          <span className="employees-filter-label">View</span>
          <div className="filter-tabs">
            <button className={!showArchivedOnly ? "active" : ""} onClick={() => setShowArchivedOnly(false)}>
              All Departments ({activeDepartmentCount})
            </button>
          </div>
        </div>

        <div className="employees-filter-group">
          <span className="employees-filter-label">Archive</span>
          <div className="filter-tabs">
            <button className={showArchivedOnly ? "active" : ""} onClick={() => setShowArchivedOnly(true)}>
              Archived Departments
            </button>
          </div>
        </div>

        <div className="employees-filter-group">
          <label className="employees-filter-label">Attendance Mode</label>
          <DropdownFilter
            className="department-select"
            value={modeFilter}
            onChange={setModeFilter}
            options={attendanceModeOptions.map((option) => ({ value: option.code, label: option.label }))}
            allLabel="All Modes"
            menuLabel="Filter by attendance mode"
            ariaLabel="Filter departments by attendance mode"
          />
        </div>

        <div className="employees-filter-group employees-filter-search-group">
          <label className="employees-filter-label">Search</label>
          <div className="employee-search">
            <Search size={14} className="employee-search-icon" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search departments..."
              aria-label="Search departments by name"
            />
            <button type="button" className="employee-search-clear" onClick={() => setSearch("")} aria-label="Clear search">
              <X size={13} />
            </button>
          </div>
        </div>

        <div className="employees-filter-actions">
          {canManage && (
            <button className="add-employee-button" onClick={openCreateForm}>
              <Plus size={15} /> Add Department
            </button>
          )}
        </div>
      </div>

      <section className="table-card utilities-table-card">
        <div className="utilities-table-scroll">
          <table>
            <thead>
              <tr>
                <th>DEPARTMENT</th>
                <th>EMPLOYEES</th>
                <th>MODE</th>
                <th>STATUS</th>
                <th>ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {pagedDepartments.length === 0 ? (
                <tr>
                  <td colSpan={5} className="utilities-empty-state">
                    {departments.length === 0 ? (
                      <div className="utilities-empty-block">
                        <Building2 size={28} />
                        <p>No departments have been created yet. Create your first department to begin.</p>
                      </div>
                    ) : (
                      "No departments match your current filters."
                    )}
                  </td>
                </tr>
              ) : (
                pagedDepartments.map((department) => (
                  <tr key={department.id}>
                    <td data-label="Department">{department.name}</td>
                    <td data-label="Employees">{department._count.employees}</td>
                    <td data-label="Mode">
                      <Badge tone={attendanceModeTone(department.attendanceMode)}>
                        {attendanceModeLabel(department.attendanceMode, attendanceModeOptions)}
                      </Badge>
                    </td>
                    <td data-label="Status">
                      <Badge tone={department.isActive ? "success" : "neutral"}>
                        {department.isActive ? "Active" : "Inactive"}
                      </Badge>
                    </td>
                    <td data-label="Actions">
                      <button type="button" className="utilities-view-button" onClick={() => setViewDepartment(department)}>
                        <Eye size={13} /> View
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {pageCount > 1 && (
          <div className="utilities-pagination utilities-pagination-footer">
            <button className="outline-button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </button>
            <span>Page {page} of {pageCount}</span>
            <button className="outline-button" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>
              Next
            </button>
          </div>
        )}
      </section>

      {/* ── Add/Edit Department modal ── */}
      {formOpen && (
        <div className="utilities-modal-backdrop" role="presentation">
          <section className="utilities-modal utilities-modal--sm" role="dialog" aria-modal="true" aria-labelledby="department-form-title">
            <div className="utilities-modal-header">
              <div>
                <h2 id="department-form-title">{formMode === "create" ? "Add Department" : "Edit Department"}</h2>
                <p>{formMode === "create" ? "New department will be available immediately" : "Changes apply immediately"}</p>
              </div>
              <button className="icon-button" onClick={closeForm} aria-label="Close">
                <X size={18} />
              </button>
            </div>

            <div className="utilities-modal-body">
              <label className="utilities-field">
                <span className="utilities-field-label">
                  Department Name <span className="utilities-required">*</span>
                </span>
                <input
                  className="utilities-input"
                  type="text"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameError(null);
                  }}
                  placeholder="e.g. Production"
                  autoFocus
                />
                {nameError && <span className="utilities-field-error">{nameError}</span>}
              </label>

              <label className="utilities-field">
                <span className="utilities-field-label">Attendance Mode</span>
                <select
                  className="utilities-input"
                  value={attendanceMode}
                  onChange={(e) => setAttendanceMode(e.target.value)}
                  disabled={attendanceModeOptions.length === 0}
                >
                  {attendanceModeOptions.map((option) => (
                    <option key={option.code} value={option.code}>{option.label}{option.code === "BOTH" ? " (no restriction)" : ""}</option>
                  ))}
                </select>
                {attendanceModeOptions.length === 0 && (
                  <span className="utilities-field-error">Unable to load attendance modes.</span>
                )}
              </label>
            </div>

            <div className="utilities-modal-actions">
              <button className="primary-button" onClick={submitForm} disabled={isSaving || !name.trim()}>
                {isSaving ? "Saving…" : formMode === "create" ? "Add Department" : "Save Changes"}
              </button>
              <button className="outline-button" onClick={closeForm} disabled={isSaving}>
                Cancel
              </button>
            </div>
          </section>
        </div>
      )}

      {/* ── View Department modal ── */}
      {viewDepartment && (
        <div className="utilities-modal-backdrop" role="presentation">
          <section className="utilities-modal utilities-modal--view" role="dialog" aria-modal="true" aria-labelledby="view-department-title">
            <div className="utilities-modal-header">
              <div>
                <h2 id="view-department-title">{viewDepartment.name}</h2>
                <p>Department details</p>
              </div>
              <button className="icon-button" onClick={() => setViewDepartment(null)} aria-label="Close">
                <X size={18} />
              </button>
            </div>

            <div className="utilities-modal-body">
              <div className="utilities-audit-detail-grid">
                <div>
                  <span>Employees</span>
                  <strong>{viewDepartment._count.employees}</strong>
                </div>
                <div>
                  <span>Attendance Mode</span>
                  <Badge tone={attendanceModeTone(viewDepartment.attendanceMode)}>
                    {attendanceModeLabel(viewDepartment.attendanceMode, attendanceModeOptions)}
                  </Badge>
                </div>
                <div>
                  <span>Status</span>
                  <Badge tone={viewDepartment.isActive ? "success" : "neutral"}>
                    {viewDepartment.isActive ? "Active" : "Inactive"}
                  </Badge>
                </div>
              </div>
            </div>

            {canManage && (
              <div className="utilities-modal-actions">
                <button className="utilities-edit-button" onClick={() => openEditForm(viewDepartment)}>
                  <Pencil size={13} /> Edit
                </button>
                {viewDepartment.isActive ? (
                  <button className="utilities-archive-button" onClick={() => requestArchive(viewDepartment)}>
                    <Archive size={13} /> Archive
                  </button>
                ) : (
                  <button className="utilities-archive-button restore" onClick={() => requestRestore(viewDepartment)}>
                    <RotateCcw size={13} /> Restore
                  </button>
                )}
                <button className="outline-button" onClick={() => setViewDepartment(null)}>
                  Close
                </button>
              </div>
            )}
          </section>
        </div>
      )}

      {confirmConfig && <ConfirmDialog config={confirmConfig} onCancel={() => setConfirmConfig(null)} />}
    </>
  );
}
