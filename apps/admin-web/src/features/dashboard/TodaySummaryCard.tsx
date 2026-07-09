import "./TodaySummaryCard.css";

export function TodaySummaryCard({
  working,
  onLeave,
  late,
  absent,
  totalEmployees,
  isDayOff = false,
}: {
  working: number;
  onLeave: number;
  late: number;
  absent: number;
  totalEmployees: number;
  isDayOff?: boolean;
}) {
  const rate = totalEmployees > 0 ? Math.round(((working + late) / totalEmployees) * 100) : 0;

  return (
    <div className="tsc">
      <div className="tsc-row">
        <span>Working</span>
        <strong className="tsc-green">{working}</strong>
      </div>
      <div className="tsc-row">
        <span>On Leave</span>
        <strong className="tsc-purple">{onLeave}</strong>
      </div>
      <div className="tsc-row">
        <span>Late</span>
        <strong className="tsc-yellow">{late}</strong>
      </div>
      <div className="tsc-row">
        <span>Absent</span>
        <strong className="tsc-red">{absent}</strong>
      </div>
      <div className="tsc-rate-row">
        <span>Attendance Rate</span>
        {/* Sunday is a company-wide day off, so a 0% rate would misleadingly
            read as a bad day rather than an expected non-working day. */}
        <strong>{isDayOff ? "Day Off" : `${rate}%`}</strong>
      </div>
    </div>
  );
}
