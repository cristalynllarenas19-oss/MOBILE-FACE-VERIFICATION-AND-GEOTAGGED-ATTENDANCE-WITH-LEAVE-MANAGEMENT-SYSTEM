import { DeptAttendanceRow } from "../../components/ui/BarChart";

export type RateTone = "good" | "warn" | "bad";

export function computeAttendanceRate(row: DeptAttendanceRow): { rate: number; total: number; attended: number } {
  const total = row.present + row.late + row.absent + row.onLeave + row.officialBusiness;
  const attended = row.present + row.late;
  const rate = total > 0 ? Math.round((attended / total) * 100) : 0;
  return { rate, total, attended };
}

export function getRateTone(rate: number): RateTone {
  if (rate >= 85) return "good";
  if (rate >= 70) return "warn";
  return "bad";
}

export const RATE_TONE_COLOR: Record<RateTone, string> = {
  good: "#1baf7a",
  warn: "#eda100",
  bad: "#e34948",
};
