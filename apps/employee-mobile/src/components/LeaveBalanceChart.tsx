import React from "react";
import { View, Text, StyleSheet, ActivityIndicator, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Svg, { Circle } from "react-native-svg";
import { LeaveBalance } from "../api";

const LEAVE_TYPE_COLORS = ["#1680D8", "#1BAF7A", "#EDA100", "#E34948", "#7C3AED", "#0EA5B8", "#D6336C", "#4A3AA7"];

const RING_SIZE = 84;
const RING_STROKE = 9;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

type Props = {
  balances: LeaveBalance[];
  loading?: boolean;
  pendingCount?: number;
  onPressPending?: () => void;
};

export default function LeaveBalanceChart({ balances, loading, pendingCount, onPressPending }: Props) {
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
          return { id: balance.leaveTypeId, color: LEAVE_TYPE_COLORS[index % LEAVE_TYPE_COLORS.length], length, offset };
        })
        .filter((segment) => segment.length > 0)
    : [];

  const header = (
    <View style={styles.headerRow}>
      <Text style={styles.cardTitle}>My Leave Balance</Text>
      {!!pendingCount && (
        <Pressable style={styles.pendingPill} onPress={onPressPending}>
          <Ionicons name="time-outline" size={12} color="#92400E" />
          <Text style={styles.pendingPillText}>{pendingCount} Pending</Text>
        </Pressable>
      )}
    </View>
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
            <Text style={styles.ringValue}>{totalRemaining}</Text>
            <Text style={styles.ringLabel}>left</Text>
            <Text style={styles.ringPercent}>{usedPercent}% used</Text>
          </View>
        </View>

        <View style={styles.statsCol}>
          <View style={styles.statRow}>
            <View style={[styles.statDot, { backgroundColor: "#062B59" }]} />
            <Text style={styles.statLabel}>Earned</Text>
            <Text style={styles.statValue}>{totalEarned}</Text>
          </View>
          <View style={styles.statRow}>
            <View style={[styles.statDot, { backgroundColor: "#1680D8" }]} />
            <Text style={styles.statLabel}>Used</Text>
            <Text style={styles.statValue}>{totalUsed}</Text>
          </View>
          <View style={styles.statRow}>
            <View style={[styles.statDot, { backgroundColor: "#DCE7F5" }]} />
            <Text style={styles.statLabel}>Remaining</Text>
            <Text style={styles.statValue}>{totalRemaining}</Text>
          </View>
        </View>
      </View>

      <View style={styles.divider} />

      <View style={styles.barsGrid}>
        {balances.map((balance, index) => {
          const color = LEAVE_TYPE_COLORS[index % LEAVE_TYPE_COLORS.length];
          const ratio = balance.earnedDays > 0 ? Math.min(1, balance.remainingDays / balance.earnedDays) : 0;
          return (
            <View key={balance.leaveTypeId} style={styles.barCell}>
              <View style={styles.barLabelRow}>
                <View style={[styles.statDot, { backgroundColor: color }]} />
                <Text style={styles.barLabel} numberOfLines={1}>{balance.leaveTypeName}</Text>
              </View>
              <View style={styles.barTrack}>
                <View style={[styles.barFill, { width: `${ratio * 100}%`, backgroundColor: color }]} />
              </View>
              <Text style={styles.barValue}>{balance.remainingDays}/{balance.earnedDays} days</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    marginBottom: 12,
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
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
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
  ringValue: {
    fontSize: 18,
    fontWeight: "800",
    color: "#062B59",
  },
  ringLabel: {
    fontSize: 10,
    color: "#64748B",
    marginTop: 1,
  },
  ringPercent: {
    fontSize: 9,
    fontWeight: "700",
    color: "#1680D8",
    marginTop: 2,
  },
  statsCol: {
    flex: 1,
    gap: 6,
  },
  statRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  statDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  statLabel: {
    flex: 1,
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
    marginVertical: 12,
  },
  barsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  barCell: {
    width: "47%",
    gap: 4,
  },
  barLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
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
});
