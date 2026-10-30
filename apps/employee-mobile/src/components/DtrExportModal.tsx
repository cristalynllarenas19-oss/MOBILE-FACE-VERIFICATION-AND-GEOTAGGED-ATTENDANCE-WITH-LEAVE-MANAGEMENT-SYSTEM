import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { MonthlyDtr, getMyMonthlyDtr } from "../api";
import {
  MONTH_NAMES,
  SavedDtr,
  downloadDtrPdf,
  dtrHoursLabel,
  dtrRemarks,
  dtrStatusLabel,
  dtrTotalHoursLabel,
  formatDtrTime,
  printDtr,
  shareDtrPdf,
} from "../utils/dtrExport";

type Props = {
  visible: boolean;
  onClose: () => void;
};

type Notice = { tone: "success" | "error"; title: string; message: string; retry?: () => void };

// Same tones DTRScreen's statusTone() uses for its row dots.
function statusColor(status: string) {
  if (status === "PRESENT") return "#17A34A";
  if (status === "LATE") return "#CA8A04";
  if (status === "ON_LEAVE") return "#1680D8";
  if (status === "ABSENT") return "#DC2626";
  if (status === "LEAVE_PENDING") return "#B45309";
  return "#94A3B8";
}

// "1 Late · 24 Absent" — only the statuses that actually occur.
function statusSummary(dtr: MonthlyDtr) {
  const counts = new Map<string, number>();
  for (const row of dtr.rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  return [...counts].map(([status, count]) => `${count} ${dtrStatusLabel(status)}`).join(" · ");
}

// Backing out of the print dialog / share sheet rejects too — not a failure.
function isCancel(error: unknown) {
  return /cancel|did not complete|dismiss/i.test(error instanceof Error ? error.message : "");
}

// My DTR — pick a month and year, check the records, then save them as a
// PDF or print them. Opened from the DTR tab's "Download / Print" button.
export default function DtrExportModal({ visible, onClose }: Props) {
  const now = new Date();
  // The app draws edge-to-edge, so this full-screen modal sits under the
  // status and navigation bars unless padded by their real size.
  const insets = useSafeAreaInsets();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [dtr, setDtr] = useState<MonthlyDtr | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"download" | "print" | "share" | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [saved, setSaved] = useState<SavedDtr | null>(null);
  // Ignores a slow response for a month the employee has already moved off.
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setIsLoading(true);
    setLoadError(null);
    setDtr(null);
    try {
      const result = await getMyMonthlyDtr(year, month);
      if (id === requestId.current) setDtr(result);
    } catch (error) {
      if (id === requestId.current) {
        setLoadError(error instanceof Error && error.message ? error.message : "Couldn't load your DTR.");
      }
    } finally {
      if (id === requestId.current) setIsLoading(false);
    }
  }, [year, month]);

  useEffect(() => {
    if (!visible) return;
    setNotice(null);
    setSaved(null);
    load();
  }, [visible, load]);

  const isFutureMonth = (y: number, m: number) =>
    y > now.getFullYear() || (y === now.getFullYear() && m > now.getMonth() + 1);

  function changeYear(next: number) {
    setYear(next);
    if (isFutureMonth(next, month)) setMonth(now.getMonth() + 1);
  }

  async function handleDownload() {
    if (!dtr) return;
    setBusy("download");
    setNotice(null);
    try {
      const result = await downloadDtrPdf(dtr);
      setSaved(result);
      setNotice({
        tone: "success",
        title: "DTR Downloaded",
        message: result.savedTo
          ? `Saved to ${result.savedTo} as ${result.fileName}.`
          : `${result.fileName} is ready.`,
      });
    } catch (error) {
      if (!isCancel(error)) {
        setNotice({
          tone: "error",
          title: "Download Failed",
          message: error instanceof Error && error.message ? error.message : "The PDF could not be saved.",
          retry: handleDownload,
        });
      }
    } finally {
      setBusy(null);
    }
  }

  async function handlePrint() {
    if (!dtr) return;
    setBusy("print");
    setNotice(null);
    try {
      await printDtr(dtr);
    } catch (error) {
      if (!isCancel(error)) {
        setNotice({
          tone: "error",
          title: "Print Unavailable",
          message: "Printing couldn't start on this device. Download the PDF instead and print it from another app.",
          retry: handlePrint,
        });
      }
    } finally {
      setBusy(null);
    }
  }

  async function handleShare() {
    if (!saved) return;
    setBusy("share");
    try {
      await shareDtrPdf(saved.cacheUri, saved.fileName);
    } catch (error) {
      if (!isCancel(error)) {
        setNotice({
          tone: "error",
          title: "Couldn't Open PDF",
          message: error instanceof Error && error.message ? error.message : "Please try again.",
          retry: handleShare,
        });
      }
    } finally {
      setBusy(null);
    }
  }

  const canExport = Boolean(dtr) && !isLoading && busy === null;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.headerRow}>
          <Pressable onPress={onClose} style={styles.backButton} hitSlop={10}>
            <Ionicons name="chevron-back" size={22} color="#062B59" />
          </Pressable>
          <Text style={styles.headerTitle}>My DTR</Text>
          <View style={styles.headerSpacer} />
        </View>

        {/* Picker and actions stay put; only the records below scroll. */}
        <View style={[styles.card, styles.pickerCard]}>
          <View style={styles.yearRow}>
            <Text style={styles.sectionLabel}>Select Month & Year</Text>
            <View style={styles.yearStepper}>
              <Pressable style={styles.yearButton} onPress={() => changeYear(year - 1)} hitSlop={8}>
                <Ionicons name="chevron-back" size={16} color="#062B59" />
              </Pressable>
              <Text style={styles.yearText}>{year}</Text>
              <Pressable
                style={[styles.yearButton, year >= now.getFullYear() && styles.disabled]}
                disabled={year >= now.getFullYear()}
                onPress={() => changeYear(year + 1)}
                hitSlop={8}
              >
                <Ionicons name="chevron-forward" size={16} color="#062B59" />
              </Pressable>
            </View>
          </View>

          <View style={styles.monthGrid}>
            {MONTH_NAMES.map((name, index) => {
              const value = index + 1;
              const isActive = value === month;
              const isDisabled = isFutureMonth(year, value);
              return (
                <Pressable
                  key={name}
                  style={[styles.monthChip, isActive && styles.monthChipActive, isDisabled && styles.monthChipDisabled]}
                  disabled={isDisabled}
                  onPress={() => setMonth(value)}
                >
                  <Text
                    style={[
                      styles.monthChipText,
                      isActive && styles.monthChipTextActive,
                      isDisabled && styles.monthChipTextDisabled,
                    ]}
                  >
                    {name.slice(0, 3)}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.actionRow}>
            <Pressable
              style={[styles.primaryButton, !canExport && styles.disabled]}
              disabled={!canExport}
              onPress={handleDownload}
            >
              {busy === "download" ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <Ionicons name="download-outline" size={17} color="#FFFFFF" />
              )}
              <Text style={styles.primaryButtonText}>Download PDF</Text>
            </Pressable>
            <Pressable
              style={[styles.secondaryButton, !canExport && styles.disabled]}
              disabled={!canExport}
              onPress={handlePrint}
            >
              {busy === "print" ? (
                <ActivityIndicator color="#062B59" size="small" />
              ) : (
                <Ionicons name="print-outline" size={17} color="#062B59" />
              )}
              <Text style={styles.secondaryButtonText}>Print DTR</Text>
            </Pressable>
          </View>

          {notice && (
            <View style={[styles.notice, notice.tone === "error" ? styles.noticeError : styles.noticeSuccess]}>
              <Ionicons
                name={notice.tone === "error" ? "warning" : "checkmark-circle"}
                size={18}
                color={notice.tone === "error" ? "#DC2626" : "#17A34A"}
              />
              <View style={styles.noticeBody}>
                <Text style={styles.noticeTitle}>{notice.title}</Text>
                <Text style={styles.noticeText}>{notice.message}</Text>
                <View style={styles.noticeActions}>
                  {notice.tone === "success" && saved && (
                    <Pressable style={styles.noticeAction} onPress={handleShare} disabled={busy !== null}>
                      <Ionicons name="open-outline" size={14} color="#1680D8" />
                      <Text style={styles.noticeActionText}>Open / Share PDF</Text>
                    </Pressable>
                  )}
                  {notice.retry && (
                    <Pressable style={styles.noticeAction} onPress={notice.retry} disabled={busy !== null}>
                      <Ionicons name="refresh" size={14} color="#1680D8" />
                      <Text style={styles.noticeActionText}>Try Again</Text>
                    </Pressable>
                  )}
                </View>
              </View>
              <Pressable onPress={() => setNotice(null)} hitSlop={8}>
                <Ionicons name="close" size={16} color="#94A3B8" />
              </Pressable>
            </View>
          )}
        </View>

        <View style={[styles.card, styles.listCard]}>
          <View style={styles.previewHeader}>
            <View style={styles.previewTitleGroup}>
              <Text style={styles.previewTitle}>
                {MONTH_NAMES[month - 1]} {year}
              </Text>
              {!!dtr?.rows.length && (
                <Text style={styles.previewSummary} numberOfLines={1}>
                  {statusSummary(dtr)}
                </Text>
              )}
            </View>
            {dtr && (
              <View style={styles.totalBlock}>
                <Text style={styles.totalLabel}>Total Hours</Text>
                <Text style={styles.totalValue}>{dtrTotalHoursLabel(dtr)}</Text>
              </View>
            )}
          </View>

          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {isLoading ? (
              <View style={styles.centered}>
                <ActivityIndicator color="#1680D8" />
                <Text style={styles.mutedText}>Loading your DTR...</Text>
              </View>
            ) : loadError ? (
              <View style={styles.centered}>
                <Ionicons name="cloud-offline-outline" size={32} color="#DC2626" />
                <Text style={[styles.mutedText, styles.errorText]}>{loadError}</Text>
                <Pressable style={styles.retryButton} onPress={load}>
                  <Text style={styles.retryText}>Try Again</Text>
                </Pressable>
              </View>
            ) : dtr && dtr.rows.length === 0 ? (
              <View style={styles.centered}>
                <Ionicons name="document-text-outline" size={32} color="#CBD5E1" />
                <Text style={styles.mutedText}>No attendance records for this month.</Text>
              </View>
            ) : (
              dtr?.rows.map((row) => {
                const date = new Date(row.attendanceDate);
                const remarks = dtrRemarks(row);
                // Absent / leave days have no punches — no empty "In — Out —".
                const hasTimes = Boolean(row.timeInAt || row.timeOutAt);
                const color = statusColor(row.status);
                return (
                  <View key={row.id} style={styles.row}>
                    <View style={styles.dateBlock}>
                      <Text style={styles.dateDay}>{date.toLocaleDateString("en-US", { weekday: "short" })}</Text>
                      <Text style={styles.dateNum}>{date.getDate()}</Text>
                    </View>
                    <View style={styles.rowBody}>
                      <View style={styles.rowTop}>
                        <Text style={[styles.rowStatus, { color }]}>{dtrStatusLabel(row.status)}</Text>
                        {hasTimes && <Text style={styles.rowHours}>{dtrHoursLabel(row)}</Text>}
                      </View>
                      {hasTimes && (
                        <Text style={styles.rowTimes}>
                          {formatDtrTime(row.timeInAt)}  →  {formatDtrTime(row.timeOutAt)}
                        </Text>
                      )}
                      {!!remarks && <Text style={styles.rowRemarks}>{remarks}</Text>}
                    </View>
                  </View>
                );
              })
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#F4F7FB" },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  backButton: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: "#E8EEF5" },
  headerSpacer: { width: 36 },
  headerTitle: { fontSize: 17, fontWeight: "800", color: "#062B59" },
  card: {
    backgroundColor: "#fff",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#dbe5ef",
    marginHorizontal: 16,
    shadowColor: "#062B59",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 6,
  },
  pickerCard: { padding: 14, marginBottom: 12 },
  listCard: { flex: 1, marginBottom: 12, overflow: "hidden" },
  yearRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  sectionLabel: { color: "#062B59", fontSize: 14, fontWeight: "800" },
  yearStepper: { flexDirection: "row", alignItems: "center", gap: 10 },
  yearButton: { width: 30, height: 30, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: "#F1F5F9" },
  yearText: { color: "#062B59", fontSize: 15, fontWeight: "800", minWidth: 40, textAlign: "center" },
  // Six months per row, two rows.
  monthGrid: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 12 },
  monthChip: {
    width: "15%",
    flexGrow: 1,
    paddingVertical: 8,
    borderRadius: 9,
    alignItems: "center",
    backgroundColor: "#F1F5F9",
  },
  monthChipActive: { backgroundColor: "#062B59" },
  monthChipDisabled: { backgroundColor: "#F8FAFC" },
  monthChipText: { color: "#475569", fontSize: 12.5, fontWeight: "700" },
  monthChipTextActive: { color: "#FFFFFF" },
  monthChipTextDisabled: { color: "#CBD5E1" },
  disabled: { opacity: 0.45 },
  actionRow: { flexDirection: "row", gap: 10 },
  primaryButton: {
    flex: 1,
    height: 42,
    borderRadius: 11,
    backgroundColor: "#1680D8",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  primaryButtonText: { color: "#FFFFFF", fontSize: 13.5, fontWeight: "700" },
  secondaryButton: {
    flex: 1,
    height: 42,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: "#CBD5E1",
    backgroundColor: "#FFFFFF",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  secondaryButtonText: { color: "#062B59", fontSize: 13.5, fontWeight: "700" },
  notice: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginTop: 12, padding: 12, borderRadius: 12 },
  noticeSuccess: { backgroundColor: "#ECFDF3" },
  noticeError: { backgroundColor: "#FEF2F2" },
  noticeBody: { flex: 1 },
  noticeTitle: { color: "#0F172A", fontSize: 13, fontWeight: "800" },
  noticeText: { color: "#334155", fontSize: 12.5, marginTop: 2, lineHeight: 17 },
  noticeActions: { flexDirection: "row", gap: 16 },
  noticeAction: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 8 },
  noticeActionText: { color: "#1680D8", fontSize: 12.5, fontWeight: "700" },
  previewHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderColor: "#edf3f8",
  },
  previewTitleGroup: { flex: 1, minWidth: 0 },
  previewTitle: { color: "#062B59", fontSize: 16, fontWeight: "900" },
  previewSummary: { color: "#64748B", fontSize: 12, fontWeight: "600", marginTop: 2 },
  totalBlock: { alignItems: "flex-end" },
  totalLabel: { color: "#94A3B8", fontSize: 11, fontWeight: "600" },
  totalValue: { color: "#062B59", fontSize: 15, fontWeight: "800", fontVariant: ["tabular-nums"] },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 16, paddingBottom: 8, flexGrow: 1 },
  centered: { alignItems: "center", gap: 8, paddingVertical: 28 },
  mutedText: { color: "#94A3B8", fontSize: 13, fontWeight: "600", textAlign: "center" },
  errorText: { color: "#DC2626" },
  retryButton: { marginTop: 4, paddingHorizontal: 18, paddingVertical: 9, borderRadius: 10, backgroundColor: "#062B59" },
  retryText: { color: "#FFFFFF", fontSize: 13, fontWeight: "700" },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderColor: "#edf3f8",
  },
  dateBlock: { width: 42, alignItems: "center", paddingVertical: 3, borderRadius: 8, backgroundColor: "#F1F5F9" },
  dateDay: { color: "#64748B", fontSize: 10.5, fontWeight: "700", textTransform: "uppercase" },
  dateNum: { color: "#062B59", fontSize: 16, fontWeight: "900" },
  rowBody: { flex: 1, minWidth: 0, justifyContent: "center", minHeight: 40 },
  rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  rowStatus: { fontSize: 13.5, fontWeight: "800" },
  rowHours: { color: "#062B59", fontSize: 13, fontWeight: "800", fontVariant: ["tabular-nums"] },
  rowTimes: { color: "#334155", fontSize: 12.5, fontWeight: "600", marginTop: 2 },
  rowRemarks: { color: "#64748B", fontSize: 12, marginTop: 2 },
});
