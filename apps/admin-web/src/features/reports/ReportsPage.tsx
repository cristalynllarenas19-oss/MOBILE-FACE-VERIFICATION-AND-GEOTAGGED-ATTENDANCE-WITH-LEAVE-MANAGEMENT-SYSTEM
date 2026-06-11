import { Card } from "../../components/ui/Card";

export function ReportsPage() {
  return (
    <div className="report-grid">
      {["DTR Reports", "Attendance Summary", "Leave Reports", "Payroll Attendance"].map((title) => (
        <Card key={title}>
          <h3>{title}</h3>
          <p className="muted-text">Generate, filter, and export this report as PDF or CSV.</p>
          <button className="primary-button">Generate Report</button>
        </Card>
      ))}
    </div>
  );
}
