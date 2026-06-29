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

export default function DTRScreen({ employeeId }: Props) {
  const [records, setRecords] = useState<AttendanceHistoryRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<AttendanceHistoryRecord | null>(null);
  const [photoTab, setPhotoTab] = useState<"TIME_IN" | "TIME_OUT">("TIME_IN");

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
    <>
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
                {hasPhotos && <Ionicons name="camera" size={13} color="#94A3B8" />}
              </View>
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
          </Text>

          <View style={styles.photoTabSwitcher}>
            <Pressable
              style={[styles.photoTabButton, photoTab === "TIME_IN" && styles.photoTabButtonActive]}
              onPress={() => setPhotoTab("TIME_IN")}
            >
              <Text style={[styles.photoTabText, photoTab === "TIME_IN" && styles.photoTabTextActive]}>Time In</Text>
            </Pressable>
            <Pressable
              style={[styles.photoTabButton, photoTab === "TIME_OUT" && styles.photoTabButtonActive]}
              onPress={() => setPhotoTab("TIME_OUT")}
            >
              <Text style={[styles.photoTabText, photoTab === "TIME_OUT" && styles.photoTabTextActive]}>Time Out</Text>
            </Pressable>
          </View>

          {(() => {
            const log = selectedRecord?.logs.find((l) => l.logType === photoTab);
            const uri = log ? photoUri(log) : null;
            return (
              <View style={styles.modalPhotoBlock}>
                {log && (
                  <View style={styles.modalPhotoLabelRow}>
                    <Text style={styles.modalPhotoLabel}>{photoTab === "TIME_IN" ? "Time In" : "Time Out"}</Text>
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
