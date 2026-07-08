import { useEffect, useState, type FormEvent } from "react";
import { Archive, CalendarClock, Eye, Pencil, Plus, RotateCcw, Search, X } from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { ConfirmDialog, type ConfirmDialogConfig } from "../../components/ui/ConfirmDialog";
import { apiRequest } from "../../lib/api";
import type { Notification } from "./UtilitiesPage";

type ActorRef = { email: string; employee?: { firstName: string; lastName: string } | null } | null;

type Shift = {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  morningBreakMinutes: number;
  afternoonBreakMinutes: number;
  lunchBreakMinutes: number;
  enableRounding: boolean;
  roundingIntervalMinutes: number;
  lateThresholdMinutes: number;
  undertimeThresholdMinutes: number;
  autoShiftAdjustment: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  createdByUser?: ActorRef;
  updatedByUser?: ActorRef;
  _count?: { schedules: number };
};

function actorDisplayName(actor: ActorRef | undefined) {
  if (!actor) return null;
  if (actor.employee) return `${actor.employee.firstName} ${actor.employee.lastName}`;
  return actor.email;
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString();
}

// Computes total working hours from "HH:mm" start/end strings, handling
// shifts that cross midnight (end time earlier than start time).
function computeShiftHours(startTime: string, endTime: string): string | null {
  if (!startTime || !endTime) return null;
  const [startH, startM] = startTime.split(":").map(Number);
  const [endH, endM] = endTime.split(":").map(Number);
  if ([startH, startM, endH, endM].some((n) => Number.isNaN(n))) return null;

  let minutes = endH * 60 + endM - (startH * 60 + startM);
  if (minutes <= 0) minutes += 24 * 60;

  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes === 0 ? `${hours}h` : `${hours}h ${remMinutes}m`;
}

const emptyForm = {
  name: "",
  startTime: "",
  endTime: "",
  morningBreakMinutes: "15",
  afternoonBreakMinutes: "15",
  lunchBreakMinutes: "60",
  enableRounding: false,
  roundingIntervalMinutes: "15",
  lateThresholdMinutes: "0",
  undertimeThresholdMinutes: "0",
  autoShiftAdjustment: false,
};

