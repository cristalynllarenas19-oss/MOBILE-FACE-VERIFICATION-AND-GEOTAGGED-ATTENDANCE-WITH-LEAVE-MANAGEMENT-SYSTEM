import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  ClipboardList,
  Eye,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  X,
  Zap,
} from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { DropdownFilter } from "../../components/ui/DropdownFilter";
import { ConfirmDialog, type ConfirmDialogConfig } from "../../components/ui/ConfirmDialog";
import { apiRequest } from "../../lib/api";
import {
  type EmploymentStatus,
  EMPLOYMENT_STATUS_OPTIONS,
  formatEmploymentStatus,
} from "../../types/employment";
import type { Notification } from "./UtilitiesPage";

type LeaveTypeKind = "GENERAL" | "MATERNITY" | "PATERNITY";

type ActorRef = { email: string; employee?: { firstName: string; lastName: string } | null } | null;

type LeaveType = {
  id: string;
  name: string;
  defaultDays: string;
  requiresDocument: boolean;
  supportingDocumentAfterDays: number | null;
  requiresHrValidation: boolean;
  requiresEhsActivation: boolean;
  ehsActivated: boolean;
  allowWithoutPay: boolean;
  isTransferable: boolean;
  isAutoCredited: boolean;
  applicableStatuses: EmploymentStatus[];
  isActive: boolean;
  isUnlimitedDays: boolean;
  requiresAdminGrant: boolean;
  isSingleDayOnly: boolean;
  advanceFilingAllowed: boolean;
  kind: LeaveTypeKind;
  createdAt: string;
  updatedAt: string;
  createdByUser?: ActorRef;
  updatedByUser?: ActorRef;
};

const LEAVE_TYPE_KIND_OPTIONS: { value: LeaveTypeKind; label: string }[] = [
  { value: "GENERAL", label: "General" },
  { value: "MATERNITY", label: "Maternity" },
  { value: "PATERNITY", label: "Paternity" },
];

// Every leave type always includes Regular - admins only choose which of these
// additional classifications also get it.
const OPTIONAL_STATUS_OPTIONS = EMPLOYMENT_STATUS_OPTIONS.filter((o) => o.value !== "REGULAR");

const PAGE_SIZE = 10;

function formatDefaultDays(type: LeaveType) {
  if (type.isUnlimitedDays) return "As needed";
  return type.name.trim().toLowerCase() === "sick leave" ? "As needed" : type.defaultDays;
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString();
}

function actorDisplayName(actor: ActorRef | undefined) {
  if (!actor) return null;
  if (actor.employee) return `${actor.employee.firstName} ${actor.employee.lastName}`;
  return actor.email;
}

const emptyForm = {
  name: "",
  defaultDays: "15",
  requiresDocument: false,
  supportingDocumentAfterDays: "",
  requiresHrValidation: false,
  requiresEhsActivation: false,
  allowWithoutPay: false,
  classifications: [] as EmploymentStatus[],
  isUnlimitedDays: false,
  requiresAdminGrant: false,
  isSingleDayOnly: false,
  advanceFilingAllowed: true,
  isAutoCredited: false,
  isTransferable: false,
  kind: "GENERAL" as LeaveTypeKind,
};

