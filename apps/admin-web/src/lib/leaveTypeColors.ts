// Per-leave-type chart colors, shared by every leave-balance visual in the
// app (the employee portal's LeaveBalanceChart and the admin Leave Balances
// drill-down ring) so one leave type is the same color everywhere.
//
// Mirrors employee-mobile's LeaveBalanceChart.tsx — same palette, same
// per-type color assignment (by array index), so the two platforms read as
// the same feature.
// Kept distinct from the summary ring's own legend colors (#062B59 Earned,
// #1680D8 Used, #DCE7F5 Remaining) so no leave type visually collides with
// them, and long enough that a typical leave-type list doesn't wrap back
// onto its own first color.
export const LEAVE_TYPE_COLORS = [
  "#F97316",
  "#1BAF7A",
  "#EDA100",
  "#E34948",
  "#7C3AED",
  "#0EA5B8",
  "#D6336C",
  "#4A3AA7",
  "#65A30D",
];

// Overrides the index-based palette above for specific leave types.
const LEAVE_TYPE_COLOR_OVERRIDES: Record<string, string> = {
  "Bereavement Leave": "#C71585",
};

export function colorForLeaveType(name: string, index: number): string {
  return LEAVE_TYPE_COLOR_OVERRIDES[name] ?? LEAVE_TYPE_COLORS[index % LEAVE_TYPE_COLORS.length];
}
