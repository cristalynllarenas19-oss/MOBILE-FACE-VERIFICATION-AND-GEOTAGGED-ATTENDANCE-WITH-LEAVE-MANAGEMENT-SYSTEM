import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { AttendanceHistoryRecord, getAttendanceHistory } from "../api";

type Props = {
  employeeId?: string;
};

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function formatTime(value: string | null) {
  if (!value) return "--:--";
  return new Date(value).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function formatHoursRendered(totalMinutes: number) {
  if (!totalMinutes) return null;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

function statusTone(status: string) {
  if (status === "PRESENT") return { color: "#17A34A", bg: "#ECFDF3", icon: "checkmark-circle" as const };
  if (status === "LATE") return { color: "#D97706", bg: "#FFFBEB", icon: "alert-circle" as const };
  if (status === "ON_LEAVE") return { color: "#1680D8", bg: "#EFF6FF", icon: "calendar" as const };
  if (status === "OFFICIAL_BUSINESS") return { color: "#7C3AED", bg: "#F5F3FF", icon: "briefcase" as const };
  if (status === "ABSENT") return { color: "#DC2626", bg: "#FEF2F2", icon: "close-circle" as const };
  return { color: "#94A3B8", bg: "#F8FAFC", icon: "time" as const };
}

export default function DTRScreen({ employeeId }: Props) {
  const [records, setRecords] = useState<AttendanceHistoryRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!employeeId) return;
    try {
      const data = await getAttendanceHistory(employeeId);
      setRecords(data);
    } catch (error) {
      console.error("Failed to load attendance history", error);
    }
  }, [employeeId]);

  useEffect(() => {
    setIsLoading(true);
    load().finally(() => setIsLoading(false));
  }, [load]);

  async function handleRefresh() {
    setIsRefreshing(true);
    await load();
    setIsRefreshing(false);
  }

  const todayRecord = useMemo(() => {
    const todayKey = new Date().toDateString();
    return records.find((record) => new Date(record.attendanceDate).toDateString() === todayKey) ?? null;
  }, [records]);

  const todayInProgress = Boolean(todayRecord?.timeInAt) && !todayRecord?.timeOutAt;

  return (
    <FlatList
      data={records}
      keyExtractor={(item) => item.id}
      refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} colors={["#1680D8"]} />}
      ListHeaderComponent={
        <>
          <Text style={styles.cardTitle}>Daily Time Record</Text>
          <View style={styles.summaryCard}>
            <Ionicons name="time" size={22} color="#1680D8" />
            <View style={{ flex: 1 }}>
              <Text style={styles.summaryLabel}>Today's Hours Rendered</Text>
              <Text style={styles.summaryValue}>
                {todayRecord
                  ? formatHoursRendered(todayRecord.totalMinutes) ?? (todayInProgress ? "In progress" : "--")
                  : "Not yet timed in"}
              </Text>
            </View>
          </View>
        </>
      }
      ListEmptyComponent={
        !isLoading ? (
          <View style={styles.emptyState}>
            <Ionicons name="document-text-outline" size={36} color="#CBD5E1" />
            <Text style={styles.emptyText}>No attendance records yet.</Text>
          </View>
        ) : null
      }
      contentContainerStyle={styles.listContainer}
      renderItem={({ item }) => {
        const tone = statusTone(item.status);
        const hoursRendered = formatHoursRendered(item.totalMinutes);
        const inProgress = Boolean(item.timeInAt) && !item.timeOutAt;

        return (
          <View style={styles.row}>
            <View style={styles.rowTop}>
              <Text style={styles.dateText}>{formatDate(item.attendanceDate)}</Text>
              <View style={[styles.statusBadge, { backgroundColor: tone.bg }]}>
                <Ionicons name={tone.icon} size={12} color={tone.color} />
                <Text style={[styles.statusBadgeText, { color: tone.color }]}>{item.status.replace("_", " ")}</Text>
              </View>
            </View>

            <View style={styles.rowBody}>
              <View style={styles.timeBlock}>
                <Text style={styles.timeLabel}>Time In</Text>
                <Text style={styles.timeValue}>{formatTime(item.timeInAt)}</Text>
              </View>
              <Ionicons name="arrow-forward" size={14} color="#CBD5E1" />
              <View style={styles.timeBlock}>
                <Text style={styles.timeLabel}>Time Out</Text>
                <Text style={styles.timeValue}>{formatTime(item.timeOutAt)}</Text>
              </View>

              <View style={styles.hoursBlock}>
                <Text style={styles.timeLabel}>Hours Rendered</Text>
                <Text style={[styles.hoursValue, !hoursRendered && styles.hoursValueMuted]}>
                  {hoursRendered ?? (inProgress ? "In progress" : "--")}
                </Text>
              </View>
            </View>
          </View>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  listContainer: {
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#dbe5ef",
    padding: 18,
    flexGrow: 1,
  },
  cardTitle: {
    color: "#062b59",
    fontSize: 18,
    fontWeight: "900",
    marginBottom: 14,
  },
  summaryCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#EFF6FF",
    borderRadius: 14,
    padding: 14,
    marginBottom: 18,
  },
  summaryLabel: {
    color: "#1E3A8A",
    fontSize: 12,
    fontWeight: "600",
  },
  summaryValue: {
    color: "#062B59",
    fontSize: 20,
    fontWeight: "800",
    marginTop: 2,
  },
  row: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderColor: "#edf3f8",
  },
  rowTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  dateText: {
    color: "#062B59",
    fontWeight: "700",
    fontSize: 14,
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  statusBadgeText: {
    fontSize: 10,
    fontWeight: "700",
  },
  rowBody: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  timeBlock: {
    flex: 1,
  },
  timeLabel: {
    color: "#94A3B8",
    fontSize: 11,
    fontWeight: "600",
  },
  timeValue: {
    color: "#334155",
    fontSize: 14,
    fontWeight: "700",
    marginTop: 2,
  },
  hoursBlock: {
    flex: 1.2,
    alignItems: "flex-end",
  },
  hoursValue: {
    color: "#17A34A",
    fontSize: 15,
    fontWeight: "800",
    marginTop: 2,
  },
  hoursValueMuted: {
    color: "#94A3B8",
    fontSize: 13,
    fontWeight: "600",
  },
  emptyState: {
    alignItems: "center",
    gap: 8,
    paddingTop: 30,
  },
  emptyText: {
    color: "#94A3B8",
    fontSize: 13,
    fontWeight: "600",
  },
});
