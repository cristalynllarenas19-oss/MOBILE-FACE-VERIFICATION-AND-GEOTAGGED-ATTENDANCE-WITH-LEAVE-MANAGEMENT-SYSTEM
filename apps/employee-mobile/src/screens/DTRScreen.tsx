import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
  Modal,
  Image,
  Pressable,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { AttendanceHistoryRecord, AttendanceLogPhoto, getAttendanceHistory } from "../api";

type Props = {
  employeeId?: string;
};

type Tab = "office" | "field";

function isMorning(value: string | null) {
  if (!value) return true;
  return new Date(value).getHours() < 12;
}

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

function photoUri(log: AttendanceLogPhoto) {
  if (!log.faceImageData) return null;
  return `data:${log.faceImageMimeType ?? "image/jpeg"};base64,${log.faceImageData}`;
}

function formatLogTime(value: string) {
  return new Date(value).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function statusTone(status: string) {
  if (status === "PRESENT") return { color: "#17A34A", bg: "#ECFDF3", icon: "checkmark-circle" as const };
  if (status === "LATE") return { color: "#D97706", bg: "#FFFBEB", icon: "alert-circle" as const };
  if (status === "ON_LEAVE") return { color: "#1680D8", bg: "#EFF6FF", icon: "calendar" as const };
  if (status === "OFFICIAL_BUSINESS") return { color: "#7C3AED", bg: "#F5F3FF", icon: "briefcase" as const };
  if (status === "ABSENT") return { color: "#DC2626", bg: "#FEF2F2", icon: "close-circle" as const };
  return { color: "#94A3B8", bg: "#F8FAFC", icon: "time" as const };
}

function latestOf(records: AttendanceHistoryRecord[]) {
  const todayKey = new Date().toDateString();
  const todays = records.filter((r) => new Date(r.attendanceDate).toDateString() === todayKey);
  if (!todays.length) return null;
  return todays.reduce((latest, record) => ((record.visitNumber ?? 1) > (latest.visitNumber ?? 1) ? record : latest));
}

// DTR for every employee — one screen, two tabs (mirroring the Leave
// screen's Balance/Request tabs): Office (Time In/Time Out) and Field
// (Start/End Visit). Every employee sees both tabs regardless of which
// attendance mode they're assigned — a Fixed employee's Field tab (or a
// Field employee's Office tab) is simply empty, rather than being a
// different screen per mode.
export default function DTRScreen({ employeeId }: Props) {
  const [records, setRecords] = useState<AttendanceHistoryRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("office");
  const [selectedRecord, setSelectedRecord] = useState<AttendanceHistoryRecord | null>(null);
  const [photoTab, setPhotoTab] = useState<"TIME_IN" | "TIME_OUT">("TIME_IN");
  const [amPmFilter, setAmPmFilter] = useState<"ALL" | "AM" | "PM">("ALL");

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

  const officeRecords = useMemo(() => records.filter((r) => r.recordType !== "FIELD"), [records]);
  const fieldRecords = useMemo(() => records.filter((r) => r.recordType === "FIELD"), [records]);

  const filteredFieldRecords = useMemo(() => {
    if (amPmFilter === "ALL") return fieldRecords;
    return fieldRecords.filter((record) => isMorning(record.timeInAt) === (amPmFilter === "AM"));
  }, [fieldRecords, amPmFilter]);

  const todayOfficeRecord = useMemo(() => latestOf(officeRecords), [officeRecords]);
  const todayFieldRecord = useMemo(() => latestOf(fieldRecords), [fieldRecords]);

  const isOfficeTab = activeTab === "office";
  const todayRecord = isOfficeTab ? todayOfficeRecord : todayFieldRecord;
  const todayInProgress = Boolean(todayRecord?.timeInAt) && !todayRecord?.timeOutAt;
  const listData = isOfficeTab ? officeRecords : filteredFieldRecords;

  return (
    <>
    <FlatList
      data={listData}
      keyExtractor={(item) => item.id}
      refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} colors={["#1680D8"]} />}
      ListHeaderComponent={
        <>
          <Text style={styles.cardTitle}>Daily Time Record</Text>

          <View style={styles.tabSwitcher}>
            <Pressable
              style={[styles.tabButton, isOfficeTab && styles.tabButtonActive]}
              onPress={() => setActiveTab("office")}
            >
              <Text style={[styles.tabButtonText, isOfficeTab && styles.tabButtonTextActive]}>Office</Text>
            </Pressable>
            <Pressable
              style={[styles.tabButton, !isOfficeTab && styles.tabButtonActive]}
              onPress={() => setActiveTab("field")}
            >
              <Text style={[styles.tabButtonText, !isOfficeTab && styles.tabButtonTextActive]}>Field</Text>
            </Pressable>
          </View>

          <View style={styles.summaryCard}>
            <Ionicons name="time" size={22} color="#1680D8" />
            <View style={{ flex: 1 }}>
              <Text style={styles.summaryLabel}>
                {isOfficeTab ? "Today's Hours Rendered" : "Today's Hours Rendered (Latest Visit)"}
              </Text>
              <Text style={styles.summaryValue}>
                {todayRecord
                  ? formatHoursRendered(todayRecord.totalMinutes) ?? (todayInProgress ? "In progress" : "--")
                  : isOfficeTab
                    ? "Not yet timed in"
                    : "No visit started"}
              </Text>
            </View>
          </View>

          {!isOfficeTab && (
            <View style={styles.filterRow}>
              {(["ALL", "AM", "PM"] as const).map((option) => {
                const isActive = amPmFilter === option;
                return (
                  <Pressable
                    key={option}
                    style={[styles.filterChip, isActive && styles.filterChipActive]}
                    onPress={() => setAmPmFilter(option)}
                  >
                    <Text style={[styles.filterChipText, isActive && styles.filterChipTextActive]}>{option}</Text>
                  </Pressable>
                );
              })}
            </View>
          )}
        </>
      }
      ListEmptyComponent={
        !isLoading ? (
          <View style={styles.emptyState}>
            <Ionicons name="document-text-outline" size={36} color="#CBD5E1" />
            <Text style={styles.emptyText}>
              {isOfficeTab ? "No office attendance records yet." : "No visit records yet."}
            </Text>
          </View>
        ) : null
      }
      contentContainerStyle={styles.listContainer}
      renderItem={({ item }) => {
        const tone = statusTone(item.status);
        const hoursRendered = formatHoursRendered(item.totalMinutes);
        const inProgress = Boolean(item.timeInAt) && !item.timeOutAt;
        const hasPhotos = item.logs?.some((log) => log.faceImageData);

        return (
          <Pressable
            style={styles.row}
            onPress={() => {
              setSelectedRecord(item);
              setPhotoTab("TIME_IN");
            }}
          >
            <View style={styles.rowTop}>
              <View style={styles.dateRow}>
                <Text style={styles.dateText}>{formatDate(item.attendanceDate)}</Text>
                {!isOfficeTab && item.workLocation?.name && (
                  <Text style={styles.siteNameText}>· {item.workLocation.name}</Text>
                )}
                {hasPhotos && <Ionicons name="camera" size={13} color="#94A3B8" />}
              </View>
              <View style={[styles.statusBadge, { backgroundColor: tone.bg }]}>
                <Ionicons name={tone.icon} size={12} color={tone.color} />
                <Text style={[styles.statusBadgeText, { color: tone.color }]}>{item.status.replace("_", " ")}</Text>
              </View>
            </View>

            <View style={styles.rowBody}>
              <View style={styles.timeBlock}>
                <Text style={styles.timeLabel}>{isOfficeTab ? "Time In" : "Visit Start"}</Text>
                <Text style={styles.timeValue}>{formatTime(item.timeInAt)}</Text>
              </View>
              <Ionicons name="arrow-forward" size={14} color="#CBD5E1" />
              <View style={styles.timeBlock}>
                <Text style={styles.timeLabel}>{isOfficeTab ? "Time Out" : "Visit End"}</Text>
                <Text style={styles.timeValue}>{formatTime(item.timeOutAt)}</Text>
              </View>

              <View style={styles.hoursBlock}>
                <Text style={styles.timeLabel}>Hours Rendered</Text>
                <Text style={[styles.hoursValue, !hoursRendered && styles.hoursValueMuted]}>
                  {hoursRendered ?? (inProgress ? "In progress" : "--")}
                </Text>
              </View>
            </View>
          </Pressable>
        );
      }}
    />

    <Modal
      visible={!!selectedRecord}
      transparent
      animationType="fade"
      onRequestClose={() => setSelectedRecord(null)}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>
            {selectedRecord ? formatDate(selectedRecord.attendanceDate) : ""}
            {!isOfficeTab && selectedRecord?.workLocation?.name ? ` · ${selectedRecord.workLocation.name}` : ""}
          </Text>

          <View style={styles.photoTabSwitcher}>
            <Pressable
              style={[styles.photoTabButton, photoTab === "TIME_IN" && styles.photoTabButtonActive]}
              onPress={() => setPhotoTab("TIME_IN")}
            >
              <Text style={[styles.photoTabText, photoTab === "TIME_IN" && styles.photoTabTextActive]}>
                {isOfficeTab ? "Time In" : "Visit Start"}
              </Text>
            </Pressable>
            <Pressable
              style={[styles.photoTabButton, photoTab === "TIME_OUT" && styles.photoTabButtonActive]}
              onPress={() => setPhotoTab("TIME_OUT")}
            >
              <Text style={[styles.photoTabText, photoTab === "TIME_OUT" && styles.photoTabTextActive]}>
                {isOfficeTab ? "Time Out" : "Visit End"}
              </Text>
            </Pressable>
          </View>

          {(() => {
            const log = selectedRecord?.logs.find((l) => l.logType === photoTab);
            const uri = log ? photoUri(log) : null;
            return (
              <View style={styles.modalPhotoBlock}>
                {log && (
                  <View style={styles.modalPhotoLabelRow}>
                    <Text style={styles.modalPhotoLabel}>
                      {isOfficeTab
                        ? photoTab === "TIME_IN" ? "Time In" : "Time Out"
                        : photoTab === "TIME_IN" ? "Visit Start" : "Visit End"}
                    </Text>
                    <Text style={styles.modalPhotoTime}>{formatLogTime(log.capturedAt)}</Text>
                  </View>
                )}
                {uri ? (
                  <Image source={{ uri }} style={styles.modalPhoto} resizeMode="contain" />
                ) : (
                  <View style={[styles.modalPhoto, styles.modalPhotoPlaceholder]}>
                    <Ionicons name="image-outline" size={28} color="#CBD5E1" />
                    <Text style={styles.modalEmptyText}>No photo captured</Text>
                  </View>
                )}
              </View>
            );
          })()}

          <Pressable style={styles.modalCloseButton} onPress={() => setSelectedRecord(null)}>
            <Text style={styles.modalCloseText}>Close</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
    </>
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
  tabSwitcher: {
    flexDirection: "row",
    backgroundColor: "#F1F5F9",
    borderRadius: 14,
    padding: 4,
    marginBottom: 14,
  },
  tabButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 11,
    alignItems: "center",
  },
  tabButtonActive: {
    backgroundColor: "#062B59",
  },
  tabButtonText: {
    fontSize: 14,
    fontWeight: "700",
    color: "#64748B",
  },
  tabButtonTextActive: {
    color: "#FFFFFF",
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
  filterRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 14,
  },
  filterChip: {
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: "#F1F5F9",
  },
  filterChipActive: {
    backgroundColor: "#062B59",
  },
  filterChipText: {
    color: "#64748B",
    fontSize: 12,
    fontWeight: "700",
  },
  filterChipTextActive: {
    color: "#FFFFFF",
  },
  siteNameText: {
    color: "#64748B",
    fontSize: 12,
    fontWeight: "600",
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
  dateRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
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
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(6, 43, 89, 0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: 12,
  },
  modalCard: {
    width: "100%",
    maxWidth: 480,
    maxHeight: "92%",
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 16,
  },
  modalTitle: {
    color: "#062B59",
    fontSize: 16,
    fontWeight: "800",
    marginBottom: 14,
    textAlign: "center",
  },
  modalEmptyText: {
    color: "#94A3B8",
    fontSize: 13,
    fontWeight: "600",
    textAlign: "center",
    marginBottom: 8,
  },
  photoTabSwitcher: {
    flexDirection: "row",
    backgroundColor: "#F1F5F9",
    borderRadius: 12,
    padding: 4,
    marginBottom: 14,
  },
  photoTabButton: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 9,
    alignItems: "center",
  },
  photoTabButtonActive: {
    backgroundColor: "#062B59",
  },
  photoTabText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#64748B",
  },
  photoTabTextActive: {
    color: "#FFFFFF",
  },
  modalPhotoBlock: {
    gap: 8,
    marginBottom: 14,
  },
  modalPhotoLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  modalPhotoLabel: {
    color: "#1E3A8A",
    fontSize: 13,
    fontWeight: "700",
  },
  modalPhotoTime: {
    color: "#94A3B8",
    fontSize: 12,
    fontWeight: "600",
  },
  // Full width, ratio-matched to the saved composite (no fixed square crop)
  // so the GPS stamp baked into the bottom of the photo is never cut off.
  modalPhoto: {
    width: "100%",
    aspectRatio: 3 / 4,
    borderRadius: 14,
    backgroundColor: "#F1F5F9",
  },
  modalPhotoPlaceholder: {
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  modalCloseButton: {
    height: 46,
    borderRadius: 12,
    backgroundColor: "#1680D8",
    alignItems: "center",
    justifyContent: "center",
  },
  modalCloseText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
  },
});