export function LeaveTypesTab({
  canManage,
  notify,
}: {
  canManage: boolean;
  notify: (notification: Notification) => void;
}) {
  const [leaveTypes, setLeaveTypes] = useState<LeaveType[]>([]);
  const [search, setSearch] = useState("");
  const [classificationFilter, setClassificationFilter] = useState("ALL");
  const [page, setPage] = useState(1);

  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<"create" | "edit">("create");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [nameError, setNameError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const [viewLeaveType, setViewLeaveType] = useState<LeaveType | null>(null);
  const [confirmConfig, setConfirmConfig] = useState<ConfirmDialogConfig | null>(null);

  const loadLeaveTypes = () => {
    apiRequest<LeaveType[]>("/leave-types").then(setLeaveTypes).catch(() => undefined);
  };

  useEffect(loadLeaveTypes, []);

  useEffect(() => {
    setPage(1);
  }, [search, classificationFilter]);

  const visibleLeaveTypes = useMemo(
    () =>
      leaveTypes.filter((type) => {
        const matchesClassification =
          classificationFilter === "ALL" ||
          type.applicableStatuses.includes(classificationFilter as EmploymentStatus);
        const matchesSearch =
          !search.trim() || type.name.toLowerCase().includes(search.trim().toLowerCase());
        return matchesClassification && matchesSearch;
      }),
    [leaveTypes, classificationFilter, search],
  );

  const pageCount = Math.max(1, Math.ceil(visibleLeaveTypes.length / PAGE_SIZE));
  const pagedLeaveTypes = visibleLeaveTypes.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const openCreateForm = () => {
    setFormMode("create");
    setEditingId(null);
    setForm(emptyForm);
    setNameError(null);
    setFormOpen(true);
  };

  const openEditForm = (type: LeaveType) => {
    setFormMode("edit");
    setEditingId(type.id);
    setForm({
      name: type.name,
      defaultDays: type.defaultDays,
      requiresDocument: type.requiresDocument,
      supportingDocumentAfterDays: type.supportingDocumentAfterDays != null ? String(type.supportingDocumentAfterDays) : "",
      requiresHrValidation: type.requiresHrValidation,
      requiresEhsActivation: type.requiresEhsActivation,
      allowWithoutPay: type.allowWithoutPay,
      classifications: type.applicableStatuses.filter((s) => s !== "REGULAR"),
      isUnlimitedDays: type.isUnlimitedDays,
      requiresAdminGrant: type.requiresAdminGrant,
      isSingleDayOnly: type.isSingleDayOnly,
      advanceFilingAllowed: type.advanceFilingAllowed,
      isAutoCredited: type.isAutoCredited,
      isTransferable: type.isTransferable,
      kind: type.kind,
    });
    setNameError(null);
    setViewLeaveType(null);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setForm(emptyForm);
    setNameError(null);
  };

  const submitForm = async () => {
    const name = form.name.trim();
    if (!name || (!form.isUnlimitedDays && !form.defaultDays)) return;
    setIsSaving(true);
    setNameError(null);
    try {
      const payload = {
        name,
        defaultDays: form.isUnlimitedDays ? 0 : Number(form.defaultDays),
        requiresDocument: form.requiresDocument,
        supportingDocumentAfterDays:
          form.requiresDocument && form.supportingDocumentAfterDays ? Number(form.supportingDocumentAfterDays) : undefined,
        requiresHrValidation: form.requiresHrValidation,
        requiresEhsActivation: form.requiresEhsActivation,
        allowWithoutPay: form.allowWithoutPay,
        applicableStatuses: ["REGULAR", ...form.classifications],
        isUnlimitedDays: form.isUnlimitedDays,
        requiresAdminGrant: form.requiresAdminGrant,
        isSingleDayOnly: form.isSingleDayOnly,
        advanceFilingAllowed: form.advanceFilingAllowed,
        isAutoCredited: form.isAutoCredited,
        isTransferable: form.isTransferable,
        kind: form.kind,
      };

      if (formMode === "create") {
        await apiRequest("/leave-types", { method: "POST", body: JSON.stringify(payload) });
        notify({ type: "success", message: `"${name}" leave type created.` });
      } else if (editingId) {
        await apiRequest(`/leave-types/${editingId}`, { method: "PATCH", body: JSON.stringify(payload) });
        notify({ type: "success", message: `"${name}" leave type updated.` });
      }
      closeForm();
      loadLeaveTypes();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save leave type.";
      if (/already exists/i.test(message)) setNameError(message);
      else notify({ type: "error", message });
    } finally {
      setIsSaving(false);
    }
  };

  const setStatus = async (type: LeaveType, isActive: boolean) => {
    try {
      await apiRequest(`/leave-types/${type.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ isActive }),
      });
      notify({
        type: "success",
        message: `"${type.name}" ${isActive ? "restored" : "archived"} successfully.`,
      });
      setViewLeaveType(null);
      loadLeaveTypes();
    } catch (err) {
      notify({
        type: "error",
        message: err instanceof Error ? err.message : "Unable to update leave type status.",
      });
    }
  };

  const toggleEhsActivation = async (type: LeaveType) => {
    try {
      const nextActivated = !type.ehsActivated;
      await apiRequest(`/leave-types/${type.id}/ehs-activation`, {
        method: "PATCH",
        body: JSON.stringify({ ehsActivated: nextActivated }),
      });
      notify({
        type: "success",
        message: `"${type.name}" ${nextActivated ? "activated" : "deactivated"} successfully.`,
      });
      setViewLeaveType(null);
      loadLeaveTypes();
    } catch (err) {
      notify({
        type: "error",
        message: err instanceof Error ? err.message : "Unable to update EHS activation.",
      });
    }
  };

  const requestArchive = (type: LeaveType) => {
    setConfirmConfig({
      title: `Archive "${type.name}"?`,
      description:
        "Archived leave types are hidden from new requests but existing leave records and balances are kept exactly as they are. You can restore it at any time.",
      confirmLabel: "Archive",
      tone: "danger",
      onConfirm: () => setStatus(type, false),
    });
  };

  const requestRestore = (type: LeaveType) => {
    setConfirmConfig({
      title: `Restore "${type.name}"?`,
      description: "This leave type will become available for new leave requests again.",
      confirmLabel: "Restore",
      tone: "primary",
      onConfirm: () => setStatus(type, true),
    });
  };

  return (
    <>
      <div className="utilities-section-header">
        <h3>Leave Types</h3>
        <div className="utilities-section-header-controls">
          <div className="utilities-search">
            <Search size={14} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search leave type by name..."
              aria-label="Search leave types by name"
            />
          </div>
          <DropdownFilter
            className="utilities-select"
            value={classificationFilter}
            onChange={setClassificationFilter}
            options={EMPLOYMENT_STATUS_OPTIONS}
            allLabel="All Classifications"
            menuLabel="Filter by classification"
            ariaLabel="Filter leave types by classification"
          />
          {canManage && (
            <button className="primary-button" onClick={openCreateForm}>
              <Plus size={15} /> Add Leave Type
            </button>
          )}
        </div>
      </div>

      <section className="table-card utilities-table-card">
        <div className="utilities-table-scroll">
        <table>
          <thead>
            <tr>
              <th>NAME</th>
              <th>DEFAULT DAYS/YEAR</th>
              <th>STATUS</th>
              <th>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {pagedLeaveTypes.length === 0 ? (
              <tr>
                <td colSpan={4} className="utilities-empty-state">
                  {leaveTypes.length === 0 ? (
                    <div className="utilities-empty-block">
                      <ClipboardList size={28} />
                      <p>No leave types have been created yet. Create your first leave type to begin.</p>
                    </div>
                  ) : (
                    "No leave types match your current filters."
                  )}
                </td>
              </tr>
            ) : (
              pagedLeaveTypes.map((type) => (
                <tr key={type.id}>
                  <td data-label="Name">{type.name}</td>
                  <td data-label="Default Days/Year">{formatDefaultDays(type)}</td>
                  <td data-label="Status">
                    <Badge tone={type.isActive ? "success" : "neutral"}>
                      {type.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </td>
                  <td data-label="Actions">
                    <button type="button" className="utilities-view-button" onClick={() => setViewLeaveType(type)}>
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

      {/* Add/Edit Leave Type modal */}
      {formOpen && (
        <div className="utilities-modal-backdrop" role="presentation">
          <section className="utilities-modal utilities-modal--sm" role="dialog" aria-modal="true" aria-labelledby="leave-type-form-title">
            <div className="utilities-modal-header">
              <div>
                <h2 id="leave-type-form-title">{formMode === "create" ? "Add Leave Type" : "Edit Leave Type"}</h2>
                <p>{formMode === "create" ? "New type will be available immediately" : "Changes apply immediately"}</p>
              </div>
              <button className="icon-button" onClick={closeForm} aria-label="Close">
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
                  value={form.name}
                  onChange={(e) => {
                    setForm((c) => ({ ...c, name: e.target.value }));
                    setNameError(null);
                  }}
                  placeholder="e.g. Emergency Leave"
                  autoFocus
                />
                {nameError && <span className="utilities-field-error">{nameError}</span>}
              </label>

              <div className="utilities-field">
                <span className="utilities-field-label">Leave Kind</span>
                <div className="utilities-segmented">
                  {LEAVE_TYPE_KIND_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={form.kind === option.value ? "active" : ""}
                      onClick={() => setForm((c) => ({ ...c, kind: option.value }))}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {form.kind !== "GENERAL" && (
                  <span className="utilities-field-hint">
                    {form.kind === "MATERNITY"
                      ? "Restricted to female employees; new female hires are auto-enrolled here."
                      : "Restricted to male employees; new male hires are auto-enrolled here."}
                  </span>
                )}
              </div>

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
                        checked={form.classifications.includes(option.value)}
                        onChange={(e) =>
                          setForm((c) => ({
                            ...c,
                            classifications: e.target.checked
                              ? [...c.classifications, option.value]
                              : c.classifications.filter((s) => s !== option.value),
                          }))
                        }
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="utilities-field">
                <span className="utilities-field-label">Default Days per Year</span>
                <div className="utilities-segmented">
                  <button
                    type="button"
                    className={!form.isUnlimitedDays ? "active" : ""}
                    onClick={() => setForm((c) => ({ ...c, isUnlimitedDays: false }))}
                  >
                    Fixed number of days
                  </button>
                  <button
                    type="button"
                    className={form.isUnlimitedDays ? "active" : ""}
                    onClick={() => setForm((c) => ({ ...c, isUnlimitedDays: true }))}
                  >
                    As Needed
                  </button>
                </div>
                {!form.isUnlimitedDays && (
                  <input
                    className="utilities-input"
                    type="number"
                    min={1}
                    value={form.defaultDays}
                    onChange={(e) => setForm((c) => ({ ...c, defaultDays: e.target.value }))}
                  />
                )}
              </div>

              <label className="utilities-checkbox">
                <input
                  type="checkbox"
                  checked={form.requiresDocument}
                  onChange={(e) => setForm((c) => ({ ...c, requiresDocument: e.target.checked }))}
                />
                <span>Requires supporting document</span>
              </label>

              {form.requiresDocument && (
                <label className="utilities-field">
                  <span className="utilities-field-label">Requires supporting document after how many days</span>
                  <input
                    className="utilities-input"
                    type="number"
                    min={0}
                    value={form.supportingDocumentAfterDays}
                    onChange={(e) => setForm((c) => ({ ...c, supportingDocumentAfterDays: e.target.value }))}
                    placeholder="e.g. 2 (leave blank to always require it)"
                  />
                </label>
              )}

              <label className="utilities-checkbox">
                <input
                  type="checkbox"
                  checked={form.requiresHrValidation}
                  onChange={(e) => setForm((c) => ({ ...c, requiresHrValidation: e.target.checked }))}
                />
                <span>Requires HR validation</span>
              </label>

              <label className="utilities-checkbox">
                <input
                  type="checkbox"
                  checked={form.requiresEhsActivation}
                  onChange={(e) => setForm((c) => ({ ...c, requiresEhsActivation: e.target.checked }))}
                />
                <span>Requires EHS activation</span>
              </label>

              <label className="utilities-checkbox">
                <input
                  type="checkbox"
                  checked={form.requiresAdminGrant}
                  onChange={(e) => setForm((c) => ({ ...c, requiresAdminGrant: e.target.checked }))}
                />
                <span>Admin-grant only (employee applies to HR/Admin, who grants it per employee)</span>
              </label>

              <label className="utilities-checkbox">
                <input
                  type="checkbox"
                  checked={form.isSingleDayOnly}
                  onChange={(e) => setForm((c) => ({ ...c, isSingleDayOnly: e.target.checked }))}
                />
                <span>Single day only (each request is automatically 1 day, no date range)</span>
              </label>

              <label className="utilities-checkbox">
                <input
                  type="checkbox"
                  checked={form.advanceFilingAllowed}
                  onChange={(e) => setForm((c) => ({ ...c, advanceFilingAllowed: e.target.checked }))}
                />
                <span>Allow advance filing (uncheck for a type like Sick Leave that can only be filed for today, never a future date)</span>
              </label>

              <label className="utilities-checkbox">
                <input
                  type="checkbox"
                  checked={form.isAutoCredited}
                  onChange={(e) => setForm((c) => ({ ...c, isAutoCredited: e.target.checked }))}
                />
                <span>Auto-credited (every eligible regular employee gets this balance automatically each year)</span>
              </label>

              <label className="utilities-checkbox">
                <input
                  type="checkbox"
                  checked={form.isTransferable}
                  onChange={(e) => setForm((c) => ({ ...c, isTransferable: e.target.checked }))}
                />
                <span>Transferable (days can be transferred from another employee's leave, e.g. Added Paternity Leave)</span>
              </label>
            </div>

            <div className="utilities-modal-actions">
              <button
                className="primary-button"
                onClick={submitForm}
                disabled={isSaving || !form.name.trim() || (!form.isUnlimitedDays && !form.defaultDays)}
              >
                {isSaving ? "Saving..." : formMode === "create" ? "Add Leave Type" : "Save Changes"}
              </button>
              <button className="outline-button" onClick={closeForm} disabled={isSaving}>
                Cancel
              </button>
            </div>
          </section>
        </div>
      )}

      {/* View Leave Type modal */}
      {viewLeaveType && (
        <div className="utilities-modal-backdrop" role="presentation">
          <section className="utilities-modal utilities-modal--view" role="dialog" aria-modal="true" aria-labelledby="view-type-title">
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
                  <span>Leave Kind</span>
                  <Badge tone={viewLeaveType.kind === "GENERAL" ? "neutral" : "warning"}>
                    {LEAVE_TYPE_KIND_OPTIONS.find((o) => o.value === viewLeaveType.kind)?.label ?? viewLeaveType.kind}
                  </Badge>
                </div>
                <div>
                  <span>Applicable Classifications</span>
                  <strong>{viewLeaveType.applicableStatuses.map(formatEmploymentStatus).join(", ")}</strong>
                </div>
                <div>
                  <span>Auto-Credited</span>
                  <Badge tone={viewLeaveType.isAutoCredited ? "success" : "neutral"}>
                    {viewLeaveType.isAutoCredited ? "Yes" : "No"}
                  </Badge>
                </div>
                <div>
                  <span>Transferable</span>
                  <Badge tone={viewLeaveType.isTransferable ? "warning" : "neutral"}>
                    {viewLeaveType.isTransferable ? "Yes" : "No"}
                  </Badge>
                </div>
                <div>
                  <span>Requires Document</span>
                  <Badge tone={viewLeaveType.requiresDocument ? "warning" : "neutral"}>
                    {viewLeaveType.requiresDocument
                      ? viewLeaveType.supportingDocumentAfterDays
                        ? `Required after ${viewLeaveType.supportingDocumentAfterDays}+ day(s)`
                        : "Required"
                      : "Not required"}
                  </Badge>
                </div>
                <div>
                  <span>Requires HR Validation</span>
                  <Badge tone={viewLeaveType.requiresHrValidation ? "warning" : "neutral"}>
                    {viewLeaveType.requiresHrValidation ? "Required" : "Not required"}
                  </Badge>
                </div>
                {viewLeaveType.requiresEhsActivation && (
                  <div>
                    <span>EHS Activation</span>
                    <Badge tone={viewLeaveType.ehsActivated ? "success" : "neutral"}>
                      {viewLeaveType.ehsActivated ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                )}
                <div>
                  <span>Admin-Grant Only</span>
                  <Badge tone={viewLeaveType.requiresAdminGrant ? "warning" : "neutral"}>
                    {viewLeaveType.requiresAdminGrant ? "Yes - granted per employee" : "No - available to all"}
                  </Badge>
                </div>
                <div>
                  <span>Single Day Only</span>
                  <Badge tone={viewLeaveType.isSingleDayOnly ? "warning" : "neutral"}>
                    {viewLeaveType.isSingleDayOnly ? "Yes" : "No"}
                  </Badge>
                </div>
                <div>
                  <span>Advance Filing</span>
                  <Badge tone={viewLeaveType.advanceFilingAllowed ? "neutral" : "warning"}>
                    {viewLeaveType.advanceFilingAllowed ? "Allowed" : "Today only — no future dates"}
                  </Badge>
                </div>
                <div>
                  <span>Status</span>
                  <Badge tone={viewLeaveType.isActive ? "success" : "neutral"}>
                    {viewLeaveType.isActive ? "Active" : "Inactive"}
                  </Badge>
                </div>
                <div>
                  <span>Created</span>
                  <strong>
                    {formatDate(viewLeaveType.createdAt)}
                    {actorDisplayName(viewLeaveType.createdByUser) ? ` - ${actorDisplayName(viewLeaveType.createdByUser)}` : ""}
                  </strong>
                </div>
                <div>
                  <span>Last Updated</span>
                  <strong>
                    {formatDate(viewLeaveType.updatedAt)}
                    {actorDisplayName(viewLeaveType.updatedByUser) ? ` - ${actorDisplayName(viewLeaveType.updatedByUser)}` : ""}
                  </strong>
                </div>
              </div>
            </div>

            <div className="utilities-modal-actions">
              {canManage && (
                <button className="utilities-edit-button" onClick={() => openEditForm(viewLeaveType)}>
                  <Pencil size={13} /> Edit
                </button>
              )}
              {canManage && viewLeaveType.requiresEhsActivation && (
                <button className="utilities-edit-button" onClick={() => toggleEhsActivation(viewLeaveType)}>
                  <Zap size={13} /> {viewLeaveType.ehsActivated ? "Deactivate" : "Activate"}
                </button>
              )}
              {canManage && (viewLeaveType.isActive ? (
                <button className="utilities-archive-button" onClick={() => requestArchive(viewLeaveType)}>
                  <Archive size={13} /> Archive
                </button>
              ) : (
                <button className="utilities-archive-button restore" onClick={() => requestRestore(viewLeaveType)}>
                  <RotateCcw size={13} /> Restore
                </button>
              ))}
              <button className="outline-button" onClick={() => setViewLeaveType(null)}>
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
