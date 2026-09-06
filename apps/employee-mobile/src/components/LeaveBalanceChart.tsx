import React from "react";
import { View, Text, StyleSheet, ActivityIndicator, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Svg, { Circle } from "react-native-svg";
import { LeaveBalance } from "../api";
import AestheticScrollView from "./AestheticScrollView";

// Kept distinct from the summary ring's own legend colors (#062B59 Earned,
// #1680D8 Used, #DCE7F5 Remaining) so no leave type visually collides with
// them, and long enough that a typical leave-type list doesn't wrap back
// onto its own first color.
const LEAVE_TYPE_COLORS = [
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

function colorForLeaveType(name: string, index: number): string {
  return LEAVE_TYPE_COLOR_OVERRIDES[name] ?? LEAVE_TYPE_COLORS[index % LEAVE_TYPE_COLORS.length];
}

const RING_SIZE = 94;
const RING_STROKE = 10;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

type Props = {
  balances: LeaveBalance[];
  loading?: boolean;
  pendingCount?: number;
  onPressPending?: () => void;
  onPressViewAll?: () => void;
  onRequestLeave?: (leaveTypeId: string) => void;
  // How many of pendingCount are specifically NEEDS_REVISION — those need the
  // employee to act (resubmit), unlike a plain PENDING/SUPERVISOR_APPROVED
  // request that's just awaiting someone else's decision, so the pill calls
  // that out instead of lumping everything under "Pending".
  needsRevisionCount?: number;
};

export default function LeaveBalanceChart({ balances, loading, pendingCount, onPressPending, onPressViewAll, onRequestLeave, needsRevisionCount }: Props) {
  const totalEarned = balances.reduce((sum, b) => sum + b.earnedDays, 0);
  const totalUsed = balances.reduce((sum, b) => sum + b.usedDays, 0);
  const totalRemaining = balances.reduce((sum, b) => sum + b.remainingDays, 0);
  const usedPercent = totalEarned > 0 ? Math.round((totalUsed / totalEarned) * 100) : 0;

  let cumulativeOffset = 0;
  const ringSegments = totalEarned > 0
    ? balances
        .map((balance, index) => {
          const length = (balance.usedDays / totalEarned) * RING_CIRCUMFERENCE;
          const offset = cumulativeOffset;
          cumulativeOffset += length;
          return { id: balance.leaveTypeId, color: colorForLeaveType(balance.leaveTypeName, index), length, offset };
        })
        .filter((segment) => segment.length > 0)
    : [];

  const otherPendingCount = (pendingCount ?? 0) - (needsRevisionCount ?? 0);
  // Dark red for the Needs Revision part specifically — that's the part
  // that needs the employee to act (resubmit). The pill itself stays one
  // consistent amber container; only this text segment's color calls it out.
  const needsRevisionColor = "#EF4444";

  const header = (
    <View style={styles.headerWrap}>
      <Text style={styles.cardTitle}>My Leave Balance</Text>
      {/* Its own row below the title rather than squeezed in alongside it —
          the label varies from a short "2 Pending" to a much longer
          "1 Needs Revision · 1 Pending", so it needs the full card width to
          sit on, not just whatever's left over next to the title. */}
      {!!pendingCount && (
        <Pressable style={styles.pendingPill} onPress={onPressPending}>
          <Ionicons name="time-outline" size={12} color="#92400E" />
          <Text style={styles.pendingPillText}>
            {needsRevisionCount ? (
              <>
                <Text style={{ color: needsRevisionColor }}>{needsRevisionCount} Needs Revision</Text>
                {otherPendingCount > 0 && <>{" · "}{otherPendingCount} Pending</>}
              </>
            ) : (
              `${pendingCount} Pending`
            )}
          </Text>
        </Pressable>
      )}
    </View>
  );

  const viewAllButton = onPressViewAll && (
    <Pressable style={styles.viewAllButton} onPress={onPressViewAll}>
      <Ionicons name="calendar-outline" size={14} color="#1680D8" />
      <Text style={styles.viewAllButtonText}>View Filed Leave</Text>
    </Pressable>
  );

  if (loading) {
    return (
      <View style={styles.card}>
        {header}
        <View style={styles.centered}>
          <ActivityIndicator color="#1680D8" />
        </View>
      </View>
    );
  }

  if (balances.length === 0) {
    return (
      <View style={styles.card}>
        {header}
        <View style={styles.centered}>
          <Text style={styles.emptyText}>No leave balance data yet.</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      {header}

      <View style={styles.summaryRow}>
        <View style={styles.ringWrap}>
          <Svg width={RING_SIZE} height={RING_SIZE}>
            <Circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RING_RADIUS}
              fill="none"
              stroke="#EEF2F7"
              strokeWidth={RING_STROKE}
            />
            {ringSegments.map((segment) => (
              <Circle
                key={segment.id}
                cx={RING_SIZE / 2}
                cy={RING_SIZE / 2}
                r={RING_RADIUS}
                fill="none"
                stroke={segment.color}
                strokeWidth={RING_STROKE}
                strokeDasharray={`${segment.length} ${RING_CIRCUMFERENCE - segment.length}`}
                strokeDashoffset={-segment.offset}
                transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
              />
            ))}
          </Svg>
          <View style={styles.ringCenter}>
            <Text style={styles.ringPercent}>{usedPercent}% used</Text>
          </View>
        </View>

        <View style={styles.statsCol}>
          <View style={styles.heroRow}>
            <Text style={styles.heroValue}>{totalRemaining}</Text>
            <Text style={styles.heroLabel}>Remaining</Text>
          </View>

          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Earned</Text>
            <Text style={styles.statValue}>{totalEarned}</Text>
          </View>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Used</Text>
            <Text style={styles.statValue}>{totalUsed}</Text>
          </View>
        </View>
      </View>

      {viewAllButton}

      <View style={styles.divider} />

      <AestheticScrollView style={styles.barsScroll} nestedScrollEnabled>
      <View style={styles.barsGrid}>
        {balances.map((balance, index) => {
          const color = colorForLeaveType(balance.leaveTypeName, index);
          const ratio = balance.earnedDays > 0 ? Math.min(1, balance.usedDays / balance.earnedDays) : 0;
          return (
            <View key={balance.leaveTypeId} style={styles.barCell}>
              <View style={styles.barLabelRow}>
                <View style={[styles.statDot, { backgroundColor: color }]} />
                <Text style={styles.barLabel} numberOfLines={1}>{balance.leaveTypeName}</Text>
              </View>
              <View style={styles.barTrack}>
                <View style={[styles.barFill, { width: `${ratio * 100}%`, backgroundColor: color }]} />
              </View>
              <Text style={styles.barValue}>{balance.usedDays}/{balance.earnedDays} days used</Text>
              {onRequestLeave && (
                <Pressable
                  style={styles.requestButton}
                  onPress={() => onRequestLeave(balance.leaveTypeId)}
                >
                  <Ionicons name="add-circle-outline" size={11} color="#1680D8" />
                  <Text style={styles.requestButtonText}>Request</Text>
                </Pressable>
              )}
            </View>
          );
        })}
      </View>
      </AestheticScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    backgroundColor: "#FFFFFF",
    borderRadius: 18,
    padding: 14,
    borderWidth: 1,
    borderColor: "#E2E8F0",
  },
  centered: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 80,
  },
  emptyText: {
    color: "#94A3B8",
    fontSize: 13,
  },
  headerWrap: {
    gap: 8,
    marginBottom: 12,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#062B59",
  },
  pendingPill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 4,
    backgroundColor: "#FFFBEB",
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: "#FEF3C7",
  },
  pendingPillText: {
    color: "#92400E",
    fontSize: 11,
    fontWeight: "700",
  },
  viewAllButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: "#F8FAFF",
    borderWidth: 1,
    borderColor: "#BFDBFE",
    borderRadius: 10,
    paddingVertical: 8,
    marginTop: 12,
    marginBottom: 12,
  },
  viewAllButtonText: {
    color: "#1680D8",
    fontSize: 12,
    fontWeight: "700",
  },
  summaryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  ringWrap: {
    width: RING_SIZE,
    height: RING_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  ringCenter: {
    position: "absolute",
    alignItems: "center",
  },
  ringPercent: {
    fontSize: 11,
    fontWeight: "700",
    color: "#1680D8",
  },
  heroRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 5,
    marginBottom: 8,
  },
  heroValue: {
    fontSize: 26,
    fontWeight: "800",
    color: "#062B59",
    letterSpacing: -0.3,
  },
  heroLabel: {
    fontSize: 18,
    fontWeight: "600",
    color: "#64748B",
  },
  statDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  statsCol: {
    flex: 1,
    gap: 6,
  },
  statRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  statLabel: {
    color: "#64748B",
    fontSize: 12,
  },
  statValue: {
    fontWeight: "700",
    color: "#062B59",
    fontSize: 13,
  },
  divider: {
    height: 1,
    backgroundColor: "#F1F5F9",
    marginVertical: 10,
  },
  barsScroll: {
    flex: 1,
  },
  barsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    columnGap: 10,
  },
  barCell: {
    width: "47%",
    marginBottom: 14,
  },
  barLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 6,
  },
  barLabel: {
    flex: 1,
    fontSize: 11,
    color: "#334155",
    fontWeight: "600",
  },
  barValue: {
    fontSize: 10,
    fontWeight: "700",
    color: "#062B59",
    marginTop: 6,
  },
  barTrack: {
    height: 5,
    borderRadius: 3,
    backgroundColor: "#F1F5F9",
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    borderRadius: 3,
  },
  requestButton: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 3,
    marginTop: 4,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#BFDBFE",
    backgroundColor: "#F8FAFF",
  },
  requestButtonText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#1680D8",
  },
});
