import React, { useCallback, useEffect, useState } from "react";
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

function formatHours(totalMinutes: number) {
  if (!totalMinutes) return "--";
  return `${(totalMinutes / 60).toFixed(1)} hrs`;
}

function statusTone(status: string) {
  if (status === "PRESENT") return { color: "#17A34A", icon: "checkmark-circle" as const };
  if (status === "LATE") return { color: "#D97706", icon: "alert-circle" as const };
  if (status === "ON_LEAVE") return { color: "#1680D8", icon: "calendar" as const };
  if (status === "OFFICIAL_BUSINESS") return { color: "#7C3AED", icon: "briefcase" as const };
  if (status === "ABSENT") return { color: "#DC2626", icon: "close-circle" as const };
  return { color: "#94A3B8", icon: "time" as const };
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

  return (
    <FlatList
      data={records}
      keyExtractor={(item) => item.id}
      refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} colors={["#1680D8"]} />}
      ListHeaderComponent={<Text style={styles.cardTitle}>Daily Time Record</Text>}
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
        return (
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.dateText}>{formatDate(item.attendanceDate)}</Text>
              <Text style={styles.timesText}>
                {formatTime(item.timeInAt)} - {formatTime(item.timeOutAt)} · {formatHours(item.totalMinutes)}
              </Text>
            </View>
            <Ionicons name={tone.icon} size={20} color={tone.color} />
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
    marginBottom: 10,
  },
  row: {
    minHeight: 50,
    borderBottomWidth: 1,
    borderColor: "#edf3f8",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 8,
  },
  dateText: {
    color: "#062B59",
    fontWeight: "700",
    fontSize: 14,
  },
  timesText: {
    color: "#64748B",
    fontSize: 12,
    marginTop: 2,
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
