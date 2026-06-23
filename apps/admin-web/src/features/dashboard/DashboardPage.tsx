import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileText,
  MapPin,
  MapPinned,
  ScanFace,
  TrendingUp,
  Users,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { BarChart } from "../../components/ui/BarChart";
import { Card } from "../../components/ui/Card";
import { StatCard } from "../../components/ui/StatCard";
import { apiRequest } from "../../lib/api";
import "./DashboardPage.css";

const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const STATUS_COLORS = {
  present: "#1a8a4a",
  absent: "#c0392b",
  onLeave: "#7c3aed",
  officialBusiness: "#1a90aa",
};

type CalendarDay = {
  day: number;
  date: string;
  present: number;
  late: number;
  absent: number;
  onLeave: number;
  officialBusiness: number;
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
    { key: "present", value: day.present, color: STATUS_COLORS.present },
    { key: "absent", value: day.absent, color: STATUS_COLORS.absent },
    { key: "onLeave", value: day.onLeave, color: STATUS_COLORS.onLeave },
    { key: "officialBusiness", value: day.officialBusiness, color: STATUS_COLORS.officialBusiness },
  ];
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);

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
        .filter((segment) => segment.value > 0)
        .map((segment) => (
          <span key={segment.key} style={{ flexGrow: segment.value, background: segment.color }} />
        ))}
    </div>
  );
}

function DayDetailModal({ day, onClose }: { day: CalendarDay; onClose: () => void }) {
  const total = day.present + day.absent + day.onLeave + day.officialBusiness;
  const chartData = [
    { label: "Present", value: day.present, color: STATUS_COLORS.present },
    { label: "Absent", value: day.absent, color: STATUS_COLORS.absent },
    { label: "On Leave", value: day.onLeave, color: STATUS_COLORS.onLeave },
    { label: "Official Business", value: day.officialBusiness, color: STATUS_COLORS.officialBusiness },
  ];

  return (
    <div className="day-modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="day-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="day-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="day-modal-header">
          <div>
            <h2 id="day-modal-title">{formatFullDate(day.date)}</h2>
            <p>Attendance breakdown for this date</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close date details">
            <X size={18} />
          </button>
        </div>
        <div className="day-modal-body">
          <div className="day-modal-total">
            <span>Total recorded</span>
            <strong>{total}</strong>
          </div>
          {total === 0 ? (
            <p className="day-modal-empty">No attendance records for this date yet.</p>
          ) : (
            <BarChart data={chartData} />
          )}
        </div>
      </section>
    </div>
  );
}

export function DashboardPage() {
  const [summary, setSummary] = useState(initialSummary);
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
    apiRequest<DashboardSummary>("/dashboard/summary")
      .then((data) => {
        // Merge defensively in case the API response is partial/malformed,
        // so we never end up with `summary.calendar` being undefined.
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
        console.error("Failed to load dashboard summary:", err);
        setLoadError("Could not load dashboard data. Please try refreshing or logging in again.");
      });
  }, []);

  return (
    <div className="dashboard-page">
      {loadError && <p className="dashboard-error">{loadError}</p>}

      <div className="stats-grid">
        <StatCard label="Total Employees" value={summary.stats.totalEmployees} icon={Users} tone="blue" />
        <StatCard label="Present Today" value={summary.stats.presentToday} icon={CheckCircle2} tone="green" />
        <StatCard label="Late Today" value={summary.stats.lateToday} icon={Clock} tone="yellow" />
        <StatCard label="Absent" value={summary.stats.absentToday} icon={AlertTriangle} tone="red" />
        <StatCard label="Pending Leaves" value={summary.stats.pendingLeaves} icon={FileText} tone="pink" />
        <StatCard label="Geotagged Logs" value={summary.stats.geotaggedLogs} icon={MapPin} tone="cyan" />
        <StatCard
          label="Face Enrollment"
          value={`${summary.enrollment.enrolled}/${summary.enrollment.total}`}
          icon={ScanFace}
          tone="purple"
        />
        <StatCard
          label="Geotagged Assignment"
          value={`${summary.geotagging.assigned}/${summary.geotagging.total}`}
          icon={MapPinned}
          tone="teal"
        />
      </div>

      <div className="dashboard-grid">
        <Card className="calendar-card">
          <div className="card-heading">
            <h3>Attendance Calendar and Availability</h3>
          </div>
          <div className="calendar-header">
            <strong>{summary.calendar?.monthLabel ?? ""}</strong>
            <span>Click a date to view its breakdown</span>
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

        <aside className="side-stack">
          <Card>
            <h3><TrendingUp size={15} /> Absence Trends</h3>
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
          <Card>
            <h3>Attendance Summary</h3>
            <div className="summary-row"><span>Present</span><strong>{summary.attendanceSummary.present}</strong></div>
            <div className="summary-row"><span>Late</span><strong className="warning-text">{summary.attendanceSummary.late}</strong></div>
            <div className="summary-row"><span>Pending Review</span><strong>{summary.attendanceSummary.pendingReview}</strong></div>
          </Card>
          <Card>
            <h3>Leave Availability</h3>
            <div className="summary-row"><span>Vacation Leave</span><strong>{summary.leaveAvailability.vacation}</strong></div>
            <div className="summary-row"><span>Sick Leave</span><strong>{summary.leaveAvailability.sick}</strong></div>
            <div className="summary-row"><span>Special Leave</span><strong>{summary.leaveAvailability.special}</strong></div>
          </Card>
        </aside>
      </div>

      {selectedDay && <DayDetailModal day={selectedDay} onClose={() => setSelectedDay(null)} />}
    </div>
  );
}
