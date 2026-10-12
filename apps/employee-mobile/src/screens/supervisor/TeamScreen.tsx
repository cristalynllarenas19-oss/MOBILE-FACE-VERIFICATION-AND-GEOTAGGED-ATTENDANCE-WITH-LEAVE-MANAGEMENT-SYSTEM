import React, { useCallback, useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Modal,
  SafeAreaView,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Avatar from "../../components/Avatar";
import AestheticScrollView from "../../components/AestheticScrollView";
import {
  TeamEmployee,
  PositionOption,
  getPositions,
  getTeamEmployees,
} from "../../api";
import { useCachedData } from "../../utils/dataCache";
import { ui } from "../../styles/ui";

type Props = {
  departmentName?: string;
  currentEmployeeId?: string;
};

// Read-only by design: adding, editing and archiving an employee record is
// HR/Admin work, gated on employees:write, which the Supervisor role does
// not have (see backend/prisma/seed.ts). Every endpoint behind those
// actions rejects a Supervisor, and admin-web hides the same three controls
// from them, so this roster shows information only.

function getEmployeeTypeLabel(employee: TeamEmployee) {
  return employee.employeeType?.name ?? "—";
}

function getName(employee: TeamEmployee) {
  return `${employee.firstName} ${employee.lastName}`;
}

export default function TeamScreen({ departmentName, currentEmployeeId }: Props) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [positionFilter, setPositionFilter] = useState("ALL");
  const [isPositionPickerOpen, setIsPositionPickerOpen] = useState(false);

  const { data: roster, isLoading, refresh } = useCachedData<TeamEmployee[]>("team-employees", getTeamEmployees);

  // Every active position from admin-web's Utilities -> Positions — never
  // a list kept in this app or inferred from whoever happens to hold a
  // position (the same rule EmployeesPage.tsx's Position filter follows).
  const { data: positions } = useCachedData<PositionOption[]>("positions", getPositions);
  const positionFilterOptions = useMemo(
    () => (positions ?? []).filter((position) => position.isActive),
    [positions],
  );
  // A position that was archived while it was the active filter falls back
  // to "All Positions" rather than silently hiding the whole roster.
  const activePositionFilter = positionFilterOptions.some((position) => position.id === positionFilter)
    ? positionFilter
    : "ALL";
  const activePositionTitle = positionFilterOptions.find((position) => position.id === activePositionFilter)?.title;

  // The roster endpoint returns every employee in the department,
  // including the supervisor's own linked employee record — they
  // manage their team, not themselves, so exclude it here.
  const employees = useMemo(
    () => (roster ?? []).filter((e) => e.id !== currentEmployeeId),
    [roster, currentEmployeeId],
  );

  const load = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setIsRefreshing(true);
      try {
        await refresh();
      } catch (error) {
        console.error("Failed to load team", error);
      } finally {
        setIsRefreshing(false);
      }
    },
    [refresh],
  );

  const filtered = useMemo(
    () =>
      employees.filter((e) => {
        if (activePositionFilter !== "ALL" && e.positionId !== activePositionFilter) return false;
        return getName(e).toLowerCase().includes(search.toLowerCase());
      }),
    [employees, search, activePositionFilter],
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={ui.card}>
        <View style={ui.pinnedHeader}>
          <View style={styles.titleRow}>
            <View style={{ flex: 1 }}>
              <Text style={ui.cardTitle}>My Team</Text>
              <Text style={ui.cardSubtitle} numberOfLines={1}>
                {departmentName ?? "Department roster"}
                {` · ${filtered.length} employee${filtered.length === 1 ? "" : "s"}`}
              </Text>
            </View>
          </View>

          <View style={ui.filterRow}>
            <View style={styles.searchBox}>
              <Ionicons name="search-outline" size={16} color="#94A3B8" />
              <TextInput
                style={styles.searchInput}
                placeholder="Search employees..."
                placeholderTextColor="#94A3B8"
                value={search}
                onChangeText={setSearch}
              />
            </View>
          </View>

          {/* Position filter: "All Positions" is the first row in the
              picker, so the unfiltered roster stays one tap away. */}
          <View style={ui.filterRow}>
            <Pressable style={ui.inputBox} onPress={() => setIsPositionPickerOpen(true)}>
              <Text
                style={[ui.inputBoxText, activePositionFilter !== "ALL" && ui.inputBoxTextFilled]}
                numberOfLines={1}
              >
                {activePositionFilter === "ALL" ? "All Positions" : activePositionTitle}
              </Text>
              <Ionicons name="chevron-down" size={16} color="#64748B" />
            </Pressable>
            {activePositionFilter !== "ALL" && (
              <Pressable style={ui.iconButton} onPress={() => setPositionFilter("ALL")}>
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
                <Ionicons name="people-outline" size={36} color="#CBD5E1" />
                <Text style={ui.emptyText}>
                  {search
                    ? "No employees match your search."
                    : activePositionFilter !== "ALL"
                      ? `No one on your team holds the ${activePositionTitle} position.`
                      : "No employees in your department yet."}
                </Text>
              </View>
            ) : (
              <View style={styles.rowList}>
                {filtered.map((employee) => (
                    <View key={employee.id} style={[ui.innerCard, styles.row]}>
                      <Avatar firstName={employee.firstName} lastName={employee.lastName} />
                      <View style={styles.rowBody}>
                        {/* Name owns its line — it used to share one with the
                            employment-type chip, which squeezed longer names
                            down to an ellipsis. */}
                        <Text style={styles.rowName} numberOfLines={1}>
                          {getName(employee)}
                        </Text>
                        <Text style={styles.rowMeta} numberOfLines={1}>
                          {employee.position?.title ?? "—"} · {employee.employeeNo}
                        </Text>
                        <View style={styles.rowTagRow}>
                          <Text
                            style={[styles.typeChip, employee.employmentStatus !== "REGULAR" && styles.typeChipMuted]}
                            numberOfLines={1}
                          >
                            {getEmployeeTypeLabel(employee)}
                          </Text>
                        </View>
                      </View>
                    </View>
                ))}
              </View>
            )}
          </AestheticScrollView>
        )}
      </View>

      <Modal
        visible={isPositionPickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setIsPositionPickerOpen(false)}
      >
        <View style={ui.modalOverlay}>
          <View style={ui.modalCard}>
            <Text style={ui.modalTitle}>Filter by Position</Text>
            <AestheticScrollView style={{ maxHeight: 360 }}>
              {[{ id: "ALL", title: "All Positions" }, ...positionFilterOptions].map((option) => {
                const isActive = activePositionFilter === option.id;
                return (
                  <Pressable
                    key={option.id}
                    style={({ pressed }) => [styles.pickerRow, pressed && styles.pickerRowPressed]}
                    onPress={() => {
                      setPositionFilter(option.id);
                      setIsPositionPickerOpen(false);
                    }}
                  >
                    <Text style={[styles.pickerRowText, isActive && styles.pickerRowTextActive]} numberOfLines={1}>
                      {option.title}
                    </Text>
                    {isActive && <Ionicons name="checkmark" size={18} color="#062B59" />}
                  </Pressable>
                );
              })}
            </AestheticScrollView>
            <Pressable style={styles.pickerClose} onPress={() => setIsPositionPickerOpen(false)}>
              <Text style={styles.pickerCloseText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 40 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 14 },
  searchBox: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 48,
    borderRadius: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    backgroundColor: "#FFFFFF",
  },
  searchInput: { flex: 1, fontSize: 14, fontWeight: "600", color: "#0F172A" },
  rowList: { gap: 10 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  rowBody: { flex: 1, minWidth: 0 },
  rowName: { fontSize: 14.5, fontWeight: "800", color: "#062B59" },
  rowMeta: { fontSize: 12, color: "#64748B", fontWeight: "600", marginTop: 2 },
  rowTagRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: 8 },
  typeChip: {
    fontSize: 10,
    fontWeight: "800",
    color: "#15803D",
    backgroundColor: "#DCFCE7",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    overflow: "hidden",
  },
  typeChipMuted: { color: "#64748B", backgroundColor: "#E2E8F0" },
  pickerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#E2E8F0",
  },
  pickerRowPressed: { opacity: 0.6 },
  pickerRowText: { flex: 1, fontSize: 13.5, color: "#334155", fontWeight: "600" },
  pickerRowTextActive: { color: "#062B59", fontWeight: "800" },
  pickerClose: { alignSelf: "center", marginTop: 14, paddingHorizontal: 18, paddingVertical: 8 },
  pickerCloseText: { fontSize: 13, fontWeight: "700", color: "#64748B" },
});
