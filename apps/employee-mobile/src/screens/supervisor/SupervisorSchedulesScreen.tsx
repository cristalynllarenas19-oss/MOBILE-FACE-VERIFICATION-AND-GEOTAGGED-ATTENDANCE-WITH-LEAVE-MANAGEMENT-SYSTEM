import React, { useCallback, useMemo, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, SafeAreaView, ActivityIndicator, RefreshControl } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ScheduleAssignment, getSchedules } from "../../api";
import { useCachedData } from "../../utils/dataCache";
import Avatar from "../../components/Avatar";
import AestheticScrollView from "../../components/AestheticScrollView";
import SegmentedControl from "../../components/SegmentedControl";
import { ui } from "../../styles/ui";

type Props = {
  onClose: () => void;
};

// Where an assignment sits relative to today. A Supervisor only reads
// schedules (schedules:read) — assigning shifts is HR/Admin work — so this
// screen is about finding who is on what, and when.
type ScheduleState = "current" | "upcoming" | "ended";
type StateFilter = "all" | ScheduleState;

const STATE_TONES: Record<ScheduleState, { label: string; color: string; backgroundColor: string }> = {
  current: { label: "Current", color: "#15803D", backgroundColor: "#DCFCE7" },
  upcoming: { label: "Upcoming", color: "#1D4ED8", backgroundColor: "#DBEAFE" },
  ended: { label: "Ended", color: "#64748B", backgroundColor: "#E2E8F0" },
};

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function scheduleState(schedule: ScheduleAssignment, today: number): ScheduleState {
  if (new Date(schedule.startsOn).getTime() > today + 86_399_999) return "upcoming";
  if (schedule.endsOn && new Date(schedule.endsOn).getTime() < today) return "ended";
  return "current";
}

function formatDate(value?: string | null) {
  return value
    ? new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "Present";
}

// Shift times are stored as 24-hour "HH:mm"; shown the way every other
// time in the app reads.
function formatShiftTime(value: string) {
  const match = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!match) return value;
  const hour = Number(match[1]);
  return `${hour % 12 === 0 ? 12 : hour % 12}:${match[2]} ${hour < 12 ? "AM" : "PM"}`;
}

