import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, SafeAreaView, ScrollView, ActivityIndicator, RefreshControl } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { TeamAttendanceRecord, getTeamAttendance } from "../../api";
import EmptyState from "../../components/EmptyState";
import Avatar from "../../components/Avatar";
import StatusPill from "../../components/StatusPill";

function formatTime(value?: string | null) {
  return value ? new Date(value).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "--:--";
}

const STATUS_FILTERS = ["ALL", "PRESENT", "LATE", "ABSENT", "ON_LEAVE"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

export default function SupervisorAttendanceScreen() {
  const [records, setRecords] = useState<TeamAttendanceRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");

  const load = useCallback(async (isRefresh = false) => {
    isRefresh ? setIsRefreshing(true) : setIsLoading(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const data = await getTeamAttendance({ date: today });
      setRecords(data);
    } catch (error) {
      console.error("Failed to load team attendance", error);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const searched = useMemo(
    () =>
      records.filter((r) =>
        `${r.employee.firstName} ${r.employee.lastName}`.toLowerCase().includes(search.toLowerCase()),
      ),
    [records, search],
  );

  const filtered = useMemo(
    () => (statusFilter === "ALL" ? searched : searched.filter((r) => r.status === statusFilter)),
    [searched, statusFilter],
  );

  const presentCount = searched.filter((r) => r.status === "PRESENT" || r.status === "LATE").length;

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.searchBox}>
        <Ionicons name="search-outline" size={16} color="#94A3B8" />
        <TextInput style={styles.searchInput} placeholder="Search employees..." value={search} onChangeText={setSearch} />
      </View>

      <View style={styles.summaryRow}>
        <Text style={styles.dateLabel}>{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</Text>
        {!isLoading && (
          <Text style={styles.countBadge}>
            {presentCount}/{searched.length} in today
          </Text>
        )}
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filterRow}
        contentContainerStyle={styles.filterRowContent}
      >
        {STATUS_FILTERS.map((status) => {
          const active = statusFilter === status;
          return (
            <Pressable key={status} style={[styles.filterChip, active && styles.filterChipActive]} onPress={() => setStatusFilter(status)}>
              <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>{status.replace("_", " ")}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator color="#062B59" size="large" />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={() => load(true)} tintColor="#062B59" />}
        >
          {filtered.length === 0 ? (
            <EmptyState
              icon="time-outline"
              title="No attendance records"
              message={statusFilter === "ALL" ? "Nothing logged for your team today yet." : `No ${statusFilter.replace("_", " ").toLowerCase()} records today.`}
            />
          ) : (
            filtered.map((record) => (
              <View key={record.id} style={styles.card}>
                <Avatar firstName={record.employee.firstName} lastName={record.employee.lastName} size={38} />
                <View style={{ flex: 1 }}>
                  <View style={styles.cardHeader}>
                    <Text style={styles.employeeName} numberOfLines={1}>
                      {record.employee.firstName} {record.employee.lastName}
                    </Text>
                    <StatusPill status={record.status} />
                  </View>
                  <View style={styles.timesRow}>
                    <View style={styles.timeChip}>
                      <Ionicons name="log-in-outline" size={13} color="#15803D" />
                      <Text style={styles.timeText}>{formatTime(record.timeInAt)}</Text>
                    </View>
                    <View style={styles.timeChip}>
                      <Ionicons name="log-out-outline" size={13} color="#B91C1C" />
                      <Text style={styles.timeText}>{formatTime(record.timeOutAt)}</Text>
                    </View>
                    {(record.lunchOutAt || record.lunchInAt) && (
                      <View style={styles.timeChip}>
                        <Ionicons name="cafe-outline" size={13} color="#EA580C" />
                        <Text style={styles.timeText}>
                          {formatTime(record.lunchOutAt)} - {formatTime(record.lunchInAt)}
                        </Text>
                      </View>
                    )}
                  </View>
                  {record.workLocation && (
                    <View style={styles.locationRow}>
                      <Ionicons name="location-outline" size={12} color="#64748B" />
                      <Text style={styles.locationText}>{record.workLocation.name}</Text>
                    </View>
                  )}
                </View>
              </View>
            ))
          )}
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
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 46,
    borderRadius: 14,
    paddingHorizontal: 14,
    backgroundColor: "#FFFFFF",
    ...cardShadow,
  },
  searchInput: { flex: 1, fontSize: 14 },
  summaryRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 14, marginBottom: 10 },
  dateLabel: { fontSize: 12, color: "#64748B", fontWeight: "600" },
  countBadge: { fontSize: 12, color: "#15803D", fontWeight: "700", backgroundColor: "#DCFCE7", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  filterRow: { flexGrow: 0, height: 48, marginBottom: 10 },
  filterRowContent: { alignItems: "center", gap: 8 },
  filterChip: {
    height: 40,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#E2E8F0",
  },
  filterChipActive: { backgroundColor: "#062B59", borderColor: "#062B59" },
  filterChipText: {
    fontSize: 12,
    lineHeight: 18,
    fontWeight: "700",
    color: "#475569",
    includeFontPadding: false,
  },
  filterChipTextActive: { color: "#FFFFFF" },
  list: { paddingTop: 4, paddingBottom: 24, gap: 10 },
  card: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    padding: 14,
    ...cardShadow,
  },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  employeeName: { fontSize: 14, fontWeight: "700", color: "#062B59", flexShrink: 1 },
  timesRow: { flexDirection: "row", gap: 10, marginTop: 8 },
  timeChip: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "#F8FAFC", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  timeText: { fontSize: 12, color: "#334155", fontWeight: "600" },
  locationRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 6 },
  locationText: { fontSize: 11, color: "#64748B" },
});
