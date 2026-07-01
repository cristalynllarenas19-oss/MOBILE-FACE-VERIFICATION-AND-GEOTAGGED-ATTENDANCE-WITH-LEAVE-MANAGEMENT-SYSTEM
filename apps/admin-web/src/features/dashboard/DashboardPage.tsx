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
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { BarChart, DeptAttendanceRow } from "../../components/ui/BarChart";
import { Card } from "../../components/ui/Card";
import { StatCard } from "../../components/ui/StatCard";
import { apiRequest, SessionExpiredError } from "../../lib/api";
import "./DashboardPage.css";

const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const STATUS_COLORS = {
  present: "#1baf7a",
  absent: "#e34948",
  onLeave: "#4a3aa7",
  officialBusiness: "#2a78d6",
};

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
  attendanceSummary: {
    present: number;
    late: number;
    pendingReview: number;
  };
  leaveAvailability: {
    vacation: number;
    sick: number;
    special: number;
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
};

const initialSummary: DashboardSummary = {
  stats: { totalEmployees: 0, presentToday: 0, lateToday: 0, absentToday: 0, pendingLeaves: 0, geotaggedLogs: 0 },
  attendanceSummary: { present: 0, late: 0, pendingReview: 0 },
  leaveAvailability: { vacation: 0, sick: 0, special: 0 },
  enrollment: { enrolled: 0, total: 0 },
  geotagging: { assigned: 0, total: 0 },
  calendar: { monthLabel: "", days: [] },
  absenceTrends: [],
};

function isToday(isoDate: string) {
  if (!isoDate) return false;
  const date = new Date(isoDate);
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

function formatFullDate(isoDate: string) {
  if (!isoDate) return "";
  return new Date(isoDate).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function DayMiniBar({ day }: { day: CalendarDay }) {
  const segments = [
    { key: "present",          value: day.present,          color: STATUS_COLORS.present },
    { key: "absent",           value: day.absent,           color: STATUS_COLORS.absent },
    { key: "onLeave",          value: day.onLeave,          color: STATUS_COLORS.onLeave },
    { key: "officialBusiness", value: day.officialBusiness, color: STATUS_COLORS.officialBusiness },
  ];
  const total = segments.reduce((sum, s) => sum + s.value, 0);

  if (total === 0) {
    return (
      <div className="mini-bar empty">
        <span style={{ flexGrow: 1 }} />
      </div>
    );
  }

  return (
    <div className="mini-bar">
      {segments
        .filter((s) => s.value > 0)
        .map((s) => (
          <span key={s.key} style={{ flexGrow: s.value, background: s.color }} />
        ))}
    </div>
  );
}

function DayDetailModal({ day, onClose }: { day: CalendarDay; onClose: () => void }) {
  const total = day.present + day.late + day.absent + day.onLeave + day.officialBusiness;
  const hasDepts = day.departments && day.departments.length > 0;

  return (
    <div className="day-modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="day-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="day-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="day-modal-header">
          <div>
            <h2 id="day-modal-title">{formatFullDate(day.date)}</h2>
            <p>Attendance breakdown by department</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close date details">
            <X size={18} />
          </button>
        </div>
        <div className="day-modal-body">
          <div className="day-modal-pills">
            <span className="day-modal-pill pill-present">
              <span className="pill-dot" style={{ background: STATUS_COLORS.present }} />
              {day.present} Present
            </span>
            <span className="day-modal-pill pill-late">
              <span className="pill-dot" style={{ background: "#eda100" }} />
              {day.late} Late
            </span>
            <span className="day-modal-pill pill-absent">
              <span className="pill-dot" style={{ background: STATUS_COLORS.absent }} />
              {day.absent} Absent
            </span>
            <span className="day-modal-pill pill-leave">
              <span className="pill-dot" style={{ background: STATUS_COLORS.onLeave }} />
              {day.onLeave} On leave
            </span>
            <span className="day-modal-pill pill-ob">
              <span className="pill-dot" style={{ background: STATUS_COLORS.officialBusiness }} />
              {day.officialBusiness} Official business
            </span>
          </div>

          {total === 0 ? (
            <p className="day-modal-empty">No attendance records for this date yet.</p>
          ) : hasDepts ? (
            <BarChart mode="department" data={day.departments} />
          ) : (
            <p className="day-modal-empty">No department breakdown available.</p>
          )}
        </div>
      </section>
    </div>
  );
}

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

export function DashboardPage() {
  const now = new Date();
  const [calendarMonth, setCalendarMonth] = useState(now.getMonth());
  const [calendarYear, setCalendarYear] = useState(now.getFullYear());
  const [summary, setSummary] = useState(initialSummary);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<CalendarDay | null>(null);
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
        setSummary({
          stats: { ...initialSummary.stats, ...data?.stats },
          attendanceSummary: { ...initialSummary.attendanceSummary, ...data?.attendanceSummary },
          leaveAvailability: { ...initialSummary.leaveAvailability, ...data?.leaveAvailability },
          enrollment: { ...initialSummary.enrollment, ...data?.enrollment },
          geotagging: { ...initialSummary.geotagging, ...data?.geotagging },
          calendar: { ...initialSummary.calendar, ...data?.calendar },
          absenceTrends: data?.absenceTrends ?? [],
        });
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

      <div className="dashboard-grid">
        <div className="left-col">
          <Card className={`calendar-card${calendarLoading ? " calendar-loading" : ""}`}>
            <div className="card-heading calendar-heading-row">
              <h3>Attendance Calendar</h3>
              <span className="cal-hint">Click a date to view its breakdown</span>
            </div>

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

            <div className="calendar-grid">
              {days.map((day) => (
                <span key={day}>{day}</span>
              ))}
              {(summary.calendar?.days ?? []).map((day) => (
                <button
                  type="button"
                  className={[
                    day.absent >= 3 ? "hot" : day.absent > 0 ? "warm" : "",
                    isToday(day.date) ? "today" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  key={day.day}
                  onClick={() => setSelectedDay(day)}
                >
                  <strong>{day.day}</strong>
                  <DayMiniBar day={day} />
                  <small>{day.absent} absent</small>
                </button>
              ))}
            </div>
          </Card>
        </div>

        <aside className="side-stack">
          <Card className="side-card">
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
          </Card>

          <Card className="side-card">
            <div className="side-card-header">
              <h3>Attendance Summary</h3>
            </div>
            <div className="summary-row">
              <span>Present</span>
              <strong className="value-green">{summary.attendanceSummary.present}</strong>
            </div>
            <div className="summary-row">
              <span>Late</span>
              <strong className="warning-text">{summary.attendanceSummary.late}</strong>
            </div>
            <div className="summary-row">
              <span>Pending Review</span>
              <strong>{summary.attendanceSummary.pendingReview}</strong>
            </div>
          </Card>

          <Card className="side-card">
            <div className="side-card-header">
              <h3>Leave Availability</h3>
            </div>
            <div className="summary-row">
              <span>Vacation Leave</span>
              <strong>{summary.leaveAvailability.vacation}</strong>
            </div>
            <div className="summary-row">
              <span>Sick Leave</span>
              <strong>{summary.leaveAvailability.sick}</strong>
            </div>
            <div className="summary-row">
              <span>Special Leave</span>
              <strong>{summary.leaveAvailability.special}</strong>
            </div>
          </Card>
        </aside>
      </div>

      {selectedDay && <DayDetailModal day={selectedDay} onClose={() => setSelectedDay(null)} />}
    </div>
  );
}