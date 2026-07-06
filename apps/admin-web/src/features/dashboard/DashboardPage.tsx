import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  MapPin,
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
import { apiRequest, SessionExpiredError } from "../../lib/api";
import { AttendanceDonut } from "./AttendanceDonut";
import { computeAttendanceRate, getRateTone, RATE_TONE_COLOR } from "./attendanceRate";
import { formatShortDate } from "./dateUtils";
import { DayDetailPanel } from "./DayDetailPanel";
import { MonthlyAttendanceChart } from "./MonthlyAttendanceChart";
import { TodaySummaryCard } from "./TodaySummaryCard";
import "./DashboardPage.css";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

type CalendarDay = {
  day: number;
  date: string;
  present: number;
  late: number;
  absent: number;
  onLeave: number;
  officialBusiness: number;
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
  absenceTrends: { department: string; dayOfWeek: string; absences: number; insight: string }[];
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
  absenceTrends: [],
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
  const [summary, setSummary] = useState(initialSummary);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<CalendarDay | null>(null);
  const [departmentFilter, setDepartmentFilter] = useState("ALL");
  const [trendIndex, setTrendIndex] = useState(0);

  useEffect(() => {
    const trendCount = summary.absenceTrends.length;
    if (trendCount <= 1) return;
    const interval = window.setInterval(() => {
      setTrendIndex((current) => (current + 1) % trendCount);
    }, 4500);
    return () => window.clearInterval(interval);
  }, [summary.absenceTrends.length]);

  useEffect(() => {
    setCalendarLoading(true);
    apiRequest<DashboardSummary>(
      `/dashboard/summary?month=${calendarMonth + 1}&year=${calendarYear}`
    )
      .then((data) => {
        const days = data?.calendar?.days ?? [];
        setSummary({
          stats: { ...initialSummary.stats, ...data?.stats },
          enrollment: { ...initialSummary.enrollment, ...data?.enrollment },
          geotagging: { ...initialSummary.geotagging, ...data?.geotagging },
          calendar: { ...initialSummary.calendar, ...data?.calendar },
          absenceTrends: data?.absenceTrends ?? [],
          departmentAttendance: { ...initialSummary.departmentAttendance, ...data?.departmentAttendance },
        });
        // Default to today's date when browsing the current month (so the
        // detail panel and donut are never blank on first load); otherwise
        // fall back to the 1st of whichever month is being viewed.
        const isCurrentMonth = calendarYear === now.getFullYear() && calendarMonth === now.getMonth();
        const preferredDayNum = isCurrentMonth ? now.getDate() : 1;
        const autoDay = days.find((d) => d.day === preferredDayNum) ?? days[0] ?? null;
        setSelectedDay(autoDay);
        setLoadError(null);
      })
      .catch((err) => {
        if (err instanceof SessionExpiredError) return;
        console.error("Failed to load dashboard summary:", err);
        setLoadError("Could not load dashboard data. Please try refreshing.");
      })
      .finally(() => setCalendarLoading(false));
  }, [calendarMonth, calendarYear]);

  function prevMonth() {
    if (calendarMonth === 0) { setCalendarYear((y) => y - 1); setCalendarMonth(11); }
    else setCalendarMonth((m) => m - 1);
  }

  function nextMonth() {
    if (calendarMonth === 11) { setCalendarYear((y) => y + 1); setCalendarMonth(0); }
    else setCalendarMonth((m) => m + 1);
  }

  const onLeaveToday = summary.departmentAttendance.today.reduce((sum, row) => sum + row.onLeave, 0);

  const departmentOptions = useMemo(
    () =>
      (summary.calendar.days[0]?.departments ?? []).map((row) => ({
        value: row.department,
        label: row.department,
      })),
    [summary.calendar.days],
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

  return (
    <div className="dashboard-page">
      {loadError && <p className="dashboard-error">{loadError}</p>}

      <div className="stats-grid">
        <StatCard label="Total Employees"  value={summary.stats.totalEmployees}  icon={Users}         tone="blue"   />
        <StatCard label="Present Today"    value={summary.stats.presentToday}    icon={CheckCircle2}  tone="green"  />
        <StatCard label="Late Today"       value={summary.stats.lateToday}       icon={Clock}         tone="yellow" />
        <StatCard label="Absent Today"     value={summary.stats.absentToday}     icon={AlertTriangle} tone="red"    />
        <StatCard label="Geotagged Logs"   value={summary.stats.geotaggedLogs}   icon={MapPin}        tone="cyan"   />
        <StatCard
          label="Face Enrollment"
          value={`${summary.enrollment.enrolled}/${summary.enrollment.total}`}
          icon={ScanFace}
          tone="purple"
        />
        <StatCard
          label="Geotagged Areas"
          value={`${summary.geotagging.assigned}/${summary.geotagging.total}`}
          icon={MapPinned}
          tone="teal"
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
          <div className="card-heading">
            <h3>Attendance Details</h3>
          </div>
          <DayDetailPanel day={selectedDay} departmentFilter={departmentFilter} onNavigate={onNavigateToAttendance} />

          <div className="dashboard-inline-section">
            <div className="side-card-header">
              <TrendingUp size={15} />
              <h3>Absence Trends</h3>
            </div>
            {summary.absenceTrends.length === 0 ? (
              <p className="trend-empty">No repeated absence pattern this month.</p>
            ) : (
              (() => {
                const trend = summary.absenceTrends[trendIndex % summary.absenceTrends.length];
                return (
                  <div className="trend-row" key={`${trend.department}-${trend.dayOfWeek}`}>
                    <strong>{trend.department}</strong>
                    <span>{trend.dayOfWeek}: {trend.absences} absences</span>
                    <small>{trend.insight}</small>
                  </div>
                );
              })()
            )}
            {summary.absenceTrends.length > 1 && (
              <div className="trend-dots" aria-hidden="true">
                {summary.absenceTrends.map((trend, index) => (
                  <span
                    key={`${trend.department}-${trend.dayOfWeek}`}
                    className={index === trendIndex % summary.absenceTrends.length ? "active" : ""}
                  />
                ))}
              </div>
            )}
          </div>
        </Card>

        <Card className="donut-card">
          <div className="card-heading calendar-heading-row">
            <h3>Attendance Breakdown</h3>
            <span className="cal-hint">{selectedDay ? formatShortDate(selectedDay.date) : "No date selected"}</span>
          </div>
          <AttendanceDonut
            present={donutSource.present}
            late={donutSource.late}
            absent={donutSource.absent}
            onLeave={donutSource.onLeave}
          />

          <div className="dashboard-inline-section">
            <div className="side-card-header">
              <h3>Today's Summary</h3>
            </div>
            <TodaySummaryCard
              working={summary.stats.presentToday}
              onLeave={onLeaveToday}
              late={summary.stats.lateToday}
              absent={summary.stats.absentToday}
              totalEmployees={summary.stats.totalEmployees}
            />
          </div>
        </Card>
      </div>
    </div>
  );
}
