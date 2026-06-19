import { AlertTriangle, CheckCircle2, Clock, FileText, MapPin, TrendingUp, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { Card } from "../../components/ui/Card";
import { StatCard } from "../../components/ui/StatCard";
import { apiRequest } from "../../lib/api";
import "./DashboardPage.css";

const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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
  calendar: {
    monthLabel: string;
    days: { day: number; present: number; late: number; absent: number; onLeave: number; officialBusiness: number }[];
  };
  absenceTrends: { department: string; dayOfWeek: string; absences: number; insight: string }[];
};

const initialSummary: DashboardSummary = {
  stats: { totalEmployees: 0, presentToday: 0, lateToday: 0, absentToday: 0, pendingLeaves: 0, geotaggedLogs: 0 },
  attendanceSummary: { present: 0, late: 0, pendingReview: 0 },
  leaveAvailability: { vacation: 0, sick: 0, special: 0 },
  calendar: { monthLabel: "", days: [] },
  absenceTrends: [],
};

export function DashboardPage() {
  const [summary, setSummary] = useState(initialSummary);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    apiRequest<DashboardSummary>("/dashboard/summary")
      .then((data) => {
        // Merge defensively in case the API response is partial/malformed,
        // so we never end up with `summary.calendar` being undefined.
        setSummary({
          stats: { ...initialSummary.stats, ...data?.stats },
          attendanceSummary: { ...initialSummary.attendanceSummary, ...data?.attendanceSummary },
          leaveAvailability: { ...initialSummary.leaveAvailability, ...data?.leaveAvailability },
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
    <>
      {loadError && <p className="dashboard-error">{loadError}</p>}

      <div className="stats-grid">
        <StatCard label="Total Employees" value={summary.stats.totalEmployees} icon={Users} tone="blue" />
        <StatCard label="Present Today" value={summary.stats.presentToday} icon={CheckCircle2} tone="green" />
        <StatCard label="Late Today" value={summary.stats.lateToday} icon={Clock} tone="yellow" />
        <StatCard label="Absent" value={summary.stats.absentToday} icon={AlertTriangle} tone="red" />
        <StatCard label="Pending Leaves" value={summary.stats.pendingLeaves} icon={FileText} tone="pink" />
        <StatCard label="Geotagged Logs" value={summary.stats.geotaggedLogs} icon={MapPin} tone="cyan" />
      </div>

      <div className="dashboard-grid">
        <Card className="calendar-card">
          <div className="card-heading">
            <h3>Attendance Calendar and Availability</h3>
          </div>
          <div className="calendar-header">
            <strong>{summary.calendar?.monthLabel ?? ""}</strong>
            <span>Absence heatmap</span>
          </div>
          <div className="calendar-grid">
            {days.map((day) => (
              <span key={day}>{day}</span>
            ))}
            {(summary.calendar?.days ?? []).map((day) => (
              <button className={day.absent >= 3 ? "hot" : day.absent > 0 ? "warm" : ""} key={day.day}>
                <strong>{day.day}</strong>
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
              summary.absenceTrends.map((trend) => (
                <div className="trend-row" key={`${trend.department}-${trend.dayOfWeek}`}>
                  <strong>{trend.department}</strong>
                  <span>{trend.dayOfWeek}: {trend.absences} absences</span>
                  <small>{trend.insight}</small>
                </div>
              ))
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
    </>
  );
}