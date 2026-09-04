import { CalendarCheck2, ChevronRight, MousePointerClick } from "lucide-react";
import { AttendanceNavigateFilter, DeptAttendanceRow } from "../../components/ui/BarChart";
import { computeAttendanceRate } from "./attendanceRate";
import { toDateInputValue } from "./dateUtils";
import "./DayDetailPanel.css";

export type SelectedDay = {
  day: number;
  date: string;
  present: number;
  late: number;
  absent: number;
  onLeave: number;
  officialBusiness: number;
  isDayOff?: boolean;
  departments: DeptAttendanceRow[];
};

// Same total computeAttendanceRate already uses everywhere else on this page
// (present + late + absent + onLeave + officialBusiness) — Late and
// Official Business aren't shown as their own columns here, but they still
// count toward each row's Total, same as before.
function rowTotal(row: DeptAttendanceRow) {
  return computeAttendanceRate(row).total;
}

function DeptTableRow({
  row,
  date,
  onNavigate,
}: {
  row: DeptAttendanceRow;
  date: string;
  onNavigate?: (filter: AttendanceNavigateFilter) => void;
}) {
  return (
    <div className="ddp-row" role="row">
      <span className="ddp-cell ddp-cell-dept" title={row.department}>{row.department}</span>
      <span className="ddp-cell ddp-cell-num ddp-col-present">{row.present}</span>
      <span className="ddp-cell ddp-cell-num ddp-col-absent">{row.absent}</span>
      <span className="ddp-cell ddp-cell-num ddp-col-onleave">{row.onLeave}</span>
      <span className="ddp-cell ddp-cell-num ddp-col-total">{rowTotal(row)}</span>
      <span className="ddp-cell ddp-cell-arrow">
        {onNavigate && (
          <button
            type="button"
            className="ddp-arrow-button"
            onClick={() => onNavigate({ department: row.department, date })}
            aria-label={`View ${row.department} in Attendance Management`}
          >
            <ChevronRight size={14} />
          </button>
        )}
      </span>
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

  const totals = rows.reduce(
    (acc, row) => ({
      present: acc.present + row.present,
      absent: acc.absent + row.absent,
      onLeave: acc.onLeave + row.onLeave,
      total: acc.total + rowTotal(row),
    }),
    { present: 0, absent: 0, onLeave: 0, total: 0 },
  );

  return (
    <div className="ddp-body" key={`${day.date}-${departmentFilter}`}>
      {day.isDayOff ? (
        <div className="ddp-dayoff-empty">
          <span className="ddp-dayoff-empty-icon">
            <CalendarCheck2 size={22} strokeWidth={1.75} />
          </span>
          <p className="ddp-dayoff-empty-text">COMPANY-WIDE DAY OFF. Attendance is not required today.</p>
        </div>
      ) : rows.length > 0 ? (
        <div className="ddp-table">
          <div className="ddp-row ddp-head" role="row">
            <span className="ddp-cell ddp-cell-dept">Department</span>
            <span className="ddp-cell ddp-cell-num ddp-col-present">Present</span>
            <span className="ddp-cell ddp-cell-num ddp-col-absent">Absent</span>
            <span className="ddp-cell ddp-cell-num ddp-col-onleave">On Leave</span>
            <span className="ddp-cell ddp-cell-num ddp-col-total">Total</span>
            <span className="ddp-cell ddp-cell-arrow" />
          </div>

          <div className="ddp-scroll">
            {rows.map((row) => (
              <DeptTableRow key={row.department} row={row} date={dateValue} onNavigate={onNavigate} />
            ))}
          </div>

          <div className="ddp-row ddp-total" role="row">
            <span className="ddp-cell ddp-cell-dept">TOTAL</span>
            <span className="ddp-cell ddp-cell-num">{totals.present}</span>
            <span className="ddp-cell ddp-cell-num">{totals.absent}</span>
            <span className="ddp-cell ddp-cell-num">{totals.onLeave}</span>
            <span className="ddp-cell ddp-cell-num">{totals.total}</span>
            <span className="ddp-cell ddp-cell-arrow" />
          </div>
        </div>
      ) : (
        <p className="ddp-empty">No attendance records are available for the selected date.</p>
      )}
    </div>
  );
}