export default function SupervisorSchedulesScreen({ onClose }: Props) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");

  const { data, isLoading, refresh } = useCachedData<ScheduleAssignment[]>("team-schedules", getSchedules);

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

  // Current assignments first, then upcoming, then ended; alphabetical
  // within each, so the same person is always in the same place.
  const schedules = useMemo(() => {
    const today = startOfToday();
    const order: Record<ScheduleState, number> = { current: 0, upcoming: 1, ended: 2 };
    return (data ?? [])
      .map((schedule) => ({ schedule, state: scheduleState(schedule, today) }))
      .sort((a, b) => {
        if (order[a.state] !== order[b.state]) return order[a.state] - order[b.state];
        return `${a.schedule.employee.firstName} ${a.schedule.employee.lastName}`.localeCompare(
          `${b.schedule.employee.firstName} ${b.schedule.employee.lastName}`,
        );
      });
  }, [data]);

  const counts = useMemo(
    () => ({
      all: schedules.length,
      current: schedules.filter((entry) => entry.state === "current").length,
      upcoming: schedules.filter((entry) => entry.state === "upcoming").length,
      ended: schedules.filter((entry) => entry.state === "ended").length,
    }),
    [schedules],
  );

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return schedules.filter(({ schedule, state }) => {
      if (stateFilter !== "all" && state !== stateFilter) return false;
      if (!query) return true;
      const name = `${schedule.employee.firstName} ${schedule.employee.lastName}`.toLowerCase();
      return name.includes(query) || schedule.shift.name.toLowerCase().includes(query);
    });
  }, [schedules, search, stateFilter]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.headerRow}>
        <Pressable onPress={onClose} style={styles.backButton} hitSlop={10}>
          <Ionicons name="chevron-back" size={24} color="#062B59" />
        </Pressable>
        <Text style={styles.headerTitle}>Schedules</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={ui.card}>
        <View style={ui.pinnedHeader}>
          <View style={styles.titleRow}>
            <View style={{ flex: 1 }}>
              <Text style={ui.cardTitle}>Team Schedules</Text>
              <Text style={ui.cardSubtitle} numberOfLines={1}>
                {counts.current} on shift now · {counts.all} assignment{counts.all === 1 ? "" : "s"}
              </Text>
            </View>
          </View>

          {/* All first, like every other filter in the app. */}
          <SegmentedControl
            segments={[
              { key: "all", label: `All · ${counts.all}` },
              { key: "current", label: `Current · ${counts.current}` },
              { key: "upcoming", label: `Upcoming · ${counts.upcoming}` },
              { key: "ended", label: `Ended · ${counts.ended}` },
            ]}
            value={stateFilter}
            onChange={(key) => setStateFilter(key as StateFilter)}
            style={ui.tabSwitcher}
            dense
          />

          <View style={ui.filterRow}>
            <View style={styles.searchBox}>
              <Ionicons name="search-outline" size={16} color="#94A3B8" />
              <TextInput
                style={styles.searchInput}
                placeholder="Search employee or shift..."
                placeholderTextColor="#94A3B8"
                value={search}
                onChangeText={setSearch}
              />
            </View>
            {!!search && (
              <Pressable style={ui.iconButton} onPress={() => setSearch("")}>
                <Ionicons name="close" size={16} color="#94A3B8" />
              </Pressable>
            )}
          </View>
        </View>

        {isLoading ? (
          <View style={styles.centered}>
            <ActivityIndicator color="#062B59" size="large" />
          </View>
        ) : (
          <AestheticScrollView
            style={ui.list}
            contentContainerStyle={ui.listContent}
            refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={() => load(true)} colors={["#1680D8"]} />}
          >
            {filtered.length === 0 ? (
              <View style={ui.emptyState}>
                <Ionicons name="time-outline" size={36} color="#CBD5E1" />
                <Text style={ui.emptyText}>
                  {schedules.length === 0
                    ? "Shift assignments for your department will appear here."
                    : search
                      ? "No schedules match your search."
                      : `No ${stateFilter} schedules.`}
                </Text>
              </View>
            ) : (
              filtered.map(({ schedule, state }, index) => {
                const tone = STATE_TONES[state];
                return (
                  <View key={schedule.id} style={[styles.row, index > 0 && styles.rowDivider]}>
                    <Avatar firstName={schedule.employee.firstName} lastName={schedule.employee.lastName} size={40} />
                    <View style={styles.rowBody}>
                      <View style={styles.rowTop}>
                        <Text style={[styles.employeeName, state === "ended" && styles.employeeNameEnded]} numberOfLines={1}>
                          {schedule.employee.firstName} {schedule.employee.lastName}
                        </Text>
                        <Text style={[styles.statePill, { color: tone.color, backgroundColor: tone.backgroundColor }]}>
                          {tone.label}
                        </Text>
                      </View>
                      {!!schedule.employee.position?.title && (
                        <Text style={styles.position} numberOfLines={1}>
                          {schedule.employee.position.title}
                        </Text>
                      )}
                      <View style={styles.shiftLine}>
                        <Ionicons name="time-outline" size={13} color="#062B59" />
                        <Text style={styles.shiftName} numberOfLines={1}>
                          {schedule.shift.name}
                        </Text>
                        <Text style={styles.shiftTime} numberOfLines={1}>
                          {formatShiftTime(schedule.shift.startTime)} – {formatShiftTime(schedule.shift.endTime)}
                        </Text>
                      </View>
                      <View style={styles.dateLine}>
                        <Ionicons name="calendar-outline" size={12} color="#94A3B8" />
                        <Text style={styles.dateText} numberOfLines={1}>
                          {formatDate(schedule.startsOn)} – {formatDate(schedule.endsOn)}
                        </Text>
                      </View>
                    </View>
                  </View>
                );
              })
            )}
          </AestheticScrollView>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 40 },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 14 },
  backButton: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: "#F1F5F9" },
  headerSpacer: { width: 36 },
  headerTitle: { fontSize: 16, fontWeight: "800", color: "#062B59" },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 14 },
  searchBox: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 48,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    backgroundColor: "#FFFFFF",
  },
  searchInput: { flex: 1, fontSize: 14, fontWeight: "600", color: "#0F172A" },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingVertical: 14 },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#E2E8F0" },
  rowBody: { flex: 1, minWidth: 0 },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  employeeName: { flex: 1, fontSize: 14.5, fontWeight: "800", color: "#062B59" },
  employeeNameEnded: { color: "#64748B" },
  statePill: {
    fontSize: 10,
    fontWeight: "800",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    overflow: "hidden",
  },
  position: { fontSize: 11.5, fontWeight: "600", color: "#94A3B8", marginTop: 1 },
  shiftLine: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 8 },
  shiftName: { fontSize: 12.5, fontWeight: "800", color: "#062B59", flexShrink: 1 },
  shiftTime: { fontSize: 12.5, fontWeight: "600", color: "#475569" },
  dateLine: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 4 },
  dateText: { fontSize: 11.5, fontWeight: "600", color: "#94A3B8" },
});
