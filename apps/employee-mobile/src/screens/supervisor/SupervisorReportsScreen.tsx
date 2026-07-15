import React from "react";
import { View, Text, Pressable, StyleSheet, SafeAreaView, ScrollView, ActivityIndicator, Share } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ReportsSummary, getReportsSummary } from "../../api";
import { useCachedData } from "../../utils/dataCache";
import StatusPill from "../../components/StatusPill";

type Props = {
  onClose: () => void;
};

function BreakdownBars({ data }: { data: Record<string, number> }) {
  const entries = Object.entries(data);
  const max = Math.max(1, ...entries.map(([, count]) => count));

  if (entries.length === 0) {
    return <Text style={styles.emptyBreakdown}>No data for this period.</Text>;
  }

  return (
    <View style={{ gap: 12 }}>
      {entries.map(([status, count]) => (
        <View key={status}>
          <View style={styles.barHeaderRow}>
            <StatusPill status={status} />
            <Text style={styles.rowValue}>{count}</Text>
          </View>
          <View style={styles.barTrack}>
            <View style={[styles.barFill, { width: `${(count / max) * 100}%` }]} />
          </View>
        </View>
      ))}
    </View>
  );
}

export default function SupervisorReportsScreen({ onClose }: Props) {
  const { data: summary, isLoading } = useCachedData<ReportsSummary>(
    "team-reports-summary",
    () => getReportsSummary(),
  );

  async function handleShare() {
    if (!summary) return;
    const lines = [
      `Report generated ${new Date(summary.generatedAt).toLocaleString()}`,
      "",
      `Attendance records: ${summary.totals.attendanceRecords}`,
      `Approved leaves: ${summary.totals.approvedLeaves}`,
      `Pending leaves: ${summary.totals.pendingLeaves}`,
      `Active schedules: ${summary.totals.activeSchedules}`,
      "",
      "Attendance by status:",
      ...Object.entries(summary.attendanceByStatus).map(([status, count]) => `  ${status}: ${count}`),
      "",
      "Leave by status:",
      ...Object.entries(summary.leaveByStatus).map(([status, count]) => `  ${status}: ${count}`),
    ];
    await Share.share({ message: lines.join("\n") });
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.headerRow}>
        <Pressable onPress={onClose} hitSlop={10}>
          <Ionicons name="chevron-back" size={22} color="#062B59" />
        </Pressable>
        <Text style={styles.headerTitle}>Reports</Text>
        <Pressable style={({ pressed }) => [styles.shareButton, pressed && styles.shareButtonPressed]} onPress={handleShare}>
          <Ionicons name="share-outline" size={16} color="#FFFFFF" />
        </Pressable>
      </View>

      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator color="#062B59" size="large" />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          <View style={styles.grid}>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{summary?.totals.attendanceRecords ?? 0}</Text>
              <Text style={styles.statLabel}>Attendance Records</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{summary?.totals.approvedLeaves ?? 0}</Text>
              <Text style={styles.statLabel}>Approved Leaves</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{summary?.totals.pendingLeaves ?? 0}</Text>
              <Text style={styles.statLabel}>Pending Leaves</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{summary?.totals.activeSchedules ?? 0}</Text>
              <Text style={styles.statLabel}>Active Schedules</Text>
            </View>
          </View>

          <View style={styles.card}>
            <View style={styles.cardHeaderRow}>
              <View style={[styles.cardIconWrap, { backgroundColor: "#E0F2FE" }]}>
                <Ionicons name="time-outline" size={16} color="#0EA5E9" />
              </View>
              <Text style={styles.cardTitle}>Attendance by Status</Text>
            </View>
            <BreakdownBars data={summary?.attendanceByStatus ?? {}} />
          </View>

          <View style={styles.card}>
            <View style={styles.cardHeaderRow}>
              <View style={[styles.cardIconWrap, { backgroundColor: "#EDE9FE" }]}>
                <Ionicons name="calendar-outline" size={16} color="#7C3AED" />
              </View>
              <Text style={styles.cardTitle}>Leave by Status</Text>
            </View>
            <BreakdownBars data={summary?.leaveByStatus ?? {}} />
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const cardShadow = {
  shadowColor: "#0F172A",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.06,
  shadowRadius: 8,
  elevation: 2,
};

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 14 },
  headerTitle: { fontSize: 16, fontWeight: "700", color: "#062B59" },
  shareButton: { width: 34, height: 34, borderRadius: 10, backgroundColor: "#062B59", alignItems: "center", justifyContent: "center" },
  shareButtonPressed: { opacity: 0.8 },
  list: { paddingBottom: 24 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginBottom: 12 },
  statCard: { width: "47%", backgroundColor: "#FFFFFF", borderRadius: 16, padding: 14, ...cardShadow },
  statValue: { fontSize: 22, fontWeight: "800", color: "#062B59" },
  statLabel: { fontSize: 12, color: "#64748B", marginTop: 2, fontWeight: "500" },
  card: { backgroundColor: "#FFFFFF", borderRadius: 16, padding: 16, marginTop: 4, marginBottom: 12, ...cardShadow },
  cardHeaderRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 14 },
  cardIconWrap: { width: 30, height: 30, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  cardTitle: { fontSize: 14, fontWeight: "700", color: "#062B59" },
  barHeaderRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
  barTrack: { height: 7, borderRadius: 999, backgroundColor: "#F1F5F9", overflow: "hidden" },
  barFill: { height: 7, borderRadius: 999, backgroundColor: "#1680D8" },
  rowValue: { fontSize: 13, fontWeight: "700", color: "#062B59" },
  emptyBreakdown: { fontSize: 12, color: "#94A3B8", textAlign: "center", paddingVertical: 8 },
});
