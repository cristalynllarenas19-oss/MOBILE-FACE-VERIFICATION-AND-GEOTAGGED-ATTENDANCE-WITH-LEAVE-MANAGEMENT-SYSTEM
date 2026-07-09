import "./MonthlyAttendanceChart.css";

export type MonthlyBarDay = {
  day: number;
  date: string;
  present: number;
  late: number;
  absent: number;
  onLeave: number;
  isDayOff?: boolean;
};

const SEGMENTS = [
  { key: "present", label: "Present", color: "#1baf7a" },
  { key: "late", label: "Late", color: "#eda100" },
  { key: "absent", label: "Absent", color: "#e34948" },
  { key: "onLeave", label: "On leave", color: "#4a3aa7" },
] as const;

function formatShortDate(isoDate: string) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function MonthlyAttendanceChart({
  days,
  selectedDay,
  onSelectDay,
}: {
  days: MonthlyBarDay[];
  selectedDay: number | null;
  onSelectDay: (day: MonthlyBarDay) => void;
}) {
  const maxTotal = Math.max(1, ...days.map((d) => d.present + d.late + d.absent + d.onLeave));

  return (
    <div className="mabar">
      <div className="mabar-legend">
        {SEGMENTS.map((s) => (
          <span key={s.key} className="mabar-leg-item">
            <span className="mabar-leg-dot" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>

      <div className="mabar-track">
        {days.map((day) => {
          const total = day.present + day.late + day.absent + day.onLeave;
          const isSelected = selectedDay === day.day;

          return (
            <button
              type="button"
              key={day.day}
              className={`mabar-col${isSelected ? " selected" : ""}${day.isDayOff ? " day-off" : total === 0 ? " empty" : ""}`}
              onClick={() => onSelectDay(day)}
              aria-pressed={isSelected}
              aria-label={
                day.isDayOff
                  ? `${formatShortDate(day.date)}: Day off`
                  : `${formatShortDate(day.date)}: ${day.present} present, ${day.late} late, ${day.absent} absent, ${day.onLeave} on leave`
              }
            >
              <div className="mabar-tooltip">
                <strong>{formatShortDate(day.date)}</strong>
                {day.isDayOff ? (
                  <span>Day Off</span>
                ) : (
                  <>
                    <span><i style={{ background: "#1baf7a" }} />Present {day.present}</span>
                    <span><i style={{ background: "#eda100" }} />Late {day.late}</span>
                    <span><i style={{ background: "#e34948" }} />Absent {day.absent}</span>
                    <span><i style={{ background: "#4a3aa7" }} />On leave {day.onLeave}</span>
                  </>
                )}
              </div>

              <div className="mabar-stack">
                {day.isDayOff ? (
                  <div className="mabar-seg mabar-seg-dayoff" style={{ height: "100%" }} />
                ) : total === 0 ? (
                  <div className="mabar-seg mabar-seg-empty" style={{ height: "100%" }} />
                ) : (
                  SEGMENTS.map((s) => {
                    const value = day[s.key];
                    if (value === 0) return null;
                    return (
                      <div
                        key={s.key}
                        className="mabar-seg"
                        style={{ height: `${(value / maxTotal) * 100}%`, background: s.color }}
                      />
                    );
                  })
                )}
              </div>
              <small className="mabar-day-label">{day.day}</small>
            </button>
          );
        })}
      </div>
    </div>
  );
}
