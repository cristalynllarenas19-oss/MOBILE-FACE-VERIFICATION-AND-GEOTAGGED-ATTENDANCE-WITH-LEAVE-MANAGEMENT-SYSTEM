import { useEffect, useRef, useState } from "react";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";

const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function toDateOnly(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function parseIsoDate(value: string) {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function toIsoDate(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

type Props = {
  value: string; // "YYYY-MM-DD" or ""
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  isDateDisabled?: (date: Date) => string | undefined;
  // Same shape, checked separately so it gets its own visual treatment (amber
  // "day off", not the red "conflict" above) — e.g. a weekly rest day or a
  // day outside the employee's own working-days schedule.
  isDateNonWorking?: (date: Date) => string | undefined;
  placeholder?: string;
  // Which edge the popover hangs from. A field near the right edge of its
  // container needs "right" so the 280px-wide popover opens leftward
  // instead of overflowing past the container's edge.
  align?: "left" | "right";
};

// Native <input type="date"> can only express a single contiguous
// min/max range — it can't grey out arbitrary individual days (e.g. dates
// already covered by a filed leave of this type). This replaces it with a
// small popover month-grid that can.
export function CalendarPicker({ value, onChange, min, max, isDateDisabled, isDateNonWorking, placeholder, align = "left" }: Props) {
  const [open, setOpen] = useState(false);
  const selected = value ? parseIsoDate(value) : undefined;
  const [viewMonth, setViewMonth] = useState(() => toDateOnly(selected ?? new Date()));
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) setViewMonth(toDateOnly(selected ? parseIsoDate(value) : new Date()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const minDate = min ? parseIsoDate(min) : undefined;
  const maxDate = max ? parseIsoDate(max) : undefined;

  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const leadingBlanks = firstOfMonth.getDay();

  const cells: Array<Date | null> = [];
  for (let i = 0; i < leadingBlanks; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push(new Date(year, month, day));

  const canGoPrev = !minDate || new Date(year, month, 0) >= minDate;

  return (
    <div ref={containerRef} style={{ position: "relative", flex: 1 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
          width: "100%", height: 48, border: `1px solid ${open ? "#062B59" : "#E2E8F0"}`,
          borderRadius: 12, padding: "0 14px",
          background: "#FFFFFF", cursor: "pointer", fontSize: 14,
        }}
      >
        <span style={{ color: value ? "#0F172A" : "#94A3B8" }}>
          {selected ? selected.toLocaleDateString() : placeholder ?? "Select date"}
        </span>
        <Calendar size={16} color="#64748B" />
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 6px)",
          ...(align === "right" ? { right: 0 } : { left: 0 }),
          zIndex: 60,
          background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 14,
          boxShadow: "0 8px 28px rgba(6,43,89,0.16)", padding: 14, width: 280,
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <button
              type="button"
              onClick={() => canGoPrev && setViewMonth(new Date(year, month - 1, 1))}
              disabled={!canGoPrev}
              style={{ border: "none", background: "none", cursor: canGoPrev ? "pointer" : "default", padding: 4, display: "flex" }}
            >
              <ChevronLeft size={18} color={canGoPrev ? "#062B59" : "#CBD5E1"} />
            </button>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#062B59" }}>{MONTH_LABELS[month]} {year}</span>
            <button
              type="button"
              onClick={() => setViewMonth(new Date(year, month + 1, 1))}
              style={{ border: "none", background: "none", cursor: "pointer", padding: 4, display: "flex" }}
            >
              <ChevronRight size={18} color="#062B59" />
            </button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", marginBottom: 2 }}>
            {WEEKDAY_LABELS.map((label, i) => (
              <span key={i} style={{ textAlign: "center", fontSize: 10, fontWeight: 700, color: "#94A3B8", paddingBottom: 4 }}>
                {label}
              </span>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
            {cells.map((date, index) => {
              if (!date) return <div key={index} />;
              // Three different reasons a day can't be picked, kept visually
              // distinct: an actual conflict with an existing filed request
              // (red), a day off / non-working day per the employee's own
              // schedule (amber), or simply outside the min/max range, e.g.
              // no remaining balance left to cover it (muted grey — nothing
              // wrong with the date itself).
              const conflictReason = isDateDisabled?.(date);
              const conflict = Boolean(conflictReason);
              const nonWorkingReason = !conflict ? isDateNonWorking?.(date) : undefined;
              const nonWorking = Boolean(nonWorkingReason);
              const outOfRange = !conflict && !nonWorking && ((minDate && date < minDate) || (maxDate && date > maxDate));
              const disabled = conflict || nonWorking || outOfRange;
              const isSelected = selected && toIsoDate(date) === toIsoDate(selected);
              return (
                <button
                  key={index}
                  type="button"
                  disabled={disabled}
                  title={conflictReason ?? nonWorkingReason}
                  onClick={() => { onChange(toIsoDate(date)); setOpen(false); }}
                  style={{
                    aspectRatio: "1", border: "none", borderRadius: 10,
                    fontSize: 12, fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer",
                    background: isSelected ? "#062B59" : conflict ? "#FEE2E2" : nonWorking ? "#FEF3C7" : "transparent",
                    color: isSelected ? "#FFFFFF" : conflict ? "#FCA5A5" : nonWorking ? "#D97706" : outOfRange ? "#CBD5E1" : "#334155",
                    // Soft card: a lifted shadow under the selected day for depth.
                    boxShadow: isSelected ? "0 4px 10px rgba(6,43,89,0.32)" : "none",
                  }}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10 }}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: "#FEE2E2", display: "inline-block" }} />
            <span style={{ fontSize: 10.5, color: "#64748B" }}>Already filed for this leave type</span>
          </div>
          {isDateNonWorking && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
              <span style={{ width: 9, height: 9, borderRadius: 3, background: "#FEF3C7", display: "inline-block" }} />
              <span style={{ fontSize: 10.5, color: "#64748B" }}>Day off / non-working day</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
