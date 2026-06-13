import { Card } from "../../components/ui/Card";
import "./SchedulesPage.css";

export function SchedulesPage() {
  return (
    <div className="report-grid">
      {[
        ["Regular Shift", "08:00 AM - 05:00 PM", "Grace period: 10 minutes"],
        ["Morning Shift", "06:00 AM - 02:00 PM", "Grace period: 5 minutes"],
        ["Flexible Shift", "Employee-specific schedule", "HR approval required"],
      ].map(([title, time, note]) => (
        <Card key={title}>
          <h3>{title}</h3>
          <p className="muted-text">{time}</p>
          <p className="muted-text">{note}</p>
          <button className="primary-button">Manage Shift</button>
        </Card>
      ))}
    </div>
  );
}
