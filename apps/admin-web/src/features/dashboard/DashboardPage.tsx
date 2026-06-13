import { AlertTriangle, CheckCircle2, Clock, FileText, MapPin, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { Card } from "../../components/ui/Card";
import { StatCard } from "../../components/ui/StatCard";
import { apiRequest } from "../../lib/api";
import "./DashboardPage.css";

const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const calendar = ["31", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "30", "1", "2", "3", "4"];

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
};

const initialSummary: DashboardSummary = {
  stats: { totalEmployees: 0, presentToday: 0, lateToday: 0, absentToday: 0, pendingLeaves: 0, geotaggedLogs: 0 },
  attendanceSummary: { present: 0, late: 0, pendingReview: 0 },
  leaveAvailability: { vacation: 0, sick: 0, special: 0 },
};

export function DashboardPage() {
  const [summary, setSummary] = useState(initialSummary);

  useEffect(() => {
    apiRequest<DashboardSummary>("/dashboard/summary").then(setSummary).catch(() => undefined);
  }, []);

  return (
    <>
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
            <button aria-label="Previous month">{"<"}</button>
            <strong>June 2026</strong>
            <button aria-label="Next month">{">"}</button>
          </div>
          <div className="calendar-grid">
            {days.map((day) => (
              <span key={day}>{day}</span>
            ))}
            {calendar.map((day, index) => (
              <button className={day === "10" ? "selected" : index === 0 || index > 30 ? "muted" : ""} key={`${day}-${index}`}>
                {day}
              </button>
            ))}
          </div>
        </Card>

        <aside className="side-stack">
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
