import { useEffect, useState } from "react";
import { Pencil, ShieldCheck, Timer, X } from "lucide-react";
import { apiRequest } from "../../lib/api";
import type { Notification } from "./UtilitiesPage";

type FilingDaysSettings = { filingDaysOfMonth: number[] };
type CutoffSettings = {
  cutoff1Start: number;
  cutoff1End: number;
  cutoff2Start: number;
  cutoff2End: number;
};
type UndertimeSettings = FilingDaysSettings & CutoffSettings;

function ordinal(day: number): string {
  if (day >= 11 && day <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

const DAY_NUMBERS = Array.from({ length: 31 }, (_, i) => i + 1);

// Filing Days and Cutoff Periods each have their own Edit lock and Save
// button — two different API calls (UndertimeService.updateSettings /
// updateCutoffBounds) that an admin may want to change independently,
// without one accidental edit risking the other.
export function UndertimeSettingsCard({
  canManage,
  notify,
}: {
  canManage: boolean;
  notify: (notification: Notification) => void;
}) {
  const [dayOne, setDayOne] = useState("8");
  const [dayTwo, setDayTwo] = useState("23");
  const [isFilingEditing, setIsFilingEditing] = useState(false);
  const [filingSnapshot, setFilingSnapshot] = useState<{ dayOne: string; dayTwo: string } | null>(null);
  const [isSavingFiling, setIsSavingFiling] = useState(false);

  const [cutoff1Start, setCutoff1Start] = useState(11);
  const [cutoff1End, setCutoff1End] = useState(25);
  const [isCutoffEditing, setIsCutoffEditing] = useState(false);
  const [cutoffPendingStart, setCutoffPendingStart] = useState<number | null>(null);
  const [cutoffSnapshot, setCutoffSnapshot] = useState<{ start: number; end: number } | null>(null);
  const [isSavingCutoff, setIsSavingCutoff] = useState(false);

  // Cutoff 2 is never edited directly — it's always whatever's left of the
  // month once Cutoff 1's range is picked, so a gap or overlap between the
  // two is structurally impossible.
  const cutoff2Start = cutoff1End === 31 ? 1 : cutoff1End + 1;
  const cutoff2End = cutoff1Start === 1 ? 31 : cutoff1Start - 1;

  useEffect(() => {
    apiRequest<UndertimeSettings>("/undertime-filings/settings")
      .then((settings) => {
        const [first, second] = settings.filingDaysOfMonth;
        if (first != null) setDayOne(String(first));
        if (second != null) setDayTwo(String(second));
        setCutoff1Start(settings.cutoff1Start);
        setCutoff1End(settings.cutoff1End);
      })
      .catch(() => undefined);
  }, []);

  function startEditingFiling() {
    setFilingSnapshot({ dayOne, dayTwo });
    setIsFilingEditing(true);
  }

  function cancelEditingFiling() {
    if (filingSnapshot) {
      setDayOne(filingSnapshot.dayOne);
      setDayTwo(filingSnapshot.dayTwo);
    }
    setIsFilingEditing(false);
  }

  // Clicking a selected day deselects it; clicking an empty slot fills Day 1
  // then Day 2; a third click replaces Day 2, keeping Day 1 anchored.
  function toggleFilingDay(day: number) {
    if (!isFilingEditing || !canManage) return;
    if (Number(dayOne) === day) {
      setDayOne(dayTwo);
      setDayTwo("");
      return;
    }
    if (Number(dayTwo) === day) {
      setDayTwo("");
      return;
    }
    if (!dayOne) {
      setDayOne(String(day));
      return;
    }
    if (!dayTwo) {
      setDayTwo(String(day));
      return;
    }
    setDayTwo(String(day));
  }

  function saveFiling() {
    const days = [Number(dayOne), Number(dayTwo)].filter((day) => Number.isInteger(day) && day >= 1 && day <= 31);
    if (days.length === 0) {
      notify({ type: "error", message: "Enter at least one valid filing day (1-31)." });
      return;
    }

    setIsSavingFiling(true);
    apiRequest<FilingDaysSettings>("/undertime-filings/settings", {
      method: "PATCH",
      body: JSON.stringify({ filingDaysOfMonth: days }),
    })
      .then((settings) => {
        const [first, second] = settings.filingDaysOfMonth;
        if (first != null) setDayOne(String(first));
        setDayTwo(second != null ? String(second) : "");
        setIsFilingEditing(false);
        notify({ type: "success", message: "Undertime filing days updated." });
      })
      .catch((err) => {
        notify({ type: "error", message: err instanceof Error ? err.message : "Unable to update filing days." });
      })
      .finally(() => setIsSavingFiling(false));
  }

  function startEditingCutoffs() {
    setCutoffSnapshot({ start: cutoff1Start, end: cutoff1End });
    setCutoffPendingStart(null);
    setIsCutoffEditing(true);
  }

  function cancelEditingCutoffs() {
    if (cutoffSnapshot) {
      setCutoff1Start(cutoffSnapshot.start);
      setCutoff1End(cutoffSnapshot.end);
    }
    setCutoffPendingStart(null);
    setIsCutoffEditing(false);
  }

  function onCutoffDayClick(day: number) {
    if (!isCutoffEditing || !canManage) return;
    if (cutoffPendingStart == null) {
      setCutoffPendingStart(day);
      return;
    }
    const start = Math.min(cutoffPendingStart, day);
    const end = Math.max(cutoffPendingStart, day);
    // Cutoff 2's boundary is stored as a fixed day-of-month number, which
    // can't represent "the day before the 1st" or "the day after the 31st"
    // (that's a month-length-dependent day, not a fixed one) — so Cutoff 1
    // can never start on the 1st or end on the 31st, and never span the
    // whole month either.
    if (start === 1 || end === 31) {
      setCutoffPendingStart(null);
      notify({
        type: "error",
        message: "Cutoff 1 can't start on the 1st or end on the 31st — pick a range that leaves at least one day on each side for Cutoff 2.",
      });
      return;
    }
    setCutoff1Start(start);
    setCutoff1End(end);
    setCutoffPendingStart(null);
  }

  function saveCutoffs() {
    setIsSavingCutoff(true);
    apiRequest<CutoffSettings>("/undertime-filings/settings/cutoffs", {
      method: "PATCH",
      body: JSON.stringify({ cutoff1Start, cutoff1End, cutoff2Start, cutoff2End }),
    })
      .then((settings) => {
        setCutoff1Start(settings.cutoff1Start);
        setCutoff1End(settings.cutoff1End);
        setIsCutoffEditing(false);
        setCutoffPendingStart(null);
        notify({ type: "success", message: "Undertime cutoff periods updated." });
      })
      .catch((err) => {
        notify({ type: "error", message: err instanceof Error ? err.message : "Unable to update cutoff periods." });
      })
      .finally(() => setIsSavingCutoff(false));
  }

  return (
    <section className="undertime-settings-card undertime-unified-card">
      <div className="undertime-settings-icon">
        <Timer size={16} />
      </div>
      <h4>Undertime Settings</h4>
      <p>
        When employees may file undertime, and the two semi-monthly cutoff periods used to match a late attendance
        record to the right filing window.
      </p>

      <div className="undertime-unified-grid">
        <div className="undertime-panel-col">
          <span className="undertime-panel-title">Filing Days</span>
          <div className="cutoff-group">
            <p className="cutoff-picker-hint">
              {isFilingEditing ? "Click a day to select it as a filing day." : "Click Edit to change these days."}
            </p>
            <div className="filing-day-grid">
              {DAY_NUMBERS.map((day) => {
                const selected = day === Number(dayOne) || day === Number(dayTwo);
                return (
                  <button
                    key={day}
                    type="button"
                    className={`filing-day-cell${selected ? " filing-day-cell-selected" : ""}`}
                    style={{ cursor: isFilingEditing && canManage ? "pointer" : "default" }}
                    aria-pressed={selected}
                    onClick={isFilingEditing && canManage ? () => toggleFilingDay(day) : undefined}
                  >
                    {day}
                  </button>
                );
              })}
            </div>
            <p className="cutoff-group-caption">Employees may file undertime on these two days each month.</p>

            {canManage && (
              <div className="undertime-panel-actions">
                {isFilingEditing ? (
                  <button type="button" className="cutoff-edit-button cutoff-edit-button-cancel" onClick={cancelEditingFiling}>
                    <X size={12} /> Cancel
                  </button>
                ) : (
                  <button type="button" className="cutoff-edit-button" onClick={startEditingFiling}>
                    <Pencil size={12} /> Edit
                  </button>
                )}
                <button className="primary-button" onClick={saveFiling} disabled={isSavingFiling}>
                  {isSavingFiling ? "Saving…" : "Save Filing Days"}
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="undertime-panel-col">
          <span className="undertime-panel-title">Cutoff Periods</span>
          <div className="cutoff-group">
            <p className="cutoff-picker-hint">
              {!isCutoffEditing
                ? "Click Edit to change these periods."
                : cutoffPendingStart == null
                  ? "Click a day to start a new Cutoff 1 range."
                  : "Now click the last day of Cutoff 1…"}
            </p>

            <div className="filing-day-grid">
              {DAY_NUMBERS.map((day) => {
                const isPending = isCutoffEditing && cutoffPendingStart != null && day === cutoffPendingStart;
                const inCutoff1 = !isPending && day >= cutoff1Start && day <= cutoff1End;
                const variant = isPending ? "pending" : inCutoff1 ? "one" : "two";
                return (
                  <button
                    key={day}
                    type="button"
                    className={`filing-day-cell filing-day-cell-cutoff-${variant}`}
                    style={{ cursor: isCutoffEditing && canManage ? "pointer" : "default" }}
                    onClick={isCutoffEditing && canManage ? () => onCutoffDayClick(day) : undefined}
                  >
                    {day}
                  </button>
                );
              })}
            </div>

            <div className="cutoff-summary-row">
              <span className="cutoff-summary-item">
                <span className="cutoff-summary-dot cutoff-summary-dot-one" />
                Cutoff 1: {ordinal(cutoff1Start)} – {ordinal(cutoff1End)}
              </span>
              <span className="cutoff-summary-item">
                <span className="cutoff-summary-dot cutoff-summary-dot-two" />
                Cutoff 2: {ordinal(cutoff2Start)} – {ordinal(cutoff2End)} (next mo.)
              </span>
            </div>

            {canManage && (
              <div className="undertime-panel-actions">
                {isCutoffEditing ? (
                  <button type="button" className="cutoff-edit-button cutoff-edit-button-cancel" onClick={cancelEditingCutoffs}>
                    <X size={12} /> Cancel
                  </button>
                ) : (
                  <button type="button" className="cutoff-edit-button" onClick={startEditingCutoffs}>
                    <Pencil size={12} /> Edit
                  </button>
                )}
                <button className="primary-button" onClick={saveCutoffs} disabled={isSavingCutoff}>
                  {isSavingCutoff ? "Saving…" : "Save Cutoff Periods"}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <span className="backup-restore-action-note">
        <ShieldCheck size={13} />
        {canManage
          ? "Each panel saves independently and applies to every employee immediately."
          : "Only administrators can edit undertime settings."}
      </span>
    </section>
  );
}
