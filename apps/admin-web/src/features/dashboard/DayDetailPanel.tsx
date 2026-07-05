import { MousePointerClick } from "lucide-react";
import { AttendanceNavigateFilter, DeptAttendanceRow } from "../../components/ui/BarChart";
import { computeAttendanceRate, getRateTone, RATE_TONE_COLOR } from "./attendanceRate";
import { formatFullDate, toDateInputValue } from "./dateUtils";
import "./DayDetailPanel.css";

export type SelectedDay = {
  day: number;
  date: string;
  present: number;
  late: number;
  absent: number;
  onLeave: number;
  officialBusiness: number;
  departments: DeptAttendanceRow[];
};

function DeptRateRow({
  row,
  date,
  onNavigate,
}: {
  row: DeptAttendanceRow;
  date: string;
  onNavigate?: (filter: AttendanceNavigateFilter) => void;
}) {
  const { rate, total } = computeAttendanceRate(row);
  const tone = getRateTone(rate);

  return (
    <div className="ddp-dept-row">
      <div className="ddp-dept-header">
        <span className="ddp-dept-name">{row.department}</span>
        {onNavigate && (
          <button
            type="button"
            className="ddp-dept-link"
            onClick={() => onNavigate({ department: row.department, date })}
          >
            View in Attendance →
          </button>
        )}
      </div>
      <div className="ddp-dept-stats">
        <span>Present: {row.present}</span>
        <span>Late: {row.late}</span>
        <span>Absent: {row.absent}</span>
        <span>On Leave: {row.onLeave}</span>
      </div>
      <div className="ddp-rate-line">
        <span className="ddp-rate-value">Attendance Rate: {rate}%</span>
        <span className="ddp-rate-total">{total} total</span>
      </div>
      <div className="ddp-rate-track">
        <div
          className="ddp-rate-bar"
          style={{ width: `${rate}%`, background: RATE_TONE_COLOR[tone] }}
        />
      </div>
    </div>
  );
}

export function DayDetailPanel({
  day,
  departmentFilter,
  onNavigate,
}: {
  day: SelectedDay | null;
  departmentFilter: string;
  onNavigate?: (filter: AttendanceNavigateFilter) => void;
}) {
  if (!day) {
    return (
      <div className="ddp-placeholder">
        <MousePointerClick size={22} />
        <p>Click a bar in the Monthly Attendance chart to view that day's attendance breakdown.</p>
      </div>
    );
  }

  const rows =
    departmentFilter === "ALL"
      ? day.departments ?? []
      : (day.departments ?? []).filter((row) => row.department === departmentFilter);
  const dateValue = toDateInputValue(day.date);

  return (
    <div className="ddp-body" key={`${day.date}-${departmentFilter}`}>
      <h4 className="ddp-date">{formatFullDate(day.date)}</h4>

      {rows.length > 0 ? (
        <div className="ddp-dept-list">
          {rows.map((row) => (
            <DeptRateRow key={row.department} row={row} date={dateValue} onNavigate={onNavigate} />
          ))}
        </div>
      ) : (
        <p className="ddp-empty">No attendance records are available for the selected date.</p>
      )}
    </div>
  );
}
