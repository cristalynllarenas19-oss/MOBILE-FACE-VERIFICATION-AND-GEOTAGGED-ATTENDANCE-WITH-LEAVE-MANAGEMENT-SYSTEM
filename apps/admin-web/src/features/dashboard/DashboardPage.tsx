import {
  AlertTriangle,
  BarChart3,
  CalendarOff,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Info,
  MapPinned,
  ScanFace,
  TrendingUp,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AttendanceNavigateFilter, DeptAttendanceRow } from "../../components/ui/BarChart";
import { Card } from "../../components/ui/Card";
import { DropdownFilter } from "../../components/ui/DropdownFilter";
import { StatCard } from "../../components/ui/StatCard";
import { apiRequest } from "../../lib/api";
import { prefetchCached, useCachedData } from "../../lib/dataCache";
import { useActiveDepartments } from "../../lib/departments";
import { AttendanceDonutChart, AttendanceDonutLegend } from "./AttendanceDonut";
import { computeAttendanceRate, getRateTone, RATE_TONE_COLOR } from "./attendanceRate";
import { formatFullDate } from "./dateUtils";
import { DayDetailPanel } from "./DayDetailPanel";
import { MonthlyAttendanceChart } from "./MonthlyAttendanceChart";
import "./DashboardPage.css";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const WEEKDAY_FULL_NAME: Record<string, string> = {
  Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday",
  Fri: "Friday", Sat: "Saturday", Sun: "Sunday",
};

// Rounds the Absence Trends chart's max bar value up to a "nice" step (1/2/5/10
// x a power of ten) so the y-axis reads 0/10/20/30/40 rather than an arbitrary
// number — same rounding rule chart libraries like d3/Recharts use for ticks.
function niceAxisTicks(maxValue: number): number[] {
  const target = Math.max(maxValue, 1) / 4;
  const magnitude = Math.pow(10, Math.floor(Math.log10(target)));
  const residual = target / magnitude;
  const step = (residual > 5 ? 10 : residual > 2 ? 5 : residual > 1 ? 2 : 1) * magnitude;
  return [4, 3, 2, 1, 0].map((i) => Math.round(step * i));
}

function dashboardSummaryKey(month: number, year: number) {
  return `dashboard-summary:${month + 1}-${year}`;
}

function fetchDashboardSummary(month: number, year: number) {
  return apiRequest<DashboardSummary>(`/dashboard/summary?month=${month + 1}&year=${year}`);
}

const WEEKDAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

type CalendarDay = {
  day: number;
  date: string;
  present: number;
  late: number;
  absent: number;
  onLeave: number;
  officialBusiness: number;
  // Sunday, a company-wide day off — lets the chart/detail panel distinguish
  // it from a day that simply has no attendance data yet.
  isDayOff: boolean;
  departments: DeptAttendanceRow[];
};

type DashboardSummary = {
  stats: {
    totalEmployees: number;
    presentToday: number;
    lateToday: number;
    absentToday: number;
    pendingLeaves: number;
    geotaggedLogs: number;
  };
  enrollment: {
    enrolled: number;
    total: number;
  };
  geotagging: {
    assigned: number;
    total: number;
  };
  calendar: {
    monthLabel: string;
    days: CalendarDay[];
  };
  departmentAttendance: {
    today: DeptAttendanceRow[];
    week: DeptAttendanceRow[];
    month: DeptAttendanceRow[];
  };
};

const initialSummary: DashboardSummary = {
  stats: { totalEmployees: 0, presentToday: 0, lateToday: 0, absentToday: 0, pendingLeaves: 0, geotaggedLogs: 0 },
  enrollment: { enrolled: 0, total: 0 },
  geotagging: { assigned: 0, total: 0 },
  calendar: { monthLabel: "", days: [] },
  departmentAttendance: { today: [], week: [], month: [] },
};

