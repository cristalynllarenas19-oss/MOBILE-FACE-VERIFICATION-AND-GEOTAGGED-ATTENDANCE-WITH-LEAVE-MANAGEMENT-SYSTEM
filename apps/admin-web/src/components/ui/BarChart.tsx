import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, X } from "lucide-react";
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

export type AttendanceNavigateFilter = {
  department: string;
  status: string;
  date: string;
};

const SERIES = [
  { key: "present",          label: "Present",           color: "#1baf7a", status: "PRESENT" },
  { key: "late",             label: "Late",              color: "#eda100", status: "LATE" },
  { key: "absent",           label: "Absent",            color: "#e34948", status: "ABSENT" },
  { key: "onLeave",          label: "On leave",          color: "#4a3aa7", status: "ON_LEAVE" },
  { key: "officialBusiness", label: "Official business", color: "#2a78d6", status: "OFFICIAL_BUSINESS" },
] as const;

type SeriesKey = typeof SERIES[number]["key"];

const SORT_OPTIONS = [
  { value: "present",          label: "Most present" },
  { value: "absent",           label: "Most absent" },
  { value: "late",             label: "Most late" },
  { value: "onLeave",          label: "Most on leave" },
  { value: "officialBusiness", label: "Most official business" },
  { value: "alphabetical",     label: "Alphabetical" },
] as const;

type SortByValue = typeof SORT_OPTIONS[number]["value"];

function sortDeptRows(data: DeptAttendanceRow[], sortBy: SortByValue | null) {
  if (!sortBy) return data;
  if (sortBy === "alphabetical") {
    return [...data].sort((a, b) => a.department.localeCompare(b.department));
  }
  return [...data].sort((a, b) => (b[sortBy] as number) - (a[sortBy] as number));
}

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
  /** ISO (YYYY-MM-DD) date the department rows belong to — required to make rows clickable. */
  date?: string;
  /** Called when a non-zero status row (or its tooltip) is clicked. */
  onNavigate?: (filter: AttendanceNavigateFilter) => void;
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

// ── Single status row (grouped view) ─────────────────────────────────────────
// Clickable when it has a non-zero count and a navigate handler is available.
function DeptRow({
  series,
  value,
  total,
  max,
  onClick,
}: {
  series: (typeof SERIES)[number];
  value: number;
  total: number;
  max: number;
  onClick?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const clickable = value > 0 && Boolean(onClick);

  return (
    <div
      className="bc-group-row-wrap"
      onMouseEnter={() => clickable && setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className={[
          "bc-group-row",
          clickable ? "bc-group-row--clickable" : "",
          clickable && hovered ? "bc-group-row--hovered" : "",
        ].filter(Boolean).join(" ")}
        onClick={clickable ? onClick : undefined}
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        onKeyDown={
          clickable
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onClick?.();
                }
              }
            : undefined
        }
      >
        <span className="bc-group-series-label">
          <span className="bc-group-series-dot" style={{ background: series.color }} />
          {series.label}
        </span>
        <div className="bc-group-track">
          <div
            className="bc-group-bar"
            style={{ width: `${(value / max) * 100}%`, background: series.color }}
          />
        </div>
        <span className="bc-group-val">
          <span className="bc-group-val-frac">{value}/{total}</span>
          <span className="bc-group-val-icon">
            {clickable && <ArrowUpRight size={11} />}
          </span>
        </span>
      </div>

      {clickable && hovered && (
        <button type="button" className="bc-row-tooltip" onClick={onClick}>
          View in Attendance →
        </button>
      )}
    </div>
  );
}

// ── Single department card ───────────────────────────────────────────────────
function DeptCard({
  row,
  max,
  view,
  date,
  onNavigate,
}: {
  row: DeptAttendanceRow;
  max: number;
  view: "grouped" | "stacked";
  date?: string;
  onNavigate?: (filter: AttendanceNavigateFilter) => void;
}) {
  const total = SERIES.reduce((s, sr) => s + (row[sr.key as SeriesKey] as number), 0);

  return (
    <div className="bc-dept-card">
      {/* Card header — always visible, never covered by the hover tooltip */}
      <div className="bc-dept-card-header">
        <span className="bc-dept-card-name">{row.department}</span>
        <span className="bc-dept-card-total">{total} employee{total === 1 ? "" : "s"}</span>
      </div>
      <p className="bc-dept-card-hint">Click a status to view those employees in Attendance</p>

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
                <DeptRow
                  key={s.key}
                  series={s}
                  value={val}
                  total={total}
                  max={max}
                  onClick={
                    onNavigate && date
                      ? () => onNavigate({ department: row.department, status: s.status, date })
                      : undefined
                  }
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sort-by dropdown (native-select-style placeholder) ───────────────────────
function SortDropdown({
  value,
  onChange,
  onClear,
}: {
  value: SortByValue | null;
  onChange: (value: SortByValue) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [open]);

  const selected = SORT_OPTIONS.find((o) => o.value === value);

  return (
    <div className="bc-sort-shell" ref={ref}>
      <div
        className={`bc-sort-trigger${value ? " active" : ""}`}
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
        aria-label="Sort departments"
      >
        <span className={`bc-sort-label${value ? "" : " bc-sort-placeholder"}`}>
          {selected ? selected.label : "Sort by..."}
        </span>
        {value && (
          <button
            type="button"
            className="bc-sort-clear"
            onClick={(e) => {
              e.stopPropagation();
              onClear();
              setOpen(false);
            }}
            aria-label="Clear sort"
          >
            <X size={12} />
          </button>
        )}
        <ChevronDown size={14} className={`bc-sort-chevron${open ? " open" : ""}`} />
      </div>
      {open && (
        <div className="bc-sort-menu">
          {SORT_OPTIONS.map((option) => (
            <button
              type="button"
              key={option.value}
              className={`bc-sort-option${value === option.value ? " active" : ""}`}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Department horizontal bar chart ──────────────────────────────────────────
function DeptBarChart({ data, period = "today", onPeriodChange, date, onNavigate }: Omit<DeptProps, "mode">) {
  const [view, setView] = useState<"grouped" | "stacked">("grouped");
  const [selectedDept, setSelectedDept] = useState<string>("ALL");
  const [sortBy, setSortBy] = useState<SortByValue | null>(null);

  const deptOptions = data.map((r) => ({ value: r.department, label: r.department }));

  const filteredData = selectedDept === "ALL"
    ? data
    : data.filter((r) => r.department === selectedDept);

  const sortedData = sortDeptRows(filteredData, sortBy);

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

        <SortDropdown value={sortBy} onChange={setSortBy} onClear={() => setSortBy(null)} />
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
        {sortedData.length === 0 ? (
          <p className="bc-empty">No department data available.</p>
        ) : (
          sortedData.map((row) => (
            <DeptCard key={row.department} row={row} max={max} view={view} date={date} onNavigate={onNavigate} />
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
        date={props.date}
        onNavigate={props.onNavigate}
      />
    );
  }
  return <SimpleBarChart data={props.data} height={props.height} />;
}