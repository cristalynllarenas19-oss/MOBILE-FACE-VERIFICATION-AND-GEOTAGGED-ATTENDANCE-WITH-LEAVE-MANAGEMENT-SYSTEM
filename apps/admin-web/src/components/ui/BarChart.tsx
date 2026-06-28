import { useState } from "react";
import { DropdownFilter } from "./DropdownFilter";
import "./BarChart.css";

export type BarChartDatum = {
  label: string;
  value: number;
  color: string;
};

export type DeptAttendanceRow = {
  department: string;
  present: number;
  late: number;
  absent: number;
  onLeave: number;
  officialBusiness: number;
};

const SERIES = [
  { key: "present",          label: "Present",           color: "#1baf7a" },
  { key: "late",             label: "Late",              color: "#eda100" },
  { key: "absent",           label: "Absent",            color: "#e34948" },
  { key: "onLeave",          label: "On leave",          color: "#4a3aa7" },
  { key: "officialBusiness", label: "Official business", color: "#2a78d6" },
] as const;

type SeriesKey = typeof SERIES[number]["key"];

type SimpleProps = {
  mode?: "simple";
  data: BarChartDatum[];
  height?: number;
};

type DeptProps = {
  mode: "department";
  data: DeptAttendanceRow[];
  period?: "today" | "week" | "month";
  onPeriodChange?: (p: "today" | "week" | "month") => void;
};

type BarChartProps = SimpleProps | DeptProps;

// ── Simple vertical bar chart ────────────────────────────────────────────────
function SimpleBarChart({ data, height = 180 }: { data: BarChartDatum[]; height?: number }) {
  const maxValue = Math.max(1, ...data.map((item) => item.value));
  return (
    <div className="bar-chart" style={{ height }}>
      {data.map((item) => (
        <div className="bar-chart-col" key={item.label} title={`${item.label}: ${item.value}`}>
          <span className="bar-chart-value">{item.value}</span>
          <div className="bar-chart-track">
            <div
              className="bar-chart-bar"
              style={{
                height: `${item.value === 0 ? 0 : Math.max(4, (item.value / maxValue) * 100)}%`,
                background: item.color,
              }}
            />
          </div>
          <span className="bar-chart-label">{item.label}</span>
        </div>
      ))}
    </div>
  );
}

// ── Single department card ───────────────────────────────────────────────────
function DeptCard({
  row,
  max,
  view,
}: {
  row: DeptAttendanceRow;
  max: number;
  view: "grouped" | "stacked";
}) {
  const [hovered, setHovered] = useState(false);
  const total = SERIES.reduce((s, sr) => s + (row[sr.key as SeriesKey] as number), 0);

  return (
    <div
      className={`bc-dept-card${hovered ? " bc-dept-card--hovered" : ""}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Card header */}
      <div className="bc-dept-card-header">
        <span className="bc-dept-card-name">{row.department}</span>
        <span className="bc-dept-card-total">{total} total</span>
      </div>

      {/* Bars */}
      <div className="bc-dept-card-bars">
        {view === "stacked" ? (
          <div className="bc-stack-wrap">
            <div className="bc-stack-track">
              {SERIES.map((s) => {
                const val = row[s.key as SeriesKey] as number;
                const pct = total > 0 ? (val / max) * 100 : 0;
                return pct > 0 ? (
                  <div
                    key={s.key}
                    className="bc-stack-seg"
                    title={`${s.label}: ${val}`}
                    style={{ width: `${pct}%`, background: s.color }}
                  />
                ) : null;
              })}
            </div>
          </div>
        ) : (
          <div className="bc-group-bars">
            {SERIES.map((s) => {
              const val = row[s.key as SeriesKey] as number;
              return (
                <div key={s.key} className="bc-group-row">
                  <span className="bc-group-series-label">
                    <span className="bc-group-series-dot" style={{ background: s.color }} />
                    {s.label}
                  </span>
                  <div className="bc-group-track">
                    <div
                      className="bc-group-bar"
                      style={{ width: `${(val / max) * 100}%`, background: s.color }}
                    />
                  </div>
                  <span className="bc-group-val">{val}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Tooltip on hover */}
      {hovered && (
        <div className="bc-tooltip">
          <strong>{row.department}</strong>
          {SERIES.map((s) => (
            <div key={s.key} className="bc-tip-row">
              <span>
                <span className="bc-tip-dot" style={{ background: s.color }} />
                {s.label}
              </span>
              <span>{row[s.key as SeriesKey]}</span>
            </div>
          ))}
          <div className="bc-tip-total">
            <span>Total</span>
            <span>{total}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Department horizontal bar chart ──────────────────────────────────────────
function DeptBarChart({ data, period = "today", onPeriodChange }: Omit<DeptProps, "mode">) {
  const [view, setView] = useState<"grouped" | "stacked">("grouped");
  const [selectedDept, setSelectedDept] = useState<string>("ALL");

  const deptOptions = data.map((r) => ({ value: r.department, label: r.department }));

  const filteredData = selectedDept === "ALL"
    ? data
    : data.filter((r) => r.department === selectedDept);

  const max = filteredData.reduce((m, row) => {
    const val =
      view === "stacked"
        ? SERIES.reduce((s, sr) => s + (row[sr.key as SeriesKey] as number), 0)
        : Math.max(...SERIES.map((sr) => row[sr.key as SeriesKey] as number));
    return Math.max(m, val);
  }, 1);

  return (
    <div className="bc-dept">
      {/* Controls */}
      <div className="bc-controls">
        <div className="bc-controls-left">
          <div className="bc-toggles">
            {(["grouped", "stacked"] as const).map((v) => (
              <button
                key={v}
                className={`bc-toggle${view === v ? " active" : ""}`}
                onClick={() => setView(v)}
              >
                {v === "grouped" ? "Grouped" : "Stacked"}
              </button>
            ))}
          </div>

          <DropdownFilter
            value={selectedDept}
            options={deptOptions}
            onChange={setSelectedDept}
            allLabel="All Departments"
            menuLabel="Department"
            allValue="ALL"
            ariaLabel="Filter by department"
            className="bc-dept-dropdown"
          />
        </div>

        {onPeriodChange && (
          <div className="bc-period-tabs">
            {([["today", "Today"], ["week", "Week"], ["month", "Month"]] as const).map(([k, lbl]) => (
              <button
                key={k}
                className={`bc-period-tab${period === k ? " active" : ""}`}
                onClick={() => onPeriodChange(k)}
              >
                {lbl}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="bc-legend">
        {SERIES.map((s) => (
          <span key={s.key} className="bc-leg-item">
            <span className="bc-leg-dot" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>

      {/* Department cards */}
      <div className="bc-dept-cards">
        {filteredData.length === 0 ? (
          <p className="bc-empty">No department data available.</p>
        ) : (
          filteredData.map((row) => (
            <DeptCard key={row.department} row={row} max={max} view={view} />
          ))
        )}
      </div>
    </div>
  );
}

// ── Export ───────────────────────────────────────────────────────────────────
export function BarChart(props: BarChartProps) {
  if (props.mode === "department") {
    return (
      <DeptBarChart
        data={props.data}
        period={props.period}
        onPeriodChange={props.onPeriodChange}
      />
    );
  }
  return <SimpleBarChart data={props.data} height={props.height} />;
}