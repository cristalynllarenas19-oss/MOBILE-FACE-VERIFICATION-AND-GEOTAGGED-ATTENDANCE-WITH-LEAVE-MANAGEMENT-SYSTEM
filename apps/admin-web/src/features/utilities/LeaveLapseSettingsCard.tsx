import { useEffect, useState } from "react";
import { Hourglass, ShieldCheck } from "lucide-react";
import { apiRequest } from "../../lib/api";
import type { Notification } from "./UtilitiesPage";

type LeaveSettings = { lapseGraceDays: number; reviewReminderHours: number };

// The two system-wide timings for an undecided leave request (see
// LeaveLapseService on the backend) — both stored in the database:
// - how long after filing its reviewers are reminded (a leave type can set
//   its own, in the leave type form);
// - how long after its leave dates pass before it is marked Lapsed.
export function LeaveLapseSettingsCard({
  canManage,
  notify,
}: {
  canManage: boolean;
  notify: (notification: Notification) => void;
}) {
  const [reminderHours, setReminderHours] = useState("24");
  const [graceDays, setGraceDays] = useState("7");
  const [saved, setSaved] = useState({ reminderHours: "24", graceDays: "7" });
  const [isSaving, setIsSaving] = useState(false);

  const apply = (settings: LeaveSettings) => {
    const next = { reminderHours: String(settings.reviewReminderHours), graceDays: String(settings.lapseGraceDays) };
    setReminderHours(next.reminderHours);
    setGraceDays(next.graceDays);
    setSaved(next);
  };

  useEffect(() => {
    apiRequest<LeaveSettings>("/leave-settings").then(apply).catch(() => undefined);
  }, []);

  function save() {
    const hours = Number(reminderHours);
    const days = Number(graceDays);
    if (reminderHours.trim() === "" || !Number.isInteger(hours) || hours < 1 || hours > 720) {
      notify({ type: "error", title: "Invalid Reminder Time", message: "Enter a whole number of hours between 1 and 720." });
      return;
    }
    if (graceDays.trim() === "" || !Number.isInteger(days) || days < 0 || days > 365) {
      notify({ type: "error", title: "Invalid Grace Period", message: "Enter a whole number of days between 0 and 365." });
      return;
    }

    setIsSaving(true);
    apiRequest<LeaveSettings>("/leave-settings", {
      method: "PATCH",
      body: JSON.stringify({ reviewReminderHours: hours, lapseGraceDays: days }),
    })
      .then((settings) => {
        apply(settings);
        notify({ type: "success", title: "Leave Settings Updated", message: "Reminder time and grace period updated." });
      })
      .catch((err) => {
        notify({
          type: "error",
          title: "Couldn't Update Leave Settings",
          message: err instanceof Error ? err.message : "Unable to update leave settings.",
        });
      })
      .finally(() => setIsSaving(false));
  }

  const isUnchanged = reminderHours === saved.reminderHours && graceDays === saved.graceDays;

  return (
    <section className="undertime-settings-card" style={{ marginBottom: 16 }}>
      <div className="undertime-settings-icon">
        <Hourglass size={16} />
      </div>
      <h4>Undecided Leave Requests</h4>
      <p>
        If a leave request is still awaiting a decision this many hours after it was filed, the supervisor and admins
        are reminded once. A leave type can set its own shorter time in its form. A request still undecided after its
        leave dates pass is marked Lapsed: right away if the employee reported for work on those dates, otherwise after
        the grace period.
      </p>

      <div className="undertime-panel-actions">
        <label className="utilities-field" style={{ maxWidth: 190 }}>
          <span className="utilities-field-label">Remind Reviewer After (hours)</span>
          <input
            className="utilities-input"
            type="number"
            min="1"
            max="720"
            step="1"
            value={reminderHours}
            disabled={!canManage}
            onChange={(e) => setReminderHours(e.target.value)}
          />
        </label>
        <label className="utilities-field" style={{ maxWidth: 190 }}>
          <span className="utilities-field-label">Lapse Grace Period (days)</span>
          <input
            className="utilities-input"
            type="number"
            min="0"
            max="365"
            step="1"
            value={graceDays}
            disabled={!canManage}
            onChange={(e) => setGraceDays(e.target.value)}
          />
        </label>
        {canManage && (
          <button className="primary-button" style={{ alignSelf: "flex-end" }} onClick={save} disabled={isSaving || isUnchanged}>
            {isSaving ? "Saving…" : "Save"}
          </button>
        )}
      </div>

      {!canManage && (
        <span className="backup-restore-action-note">
          <ShieldCheck size={13} />
          Only administrators can edit these settings.
        </span>
      )}
    </section>
  );
}