export function ShiftsTab({
  canManageShifts,
  notify,
}: {
  canManageShifts: boolean;
  notify: (notification: Notification) => void;
}) {
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [search, setSearch] = useState("");

  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<"create" | "edit">("create");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [nameError, setNameError] = useState<string | null>(null);
  const [timeError, setTimeError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const [viewShift, setViewShift] = useState<Shift | null>(null);
  const [confirmConfig, setConfirmConfig] = useState<ConfirmDialogConfig | null>(null);

  const loadShifts = () => {
    apiRequest<Shift[]>("/schedules/shifts").then(setShifts).catch(() => undefined);
  };

  useEffect(loadShifts, []);

  const visibleShifts = shifts.filter(
    (shift) => !search.trim() || shift.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  const openCreateForm = () => {
    setFormMode("create");
    setEditingId(null);
    setForm(emptyForm);
    setNameError(null);
    setTimeError(null);
    setFormOpen(true);
  };

  const openEditForm = (shift: Shift) => {
    setFormMode("edit");
    setEditingId(shift.id);
    setForm({
      name: shift.name,
      startTime: shift.startTime,
      endTime: shift.endTime,
      morningBreakMinutes: String(shift.morningBreakMinutes),
      afternoonBreakMinutes: String(shift.afternoonBreakMinutes),
      lunchBreakMinutes: String(shift.lunchBreakMinutes),
      enableRounding: shift.enableRounding,
      roundingIntervalMinutes: String(shift.roundingIntervalMinutes),
      lateThresholdMinutes: String(shift.lateThresholdMinutes),
      undertimeThresholdMinutes: String(shift.undertimeThresholdMinutes),
      autoShiftAdjustment: shift.autoShiftAdjustment,
    });
    setNameError(null);
    setTimeError(null);
    setViewShift(null);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setForm(emptyForm);
    setNameError(null);
    setTimeError(null);
  };

  const submitForm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSaving(true);
    setNameError(null);
    setTimeError(null);
    try {
      const payload = {
        name: form.name.trim(),
        startTime: form.startTime,
        endTime: form.endTime,
        morningBreakMinutes: Number(form.morningBreakMinutes || 0),
        afternoonBreakMinutes: Number(form.afternoonBreakMinutes || 0),
        lunchBreakMinutes: Number(form.lunchBreakMinutes || 0),
        enableRounding: form.enableRounding,
        roundingIntervalMinutes: Number(form.roundingIntervalMinutes || 15),
        lateThresholdMinutes: Number(form.lateThresholdMinutes || 0),
        undertimeThresholdMinutes: Number(form.undertimeThresholdMinutes || 0),
        autoShiftAdjustment: form.autoShiftAdjustment,
      };

      if (formMode === "create") {
        const created = await apiRequest<Shift>("/schedules/shifts", { method: "POST", body: JSON.stringify(payload) });
        notify({ type: "success", message: `"${created.name}" shift created successfully.` });
      } else if (editingId) {
        const updated = await apiRequest<Shift>(`/schedules/shifts/${editingId}`, { method: "PATCH", body: JSON.stringify(payload) });
        notify({ type: "success", message: `"${updated.name}" shift updated successfully.` });
      }
      closeForm();
      loadShifts();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to save shift.";
      if (/already exists/i.test(message)) setNameError(message);
      else if (/start time and end time/i.test(message)) setTimeError(message);
      else notify({ type: "error", message });
    } finally {
      setIsSaving(false);
    }
  };

  const setStatus = async (shift: Shift, isActive: boolean) => {
    try {
      await apiRequest(`/schedules/shifts/${shift.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ isActive }),
      });
      notify({ type: "success", message: `"${shift.name}" ${isActive ? "restored" : "archived"} successfully.` });
      setViewShift(null);
      loadShifts();
    } catch (err) {
      notify({ type: "error", message: err instanceof Error ? err.message : "Unable to update shift status." });
    }
  };

  const requestArchive = (shift: Shift) => {
    const assignedCount = shift._count?.schedules ?? 0;
    setConfirmConfig({
      title: `Archive "${shift.name}"?`,
      description:
        assignedCount > 0
          ? `${assignedCount} employee${assignedCount === 1 ? " is" : "s are"} currently assigned to this shift. Archiving hides it from new assignments but existing schedules are kept exactly as they are. You can restore it at any time.`
          : "Archived shifts are hidden from new assignments. You can restore it at any time.",
      confirmLabel: "Archive",
      tone: "danger",
      onConfirm: () => setStatus(shift, false),
    });
  };

  const requestRestore = (shift: Shift) => {
    setConfirmConfig({
      title: `Restore "${shift.name}"?`,
      description: "This shift will become available for new assignments again.",
      confirmLabel: "Restore",
      tone: "primary",
      onConfirm: () => setStatus(shift, true),
    });
  };

  const liveHours = computeShiftHours(form.startTime, form.endTime);

  return (
    <>
      <div className="utilities-section-header">
        <h3>Shifts</h3>
        <div className="utilities-section-header-controls">
          <div className="utilities-search">
            <Search size={14} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search shift by name…"
              aria-label="Search shifts by name"
            />
          </div>
          {canManageShifts && (
            <button className="primary-button" onClick={openCreateForm}>
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
              <th>EMPLOYEES ASSIGNED</th>
              <th>STATUS</th>
              <th>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {visibleShifts.length === 0 ? (
              <tr>
                <td colSpan={5} className="utilities-empty-state">
                  {shifts.length === 0 ? (
                    <div className="utilities-empty-block">
                      <CalendarClock size={28} />
                      <p>No shifts have been created yet. Create your first shift to begin.</p>
                    </div>
                  ) : (
                    "No shifts match your search."
                  )}
                </td>
              </tr>
            ) : (
              visibleShifts.map((shift) => (
                <tr key={shift.id}>
                  <td data-label="Name">{shift.name}</td>
                  <td data-label="Time">{shift.startTime} – {shift.endTime}</td>
                  <td data-label="Employees Assigned">{shift._count?.schedules ?? 0}</td>
                  <td data-label="Status">
                    <Badge tone={shift.isActive ? "success" : "neutral"}>{shift.isActive ? "Active" : "Inactive"}</Badge>
                  </td>
                  <td data-label="Actions">
                    <button type="button" className="utilities-view-button" onClick={() => setViewShift(shift)}>
                      <Eye size={13} /> View
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      {/* ── Add/Edit Shift modal ── */}
      {canManageShifts && formOpen && (
        <div className="utilities-modal-backdrop" role="presentation">
          <section className="utilities-modal utilities-modal--sm" role="dialog" aria-modal="true" aria-labelledby="shift-form-title">
            <div className="utilities-modal-header">
              <div>
                <h2 id="shift-form-title">{formMode === "create" ? "Create Shift" : "Edit Shift"}</h2>
                <p>{formMode === "create" ? "New shift will be available to assign immediately" : "Changes apply immediately"}</p>
              </div>
              <button className="icon-button" onClick={closeForm} aria-label="Close">
                <X size={18} />
              </button>
            </div>

            <form onSubmit={submitForm}>
              <div className="utilities-modal-body">
                <label className="utilities-field">
                  <span className="utilities-field-label">
                    Shift Name <span className="utilities-required">*</span>
                  </span>
                  <input
                    className="utilities-input"
                    type="text"
                    value={form.name}
                    onChange={(e) => {
                      setForm((c) => ({ ...c, name: e.target.value }));
                      setNameError(null);
                    }}
                    placeholder="e.g. Morning Shift"
                    required
                    autoFocus
                  />
                  {nameError && <span className="utilities-field-error">{nameError}</span>}
                </label>

                <div className="utilities-field-row">
                  <label className="utilities-field">
                    <span className="utilities-field-label">
                      Start Time <span className="utilities-required">*</span>
                    </span>
                    <input
                      className="utilities-input"
                      type="time"
                      value={form.startTime}
                      onChange={(e) => {
                        setForm((c) => ({ ...c, startTime: e.target.value }));
                        setTimeError(null);
                      }}
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
                      value={form.endTime}
                      onChange={(e) => {
                        setForm((c) => ({ ...c, endTime: e.target.value }));
                        setTimeError(null);
                      }}
                      required
                    />
                  </label>
                </div>
                {timeError ? (
                  <span className="utilities-field-error">{timeError}</span>
                ) : (
                  liveHours && <span className="utilities-hint">Total working hours: {liveHours}</span>
                )}

                <div className="utilities-field-row utilities-equal-field-row">
                  <label className="utilities-field">
                    <span className="utilities-field-label">Morning Break (minutes)</span>
                    <input
                      className="utilities-input"
                      type="number"
                      min="0"
                      step="1"
                      value={form.morningBreakMinutes}
                      onChange={(e) => setForm((c) => ({ ...c, morningBreakMinutes: e.target.value }))}
                      placeholder="0"
                    />
                  </label>
                  <label className="utilities-field">
                    <span className="utilities-field-label">Afternoon Break (minutes)</span>
                    <input
                      className="utilities-input"
                      type="number"
                      min="0"
                      step="1"
                      value={form.afternoonBreakMinutes}
                      onChange={(e) => setForm((c) => ({ ...c, afternoonBreakMinutes: e.target.value }))}
                      placeholder="0"
                    />
                  </label>
                </div>

                <label className="utilities-field">
                  <span className="utilities-field-label">Lunch Break (minutes)</span>
                  <input
                    className="utilities-input"
                    type="number"
                    min="0"
                    step="1"
                    value={form.lunchBreakMinutes}
                    onChange={(e) => setForm((c) => ({ ...c, lunchBreakMinutes: e.target.value }))}
                    placeholder="0"
                  />
                </label>
                <span className="utilities-hint">
                  For a straight schedule (no morning/afternoon breaks), set Morning and Afternoon to 0 and Lunch to 30.
                </span>

                <label className="utilities-checkbox">
                  <input
                    type="checkbox"
                    checked={form.enableRounding}
                    onChange={(e) => setForm((c) => ({ ...c, enableRounding: e.target.checked }))}
                  />
                  <span>Enable rounding rules</span>
                </label>

                {form.enableRounding && (
                  <label className="utilities-field">
                    <span className="utilities-field-label">Rounding Interval (minutes)</span>
                    <input
                      className="utilities-input"
                      type="number"
                      min="1"
                      step="1"
                      value={form.roundingIntervalMinutes}
                      onChange={(e) => setForm((c) => ({ ...c, roundingIntervalMinutes: e.target.value }))}
                    />
                  </label>
                )}

                <div className="utilities-field-row utilities-equal-field-row">
                  <label className="utilities-field">
                    <span className="utilities-field-label">Late Threshold (minutes)</span>
                    <input
                      className="utilities-input"
                      type="number"
                      min="0"
                      step="1"
                      value={form.lateThresholdMinutes}
                      onChange={(e) => setForm((c) => ({ ...c, lateThresholdMinutes: e.target.value }))}
                      placeholder="0"
                    />
                  </label>
                  <label className="utilities-field">
                    <span className="utilities-field-label">Undertime Threshold (minutes)</span>
                    <input
                      className="utilities-input"
                      type="number"
                      min="0"
                      step="1"
                      value={form.undertimeThresholdMinutes}
                      onChange={(e) => setForm((c) => ({ ...c, undertimeThresholdMinutes: e.target.value }))}
                      placeholder="0"
                    />
                  </label>
                </div>

                <label className="utilities-checkbox">
                  <input
                    type="checkbox"
                    checked={form.autoShiftAdjustment}
                    onChange={(e) => setForm((c) => ({ ...c, autoShiftAdjustment: e.target.checked }))}
                  />
                  <span>Auto shift adjustment</span>
                </label>
                <span className="utilities-hint">
                  If an employee arrives within another shift's late threshold window, automatically apply that shift's rules for the day.
                </span>
              </div>

              <div className="utilities-modal-actions">
                <button
                  type="submit"
                  className="primary-button"
                  disabled={isSaving || !form.name.trim() || !form.startTime || !form.endTime}
                >
                  {isSaving ? "Saving…" : formMode === "create" ? "Create Shift" : "Save Changes"}
                </button>
                <button type="button" className="outline-button" onClick={closeForm} disabled={isSaving}>
                  Cancel
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {/* ── View Shift modal ── */}
      {viewShift && (
        <div className="utilities-modal-backdrop" role="presentation">
          <section className="utilities-modal utilities-modal--sm" role="dialog" aria-modal="true" aria-labelledby="view-shift-title">
            <div className="utilities-modal-header">
              <div>
                <h2 id="view-shift-title">{viewShift.name}</h2>
                <p>Shift details</p>
              </div>
              <button className="icon-button" onClick={() => setViewShift(null)} aria-label="Close">
                <X size={18} />
              </button>
            </div>

            <div className="utilities-modal-body">
              <div className="utilities-audit-detail-grid">
                <div>
                  <span>Time</span>
                  <strong>{viewShift.startTime} – {viewShift.endTime}</strong>
                </div>
                <div>
                  <span>Total Working Hours</span>
                  <strong>{computeShiftHours(viewShift.startTime, viewShift.endTime) ?? "—"}</strong>
                </div>
                <div>
                  <span>Breaks</span>
                  <strong>
                    Morning {viewShift.morningBreakMinutes}m · Afternoon {viewShift.afternoonBreakMinutes}m · Lunch {viewShift.lunchBreakMinutes}m
                  </strong>
                </div>
                <div>
                  <span>Rounding Rules</span>
                  <Badge tone={viewShift.enableRounding ? "success" : "neutral"}>
                    {viewShift.enableRounding ? `Every ${viewShift.roundingIntervalMinutes} min` : "Disabled"}
                  </Badge>
                </div>
                <div>
                  <span>Late Threshold</span>
                  <strong>{viewShift.lateThresholdMinutes} minutes</strong>
                </div>
                <div>
                  <span>Undertime Threshold</span>
                  <strong>{viewShift.undertimeThresholdMinutes} minutes</strong>
                </div>
                <div>
                  <span>Auto Shift Adjustment</span>
                  <Badge tone={viewShift.autoShiftAdjustment ? "success" : "neutral"}>
                    {viewShift.autoShiftAdjustment ? "Enabled" : "Disabled"}
                  </Badge>
                </div>
                <div>
                  <span>Employees Assigned</span>
                  <strong>{viewShift._count?.schedules ?? 0}</strong>
                </div>
                <div>
                  <span>Status</span>
                  <Badge tone={viewShift.isActive ? "success" : "neutral"}>{viewShift.isActive ? "Active" : "Inactive"}</Badge>
                </div>
                <div>
                  <span>Created</span>
                  <strong>
                    {formatDate(viewShift.createdAt)}
                    {actorDisplayName(viewShift.createdByUser) ? ` — ${actorDisplayName(viewShift.createdByUser)}` : ""}
                  </strong>
                </div>
                <div>
                  <span>Last Updated</span>
                  <strong>
                    {formatDate(viewShift.updatedAt)}
                    {actorDisplayName(viewShift.updatedByUser) ? ` — ${actorDisplayName(viewShift.updatedByUser)}` : ""}
                  </strong>
                </div>
              </div>
            </div>

            <div className="utilities-modal-actions">
              {canManageShifts && (
                <>
                  <button className="utilities-edit-button" onClick={() => openEditForm(viewShift)}>
                    <Pencil size={13} /> Edit
                  </button>
                  {viewShift.isActive ? (
                    <button className="utilities-archive-button" onClick={() => requestArchive(viewShift)}>
                      <Archive size={13} /> Archive
                    </button>
                  ) : (
                    <button className="utilities-archive-button restore" onClick={() => requestRestore(viewShift)}>
                      <RotateCcw size={13} /> Restore
                    </button>
                  )}
                </>
              )}
              <button className="outline-button" onClick={() => setViewShift(null)}>
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
