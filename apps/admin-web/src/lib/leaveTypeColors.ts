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
// All bright/fully-saturated — no black, no dark/muted shades — and spaced
// around the hue wheel (red/orange/yellow/lime/green/teal/purple/pink) so no
// two read as the same color even next to each other. Blue is deliberately
// left out here — it's reserved for Vacation Leave below — so nothing else
// can ever cycle onto it and get confused for Vacation's color.
export const LEAVE_TYPE_COLORS = [
  "#EF4444", // Red
  "#FB923C", // Orange
  "#EAB308", // Yellow
  "#84CC16", // Lime
  "#22C55E", // Green
  "#2DD4BF", // Teal
  "#A855F7", // Purple
  "#EC4899", // Pink
];

// Overrides the index-based palette above for specific leave types.
// - Vacation Leave is always the same "vacation" blue, regardless of where
//   it lands in the list — Blue is excluded from the array above so no
//   other type can ever collide with it.
// - Bereavement's Fuchsia sits in the one hue gap the main palette doesn't
//   use, so it also stays distinct no matter which index the rest land on.
const LEAVE_TYPE_COLOR_OVERRIDES: Record<string, string> = {
  "Vacation Leave": "#3B82F6",
  "Bereavement Leave": "#D946EF",
};

export function colorForLeaveType(name: string, index: number): string {
  return LEAVE_TYPE_COLOR_OVERRIDES[name] ?? LEAVE_TYPE_COLORS[index % LEAVE_TYPE_COLORS.length];
}
