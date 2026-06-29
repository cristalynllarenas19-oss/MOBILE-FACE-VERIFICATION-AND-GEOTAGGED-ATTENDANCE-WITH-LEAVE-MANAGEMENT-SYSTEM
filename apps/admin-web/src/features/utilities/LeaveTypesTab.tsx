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
} from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { DropdownFilter } from "../../components/ui/DropdownFilter";
import { ConfirmDialog, type ConfirmDialogConfig } from "../../components/ui/ConfirmDialog";
import { apiRequest } from "../../lib/api";
import type { Notification } from "./UtilitiesPage";

type EmploymentStatus = "REGULAR" | "PROBATIONARY" | "CONTRACTUAL" | "SEPARATED";

type ActorRef = { email: string; employee?: { firstName: string; lastName: string } | null } | null;

type LeaveType = {
  id: string;
  name: string;
  defaultDays: string;
  requiresDocument: boolean;
  applicableStatuses: EmploymentStatus[];
  isActive: boolean;
  isUnlimitedDays: boolean;
  createdAt: string;
  updatedAt: string;
  createdByUser?: ActorRef;
  updatedByUser?: ActorRef;
};

const EMPLOYMENT_STATUS_OPTIONS: { value: EmploymentStatus; label: string }[] = [
  { value: "REGULAR", label: "Regular" },
  { value: "PROBATIONARY", label: "Probationary" },
  { value: "CONTRACTUAL", label: "Contractual" },
  { value: "SEPARATED", label: "Separated" },
];

// Every leave type always includes Regular — admins only choose which of these
// additional classifications also get it.
const OPTIONAL_STATUS_OPTIONS = EMPLOYMENT_STATUS_OPTIONS.filter((o) => o.value !== "REGULAR");

const PAGE_SIZE = 10;

function formatEmploymentStatus(status: EmploymentStatus) {
  return status.charAt(0) + status.slice(1).toLowerCase();
}

function formatDefaultDays(type: LeaveType) {
  if (type.isUnlimitedDays) return "Unlimited";
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
  classifications: [] as EmploymentStatus[],
  isUnlimitedDays: false,
};

export function LeaveTypesTab({
  notify,
}: {
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

  const stats = useMemo(() => {
    const requiresDocument = leaveTypes.filter((t) => t.requiresDocument).length;
    const active = leaveTypes.filter((t) => t.isActive).length;
    const classificationsCovered = new Set(leaveTypes.flatMap((t) => t.applicableStatuses)).size;
    return {
      total: leaveTypes.length,
      requiresDocument,
      active,
      classificationsCovered,
    };
  }, [leaveTypes]);

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
      classifications: type.applicableStatuses.filter((s) => s !== "REGULAR"),
      isUnlimitedDays: type.isUnlimitedDays,
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
        applicableStatuses: ["REGULAR", ...form.classifications],
        isUnlimitedDays: form.isUnlimitedDays,
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
      <div className="utilities-stats-row">
        <div className="utilities-stat-card">
          <span>Total Leave Types</span>
          <strong>{stats.total}</strong>
        </div>
        <div className="utilities-stat-card">
          <span>Requires Document</span>
          <strong>{stats.requiresDocument}</strong>
        </div>
        <div className="utilities-stat-card">
          <span>Active</span>
          <strong>{stats.active}</strong>
        </div>
        <div className="utilities-stat-card">
          <span>Classifications Covered</span>
          <strong>{stats.classificationsCovered} / 4</strong>
        </div>
      </div>

      <div className="utilities-section-header">
        <h3>Leave Types</h3>
        <div className="utilities-section-header-controls">
          <div className="utilities-search">
            <Search size={14} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search leave type by name…"
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
          <button className="primary-button" onClick={openCreateForm}>
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
              <th>STATUS</th>
              <th>LAST UPDATED</th>
              <th>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {pagedLeaveTypes.length === 0 ? (
              <tr>
                <td colSpan={5} className="utilities-empty-state">
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
                  <td data-label="Last Updated">
                    <div className="utilities-last-updated">
                      <span>{formatDate(type.updatedAt)}</span>
                      {actorDisplayName(type.updatedByUser ?? type.createdByUser) && (
                        <small>{actorDisplayName(type.updatedByUser ?? type.createdByUser)}</small>
                      )}
                    </div>
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
      </section>

      {visibleLeaveTypes.length > 0 && (
        <div className="utilities-pagination">
          <button className="outline-button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </button>
          <span>
            Page {page} of {pageCount}
          </span>
          <button className="outline-button" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>
            Next
          </button>
        </div>
      )}

      {/* ── Add/Edit Leave Type modal ── */}
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
                    Unlimited / Variable
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
            </div>

            <div className="utilities-modal-actions">
              <button
                className="primary-button"
                onClick={submitForm}
                disabled={isSaving || !form.name.trim() || (!form.isUnlimitedDays && !form.defaultDays)}
              >
                {isSaving ? "Saving…" : formMode === "create" ? "Add Leave Type" : "Save Changes"}
              </button>
              <button className="outline-button" onClick={closeForm} disabled={isSaving}>
                Cancel
              </button>
            </div>
          </section>
        </div>
      )}

      {/* ── View Leave Type modal ── */}
      {viewLeaveType && (
        <div className="utilities-modal-backdrop" role="presentation">
          <section className="utilities-modal utilities-modal--sm" role="dialog" aria-modal="true" aria-labelledby="view-type-title">
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
                  <span>Applicable Classifications</span>
                  <strong>{viewLeaveType.applicableStatuses.map(formatEmploymentStatus).join(", ")}</strong>
                </div>
                <div>
                  <span>Requires Document</span>
                  <Badge tone={viewLeaveType.requiresDocument ? "warning" : "neutral"}>
                    {viewLeaveType.requiresDocument ? "Required" : "Not required"}
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
                    {actorDisplayName(viewLeaveType.createdByUser) ? ` — ${actorDisplayName(viewLeaveType.createdByUser)}` : ""}
                  </strong>
                </div>
                <div>
                  <span>Last Updated</span>
                  <strong>
                    {formatDate(viewLeaveType.updatedAt)}
                    {actorDisplayName(viewLeaveType.updatedByUser) ? ` — ${actorDisplayName(viewLeaveType.updatedByUser)}` : ""}
                  </strong>
                </div>
              </div>
            </div>

            <div className="utilities-modal-actions">
              <button className="utilities-edit-button" onClick={() => openEditForm(viewLeaveType)}>
                <Pencil size={13} /> Edit
              </button>
              {viewLeaveType.isActive ? (
                <button className="utilities-archive-button" onClick={() => requestArchive(viewLeaveType)}>
                  <Archive size={13} /> Archive
                </button>
              ) : (
                <button className="utilities-archive-button restore" onClick={() => requestRestore(viewLeaveType)}>
                  <RotateCcw size={13} /> Restore
                </button>
              )}
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