// ── Month/Year picker dropdown ───────────────────────────────────────────────
function CalendarPicker({
  month,
  year,
  onChange,
}: {
  month: number;
  year: number;
  onChange: (month: number, year: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pickerYear, setPickerYear] = useState(year);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setPickerYear(year);
    function handleOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [open, year]);

  const currentYear = new Date().getFullYear();
  const yearRange = Array.from({ length: 11 }, (_, i) => currentYear - 5 + i);

  return (
    <div className="cal-picker-shell" ref={ref}>
      <button
        type="button"
        className="cal-picker-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-label="Pick month and year"
      >
        <strong>{MONTHS[month]} {year}</strong>
        <ChevronRight
          size={14}
          className={`cal-picker-chevron${open ? " open" : ""}`}
        />
      </button>

      {open && (
        <div className="cal-picker-menu">
          {/* Year row */}
          <div className="cal-picker-year-row">
            <button
              type="button"
              className="cal-picker-year-nav"
              onClick={() => setPickerYear((y) => y - 1)}
              aria-label="Previous year"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="cal-picker-year-label">{pickerYear}</span>
            <button
              type="button"
              className="cal-picker-year-nav"
              onClick={() => setPickerYear((y) => y + 1)}
              aria-label="Next year"
            >
              <ChevronRight size={14} />
            </button>
          </div>

          {/* Month grid */}
          <div className="cal-picker-months">
            {MONTHS.map((name, idx) => {
              const isActive = idx === month && pickerYear === year;
              return (
                <button
                  key={name}
                  type="button"
                  className={`cal-picker-month${isActive ? " active" : ""}`}
                  onClick={() => {
                    onChange(idx, pickerYear);
                    setOpen(false);
                  }}
                >
                  {name.slice(0, 3)}
                </button>
              );
            })}
          </div>

          {/* Quick-jump to current month */}
          <button
            type="button"
            className="cal-picker-today-btn"
            onClick={() => {
              const now = new Date();
              onChange(now.getMonth(), now.getFullYear());
              setOpen(false);
            }}
          >
            Go to current month
          </button>
        </div>
      )}
    </div>
  );
}

