import { useEffect, useState } from "react";
import { ShieldCheck, Timer } from "lucide-react";
import { apiRequest } from "../../lib/api";
import type { Notification } from "./UtilitiesPage";

type UndertimeSettings = {
  filingDaysOfMonth: number[];
};

// Two fixed inputs rather than a free-form list — the underlying rule is
// "pick two days of the month," and the API just wants a sorted, deduped
// int array back (see UndertimeService.updateSettings).
export function UndertimeSettingsCard({
  canManage,
  notify,
}: {
  canManage: boolean;
  notify: (notification: Notification) => void;
}) {
  const [dayOne, setDayOne] = useState("8");
  const [dayTwo, setDayTwo] = useState("23");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    apiRequest<UndertimeSettings>("/undertime-filings/settings")
      .then((settings) => {
        const [first, second] = settings.filingDaysOfMonth;
        if (first != null) setDayOne(String(first));
        if (second != null) setDayTwo(String(second));
      })
      .catch(() => undefined);
  }, []);

  function save() {
    const days = [Number(dayOne), Number(dayTwo)].filter((day) => Number.isInteger(day) && day >= 1 && day <= 31);
    if (days.length === 0) {
      notify({ type: "error", message: "Enter at least one valid day (1-31)." });
      return;
    }

    setIsSaving(true);
    apiRequest<UndertimeSettings>("/undertime-filings/settings", {
      method: "PATCH",
      body: JSON.stringify({ filingDaysOfMonth: days }),
    })
      .then((settings) => {
        const [first, second] = settings.filingDaysOfMonth;
        if (first != null) setDayOne(String(first));
        setDayTwo(second != null ? String(second) : "");
        notify({ type: "success", message: "Undertime filing days updated." });
      })
      .catch((err) => {
        notify({ type: "error", message: err instanceof Error ? err.message : "Unable to update filing days." });
      })
      .finally(() => setIsSaving(false));
  }

  return (
    <section className="undertime-settings-card">
      <div className="undertime-settings-icon">
        <Timer size={20} />
      </div>
      <h4>Undertime Filing Days</h4>
      <p>
        Days of the month employees may file undertime. Each filing day settles the cutoff that closed right before it —
        for example, the 8th settles the cutoff that ended on the 25th of the previous month.
      </p>

      <div className="undertime-settings-fields">
        <label className="utilities-field">
          <span className="utilities-field-label">Filing Day 1</span>
          <input
            className="utilities-input"
            type="number"
            min="1"
            max="31"
            value={dayOne}
            disabled={!canManage}
            onChange={(e) => setDayOne(e.target.value)}
          />
        </label>
        <label className="utilities-field">
          <span className="utilities-field-label">Filing Day 2</span>
          <input
            className="utilities-input"
            type="number"
            min="1"
            max="31"
            value={dayTwo}
            disabled={!canManage}
            onChange={(e) => setDayTwo(e.target.value)}
          />
        </label>
      </div>

      {canManage ? (
        <>
          <button className="primary-button" onClick={save} disabled={isSaving}>
            {isSaving ? "Saving…" : "Save Filing Days"}
          </button>
          <span className="backup-restore-action-note">
            <ShieldCheck size={13} /> This applies to every employee immediately.
          </span>
        </>
      ) : (
        <span className="backup-restore-action-note">
          <ShieldCheck size={13} /> Only administrators can edit filing days.
        </span>
      )}
    </section>
  );
}
