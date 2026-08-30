import React, { useCallback, useState } from "react";
import { View, Text, Pressable, StyleSheet, SafeAreaView, ActivityIndicator, RefreshControl } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ScheduleAssignment, getSchedules } from "../../api";
import { useCachedData } from "../../utils/dataCache";
import EmptyState from "../../components/EmptyState";
import Avatar from "../../components/Avatar";
import AestheticScrollView from "../../components/AestheticScrollView";

type Props = {
  onClose: () => void;
};

function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleDateString() : "Present";
}

export default function SupervisorSchedulesScreen({ onClose }: Props) {
  const [isRefreshing, setIsRefreshing] = useState(false);

  const { data, isLoading, refresh } = useCachedData<ScheduleAssignment[]>("team-schedules", getSchedules);
  const schedules = data ?? [];

  const load = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setIsRefreshing(true);
      try {
        await refresh();
      } catch (error) {
        console.error("Failed to load schedules", error);
      } finally {
        setIsRefreshing(false);
      }
    },
    [refresh],
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.headerRow}>
        <Pressable onPress={onClose} hitSlop={10}>
          <Ionicons name="chevron-back" size={22} color="#062B59" />
        </Pressable>
        <Text style={styles.headerTitle}>Schedules</Text>
        <View style={{ width: 22 }} />
      </View>

      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator color="#062B59" size="large" />
        </View>
      ) : (
        <AestheticScrollView
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={() => load(true)} tintColor="#062B59" />}
        >
          {schedules.length === 0 ? (
            <EmptyState icon="time-outline" title="No schedules" message="Shift assignments for your department will appear here." />
          ) : (
            schedules.map((schedule) => (
              <View key={schedule.id} style={styles.card}>
                <Avatar firstName={schedule.employee.firstName} lastName={schedule.employee.lastName} size={38} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.employeeName}>{schedule.employee.firstName} {schedule.employee.lastName}</Text>
                  <View style={styles.shiftChip}>
                    <Ionicons name="time-outline" size={12} color="#B45309" />
                    <Text style={styles.shiftText}>
                      {schedule.shift.name} · {schedule.shift.startTime}–{schedule.shift.endTime}
                    </Text>
                  </View>
                  <Text style={styles.dateText}>
                    {formatDate(schedule.startsOn)} → {formatDate(schedule.endsOn)}
                  </Text>
                </View>
              </View>
            ))
          )}
        </AestheticScrollView>
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
  list: { paddingBottom: 24, gap: 10 },
  card: { flexDirection: "row", alignItems: "flex-start", gap: 12, backgroundColor: "#FFFFFF", borderRadius: 16, padding: 14, ...cardShadow },
  employeeName: { fontSize: 14, fontWeight: "700", color: "#062B59" },
  shiftChip: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "#FEF3C7", alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, marginTop: 6 },
  shiftText: { fontSize: 11, color: "#92400E", fontWeight: "600" },
  dateText: { fontSize: 11, color: "#64748B", marginTop: 6 },
});