export function DashboardPage({
  onNavigateToAttendance,
  user,
}: {
  onNavigateToAttendance: (filter: AttendanceNavigateFilter) => void;
  user?: { roles?: string[]; departmentId?: string; department?: string };
}) {
  // Mirrors the backend's getSupervisorDepartmentScope: a Supervisor who is
  // also an Admin (or not a Supervisor at all) gets full, unscoped access.
  const roles = user?.roles ?? [];
  const isDepartmentLocked = roles.includes("SUPERVISOR") && !roles.includes("ADMIN");
  const lockedDepartmentName = isDepartmentLocked ? user?.department : undefined;

  const now = new Date();
  const [calendarMonth, setCalendarMonth] = useState(now.getMonth());
  const [calendarYear, setCalendarYear] = useState(now.getFullYear());
  const [selectedDay, setSelectedDay] = useState<CalendarDay | null>(null);

  const {
    data: summaryData,
    isLoading: calendarLoading,
    error: summaryError,
  } = useCachedData<DashboardSummary>(
    dashboardSummaryKey(calendarMonth, calendarYear),
    () => fetchDashboardSummary(calendarMonth, calendarYear),
  );
  const loadError = summaryError ? "Could not load dashboard data. Please try refreshing." : null;

  // Warm the previous/next month in the background so paging the calendar
  // with the arrows feels instant instead of showing a spinner each click.
  useEffect(() => {
    const prev = calendarMonth === 0 ? { month: 11, year: calendarYear - 1 } : { month: calendarMonth - 1, year: calendarYear };
    const next = calendarMonth === 11 ? { month: 0, year: calendarYear + 1 } : { month: calendarMonth + 1, year: calendarYear };
    prefetchCached(dashboardSummaryKey(prev.month, prev.year), () => fetchDashboardSummary(prev.month, prev.year));
    prefetchCached(dashboardSummaryKey(next.month, next.year), () => fetchDashboardSummary(next.month, next.year));
  }, [calendarMonth, calendarYear]);

  const summary = useMemo<DashboardSummary>(() => {
    if (!summaryData) return initialSummary;
    return {
      stats: { ...initialSummary.stats, ...summaryData.stats },
      enrollment: { ...initialSummary.enrollment, ...summaryData.enrollment },
      geotagging: { ...initialSummary.geotagging, ...summaryData.geotagging },
      calendar: { ...initialSummary.calendar, ...summaryData.calendar },
      departmentAttendance: { ...initialSummary.departmentAttendance, ...summaryData.departmentAttendance },
    };
  }, [summaryData]);
  const [departmentFilter, setDepartmentFilter] = useState("ALL");

  useEffect(() => {
    if (!summaryData) return;
    const days = summaryData.calendar?.days ?? [];
    // Default to today's date when browsing the current month (so the
    // detail panel and donut are never blank on first load); otherwise
    // fall back to the 1st of whichever month is being viewed.
    const isCurrentMonth = calendarYear === now.getFullYear() && calendarMonth === now.getMonth();
    const preferredDayNum = isCurrentMonth ? now.getDate() : 1;
    const autoDay = days.find((d) => d.day === preferredDayNum) ?? days[0] ?? null;
    setSelectedDay(autoDay);
  }, [summaryData]);

  function prevMonth() {
    if (calendarMonth === 0) { setCalendarYear((y) => y - 1); setCalendarMonth(11); }
    else setCalendarMonth((m) => m - 1);
  }

  function nextMonth() {
    if (calendarMonth === 11) { setCalendarYear((y) => y + 1); setCalendarMonth(0); }
    else setCalendarMonth((m) => m + 1);
  }

  const onLeaveToday = summary.departmentAttendance.today.reduce((sum, row) => sum + row.onLeave, 0);

  // Sunday is a company-wide day off, so a 0% rate would misleadingly read
  // as a bad day rather than an expected non-working day.
  const todayAttendanceRateLabel = new Date().getDay() === 0
    ? "Day Off"
    : `${summary.stats.totalEmployees > 0
        ? Math.round(((summary.stats.presentToday + summary.stats.lateToday) / summary.stats.totalEmployees) * 100)
        : 0}%`;

  // Sourced from GET /departments (all active departments), not from the
  // calendar summary's per-day rows — those only include departments that
  // had employees/attendance on that day, so an empty department would
  // otherwise never appear as a filter option. filteredDays below already
  // defaults a department with no matching row to all-zeros.
  const { departmentNames: departmentOptionNames } = useActiveDepartments();
  const departmentOptions = useMemo(
    () => departmentOptionNames.map((name) => ({ value: name, label: name })),
    [departmentOptionNames],
  );

  // The chart's top-level day fields are already company-wide totals; filtering
  // by department means swapping each day's numbers for that department's row.
  const filteredDays = useMemo(() => {
    if (departmentFilter === "ALL") return summary.calendar.days;
    return summary.calendar.days.map((day) => {
      const deptRow = day.departments.find((d) => d.department === departmentFilter);
      return {
        ...day,
        present: deptRow?.present ?? 0,
        late: deptRow?.late ?? 0,
        absent: deptRow?.absent ?? 0,
        onLeave: deptRow?.onLeave ?? 0,
        officialBusiness: deptRow?.officialBusiness ?? 0,
      };
    });
  }, [summary.calendar.days, departmentFilter]);

  const monthlyRate = useMemo(() => {
    const totals = filteredDays.reduce(
      (acc, day) => ({
        ...acc,
        present: acc.present + day.present,
        late: acc.late + day.late,
        absent: acc.absent + day.absent,
        onLeave: acc.onLeave + day.onLeave,
        officialBusiness: acc.officialBusiness + day.officialBusiness,
      }),
      { department: "", present: 0, late: 0, absent: 0, onLeave: 0, officialBusiness: 0 },
    );
    return computeAttendanceRate(totals);
  }, [filteredDays]);

  // Attendance Breakdown donut tracks the same selected date + department
  // filter as the detail panel, so both always describe the same scope.
  const donutSource = useMemo(() => {
    if (!selectedDay) return { present: 0, late: 0, absent: 0, onLeave: 0 };
    if (departmentFilter === "ALL") {
      return {
        present: selectedDay.present,
        late: selectedDay.late,
        absent: selectedDay.absent,
        onLeave: selectedDay.onLeave,
      };
    }
    const row = selectedDay.departments.find((d) => d.department === departmentFilter);
    return {
      present: row?.present ?? 0,
      late: row?.late ?? 0,
      absent: row?.absent ?? 0,
      onLeave: row?.onLeave ?? 0,
    };
  }, [selectedDay, departmentFilter]);

  // Absence Trends: company-wide (not filtered by the Monthly Attendance
  // department dropdown — that filter already applies to the calendar and
  // Attendance Details, so applying it here too would just be the same
  // information restated) weekday aggregate over whatever month/year is
  // currently selected via the Monthly Attendance picker above — no
  // separate month control of its own. Every occurrence of a given weekday
  // in the visible month is summed (all Mondays together, etc.), so the
  // chart reads as "which weekday tends to be worst," not a single day.
  // The bars themselves follow the same departmentFilter as the Monthly
  // Attendance dropdown (and Attendance Details, which already reacts to
  // it) — picking a department there narrows this chart too. "Most Affected
  // Department" stays company-wide regardless of that filter: once you've
  // already drilled into one department, "which department is worst" isn't
  // a question the chart can answer any more, so it keeps the full picture.
  const trendChart = useMemo(() => {
    const weekdayTotals: Record<string, number> = Object.fromEntries(WEEKDAY_ORDER.map((d) => [d, 0]));
    const departmentTotals = new Map<string, number>();
    // Per-department, per-weekday — feeds the "Highest Absence Day" card's
    // click-to-drill-down (which department is worst on the clicked
    // weekday), independent of departmentTotals above (that one stays
    // company-wide for the "Department with Most Absences" card).
    const departmentWeekdayTotals = new Map<string, Record<string, number>>();
    for (const day of summary.calendar.days) {
      const weekday = WEEKDAY_ORDER[(new Date(day.date).getDay() + 6) % 7];
      if (departmentFilter === "ALL") {
        weekdayTotals[weekday] += day.absent;
      } else {
        const row = day.departments.find((d) => d.department === departmentFilter);
        weekdayTotals[weekday] += row?.absent ?? 0;
      }
      for (const row of day.departments) {
        departmentTotals.set(row.department, (departmentTotals.get(row.department) ?? 0) + row.absent);
        const byWeekday = departmentWeekdayTotals.get(row.department) ?? Object.fromEntries(WEEKDAY_ORDER.map((d) => [d, 0]));
        byWeekday[weekday] += row.absent;
        departmentWeekdayTotals.set(row.department, byWeekday);
      }
    }

    const bars = WEEKDAY_ORDER.map((day) => ({ day, absences: weekdayTotals[day] }));
    const peak = bars.reduce((max, bar) => (bar.absences > max.absences ? bar : max), bars[0]);
    const weekTotal = bars.reduce((sum, bar) => sum + bar.absences, 0);

    let topDepartment: { department: string; total: number } | null = null;
    for (const [department, total] of departmentTotals) {
      if (!topDepartment || total > topDepartment.total) topDepartment = { department, total };
    }

    return {
      bars,
      peakDay: peak.absences > 0 ? peak.day : null,
      peakAbsences: peak.absences,
      weekTotal,
      topDepartment,
      departmentWeekdayTotals,
    };
  }, [summary.calendar.days, departmentFilter]);

  // Which weekday bar is currently selected/highlighted — defaults to the
  // overall peak day until the admin clicks a different bar.
  const [selectedTrendDay, setSelectedTrendDay] = useState<string | null>(null);
  const activeTrendDay = selectedTrendDay ?? trendChart.peakDay;

  // The department with the most absences on just the active weekday
  // (drives the "Highest Absence Day" card's content when a bar is clicked)
  // — distinct from trendChart.topDepartment, which is always company-wide
  // for the whole period regardless of which day is selected.
  const topDepartmentForActiveDay = useMemo(() => {
    if (!activeTrendDay) return null;
    let top: { department: string; total: number } | null = null;
    for (const [department, byWeekday] of trendChart.departmentWeekdayTotals) {
      const total = byWeekday[activeTrendDay] ?? 0;
      if (total > 0 && (!top || total > top.total)) top = { department, total };
    }
    return top;
  }, [activeTrendDay, trendChart.departmentWeekdayTotals]);

  return (
    <div className="dashboard-page">
      {loadError && <p className="dashboard-error">{loadError}</p>}

      <div className="stats-grid">
        <StatCard label="Total Employees"  value={summary.stats.totalEmployees}  icon={Users}         tone="blue"   />
        <StatCard label="Present Today"    value={summary.stats.presentToday}    icon={CheckCircle2}  tone="green"  />
        <StatCard label="Absent Today"     value={summary.stats.absentToday}     icon={AlertTriangle} tone="red"    />
        <StatCard label="On Leave Today"   value={onLeaveToday}                  icon={CalendarOff}   tone="pink"   />
        <StatCard
          label="Geotagged Areas"
          value={summary.geotagging.assigned}
          icon={MapPinned}
          tone="teal"
        />
        <StatCard
          label="Face Enrollment"
          value={`${summary.enrollment.enrolled}/${summary.enrollment.total}`}
          icon={ScanFace}
          tone="purple"
        />
      </div>

      <div className={`dashboard-interactive-grid${calendarLoading ? " dashboard-loading" : ""}`}>
        <Card className="monthly-chart-card">
          <div className="card-heading calendar-heading-row">
            <h3>Monthly Attendance</h3>
            <div className="calendar-header">
              <button className="cal-nav-btn" onClick={prevMonth} aria-label="Previous month">
                <ChevronLeft size={16} />
              </button>
              <CalendarPicker
                month={calendarMonth}
                year={calendarYear}
                onChange={(m, y) => { setCalendarMonth(m); setCalendarYear(y); }}
              />
              <button className="cal-nav-btn" onClick={nextMonth} aria-label="Next month">
                <ChevronRight size={16} />
              </button>
            </div>
          </div>

          <div className="monthly-toolbar-row">
            <span className="monthly-rate">
              Attendance Rate{" "}
              <strong style={{ color: RATE_TONE_COLOR[getRateTone(monthlyRate.rate)] }}>
                {monthlyRate.rate}%
              </strong>
            </span>
            {isDepartmentLocked ? (
              <span className="cal-hint">{lockedDepartmentName}</span>
            ) : (
              <DropdownFilter
                value={departmentFilter}
                options={departmentOptions}
                onChange={setDepartmentFilter}
                allLabel="All Departments"
                menuLabel="Department"
                allValue="ALL"
                ariaLabel="Filter monthly attendance by department"
              />
            )}
          </div>

          <MonthlyAttendanceChart
            days={filteredDays}
            selectedDay={selectedDay?.day ?? null}
            onSelectDay={(day) => {
              const match = summary.calendar.days.find((d) => d.day === day.day);
              if (match) setSelectedDay(match);
            }}
          />
        </Card>

        <Card className="day-detail-card">
          <div className="card-heading calendar-heading-row">
            <h3>Attendance Details</h3>
            <span className="cal-hint">{selectedDay ? formatFullDate(selectedDay.date) : "No date selected"}</span>
          </div>
          <DayDetailPanel day={selectedDay} departmentFilter={departmentFilter} onNavigate={onNavigateToAttendance} />
        </Card>

        <Card className="donut-card">
          <div className="card-heading calendar-heading-row">
            <h3>Today's Summary</h3>
            <span className="cal-hint cal-hint-rate">{todayAttendanceRateLabel}</span>
          </div>
          <div className="donut-summary-row">
            <AttendanceDonutChart
              present={donutSource.present}
              absent={donutSource.absent}
              onLeave={donutSource.onLeave}
            />
            <div className="donut-summary-col">
              <AttendanceDonutLegend
                present={donutSource.present}
                absent={donutSource.absent}
                onLeave={donutSource.onLeave}
              />
            </div>
          </div>

          <div className="donut-card-scroll">
          <div className="dashboard-inline-section trend-section">
            <div className="side-card-header trend-header">
              <span className="trend-title-icon">
                <TrendingUp size={15} />
              </span>
              <h3>Absence Trends</h3>
              <div className="trend-subheading">
                <div className="trend-subheading-top">
                  <span className="trend-subheading-title">By Day of Week</span>
                  <Info
                    size={11}
                    className="trend-subheading-info"
                    aria-label="Total absences grouped by weekday, across all weeks in the selected period"
                  />
                </div>
                <span className="trend-subheading-total">
                  <strong>{trendChart.weekTotal}</strong> total absences
                </span>
              </div>
            </div>

            {trendChart.peakAbsences === 0 ? (
              <p className="trend-empty">No absences recorded this period.</p>
            ) : (
              (() => {
                const ticks = niceAxisTicks(Math.max(...trendChart.bars.map((bar) => bar.absences)));
                const chartMax = ticks[0];
                return (
                  <>
                    <div className="trend-chart-row">
                      <div className="trend-chart-axis">
                        {ticks.map((tick) => (
                          <span key={tick}>{tick}</span>
                        ))}
                      </div>
                      <div className="trend-chart-plot">
                        <div className="trend-chart-zone">
                          {ticks.map((tick) => (
                            <div
                              key={tick}
                              className="trend-chart-gridline"
                              style={{ bottom: `${chartMax > 0 ? (tick / chartMax) * 100 : 0}%` }}
                            />
                          ))}
                          {trendChart.bars.map((bar) => {
                            const heightPct = chartMax > 0 ? (bar.absences / chartMax) * 100 : 0;
                            const isActive = bar.day === activeTrendDay;
                            return (
                              <button
                                type="button"
                                className="trend-chart-col"
                                key={bar.day}
                                onClick={() => setSelectedTrendDay(bar.day)}
                                title={`${WEEKDAY_FULL_NAME[bar.day] ?? bar.day}: ${bar.absences} absence${bar.absences === 1 ? "" : "s"}`}
                              >
                                <div className="trend-chart-bar-track">
                                  <span
                                    className={`trend-chart-value${isActive ? " peak" : ""}`}
                                    style={{ bottom: `calc(${heightPct}% + 3px)` }}
                                  >
                                    {bar.absences}
                                  </span>
                                  <div
                                    className={`trend-chart-bar${isActive ? " peak" : ""}`}
                                    style={{ height: `${heightPct}%` }}
                                  />
                                </div>
                              </button>
                            );
                          })}
                        </div>
                        <div className="trend-chart-xlabels">
                          {trendChart.bars.map((bar) => (
                            <span
                              key={bar.day}
                              className={bar.day === activeTrendDay ? "peak" : ""}
                            >
                              {bar.day}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="trend-insights">
                      <div className="trend-insight-card red">
                        <span className="trend-insight-icon red">
                          <BarChart3 size={15} />
                        </span>
                        <div className="trend-insight-body">
                          <span className="trend-insight-label">Highest Absence Day</span>
                          <strong className="trend-insight-value red">
                            {topDepartmentForActiveDay?.department ?? "No data"}
                          </strong>
                        </div>
                        <div className="trend-insight-count-block">
                          <strong className="trend-insight-count-number red">
                            {topDepartmentForActiveDay?.total ?? 0}
                          </strong>
                          <span className="trend-insight-count-label">
                            absence{topDepartmentForActiveDay?.total === 1 ? "" : "s"}
                          </span>
                        </div>
                      </div>
                      {trendChart.topDepartment && (
                        <div className="trend-insight-card amber">
                          <span className="trend-insight-icon amber">
                            <Users size={15} />
                          </span>
                          <div className="trend-insight-body">
                            <span className="trend-insight-label">Department with Most Absences</span>
                            <strong className="trend-insight-value amber">{trendChart.topDepartment.department}</strong>
                          </div>
                          <div className="trend-insight-count-block">
                            <strong className="trend-insight-count-number amber">{trendChart.topDepartment.total}</strong>
                            <span className="trend-insight-count-label">
                              absence{trendChart.topDepartment.total === 1 ? "" : "s"}
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                );
              })()
            )}
          </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
