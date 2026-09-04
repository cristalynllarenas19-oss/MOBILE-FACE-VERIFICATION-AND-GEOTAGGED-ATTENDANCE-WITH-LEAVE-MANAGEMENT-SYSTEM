import "./AttendanceDonut.css";

const SEGMENTS = [
  { key: "present", label: "Present", color: "#1baf7a" },
  { key: "absent", label: "Absent", color: "#e34948" },
  { key: "onLeave", label: "On Leave", color: "#4a3aa7" },
] as const;

const SIZE = 112;
const STROKE = 20;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const SEGMENT_GAP = 1;

type DonutValues = { present: number; absent: number; onLeave: number };

export function AttendanceDonutChart({ present, absent, onLeave }: DonutValues) {
  const values: Record<(typeof SEGMENTS)[number]["key"], number> = { present, absent, onLeave };
  const total = present + absent + onLeave;

  let cumulative = 0;

  return (
    <div className="adn">
      <div className="adn-chart">
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke="#eef2f7"
            strokeWidth={STROKE}
          />
          <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
            {SEGMENTS.map((segment) => {
              const value = values[segment.key];
              const fraction = total > 0 ? value / total : 0;
              const dash = Math.max(0, fraction * CIRCUMFERENCE - (fraction > 0 ? SEGMENT_GAP : 0));
              const offset = -(cumulative * CIRCUMFERENCE);
              cumulative += fraction;

              if (value === 0) return null;


              if (value === total) {
                return (
                  <circle
                    key={segment.key}
                    cx={SIZE / 2}
                    cy={SIZE / 2}
                    r={RADIUS}
                    fill="none"
                    stroke={segment.color}
                    strokeWidth={STROKE}
                    className="adn-segment"
                  />
                );
              }

              return (
                <circle
                  key={segment.key}
                  cx={SIZE / 2}
                  cy={SIZE / 2}
                  r={RADIUS}
                  fill="none"
                  stroke={segment.color}
                  strokeWidth={STROKE}
                  strokeDasharray={`${dash} ${CIRCUMFERENCE - dash}`}
                  strokeDashoffset={offset}
                  strokeLinecap="butt"
                  className="adn-segment"
                />
              );
            })}
          </g>
        </svg>
        <div className="adn-center">
          <strong>{total}</strong>
          <span>Total</span>
        </div>
      </div>
    </div>
  );
}

export function AttendanceDonutLegend({ present, absent, onLeave }: DonutValues) {
  const values: Record<(typeof SEGMENTS)[number]["key"], number> = { present, absent, onLeave };
  const total = present + absent + onLeave;

  return (
    <div className="adn-legend">
      {SEGMENTS.map((segment) => {
        const value = values[segment.key];
        const pct = total > 0 ? Math.round((value / total) * 100) : 0;
        return (
          <div className="adn-leg-row" key={segment.key}>
            <span className="adn-leg-dot" style={{ background: segment.color }} />
            <span className="adn-leg-label">{segment.label}</span>
            <span className="adn-leg-value">{pct}%</span>
            <span className="adn-leg-count">({value})</span>
          </div>
        );
      })}
    </div>
  );
}
