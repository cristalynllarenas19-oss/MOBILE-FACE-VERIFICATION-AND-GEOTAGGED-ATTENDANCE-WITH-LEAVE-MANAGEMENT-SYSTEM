import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";
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

// Backing out of the print dialog / share sheet rejects too — not a failure.
function isCancel(error: unknown) {
  return /cancel|did not complete|dismiss/i.test(error instanceof Error ? error.message : "");
}

// My DTR — pick a month and year, check the records, then save them as a
// PDF or print them. Opened from the DTR tab's "Download / Print" button.
export default function DtrExportModal({ visible, onClose }: Props) {
  const now = new Date();
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
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.headerRow}>
          <Pressable onPress={onClose} style={styles.backButton} hitSlop={10}>
            <Ionicons name="chevron-back" size={24} color="#062B59" />
          </Pressable>
          <Text style={styles.headerTitle}>My DTR</Text>
          <View style={styles.headerSpacer} />
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.card}>
            <Text style={styles.sectionLabel}>Select Year</Text>
            <View style={styles.yearRow}>
              <Pressable style={styles.yearButton} onPress={() => changeYear(year - 1)} hitSlop={8}>
                <Ionicons name="chevron-back" size={18} color="#062B59" />
              </Pressable>
              <Text style={styles.yearText}>{year}</Text>
              <Pressable
                style={[styles.yearButton, year >= now.getFullYear() && styles.disabled]}
                disabled={year >= now.getFullYear()}
                onPress={() => changeYear(year + 1)}
                hitSlop={8}
              >
                <Ionicons name="chevron-forward" size={18} color="#062B59" />
              </Pressable>
            </View>

            <Text style={styles.sectionLabel}>Select Month</Text>
            <View style={styles.monthGrid}>
              {MONTH_NAMES.map((name, index) => {
                const value = index + 1;
                const isActive = value === month;
                const isDisabled = isFutureMonth(year, value);
                return (
                  <Pressable
                    key={name}
                    style={[styles.monthChip, isActive && styles.monthChipActive, isDisabled && styles.disabled]}
                    disabled={isDisabled}
                    onPress={() => setMonth(value)}
                  >
                    <Text style={[styles.monthChipText, isActive && styles.monthChipTextActive]}>{name.slice(0, 3)}</Text>
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
                  <Ionicons name="download-outline" size={18} color="#FFFFFF" />
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
                  <Ionicons name="print-outline" size={18} color="#062B59" />
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
            )}
          </View>

          <View style={styles.card}>
            <View style={styles.previewHeader}>
              <Text style={styles.previewTitle}>
                {MONTH_NAMES[month - 1]} {year}
              </Text>
              {dtr && <Text style={styles.previewTotal}>Total: {dtrTotalHoursLabel(dtr)}</Text>}
            </View>

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
                return (
                  <View key={row.id} style={styles.row}>
                    <View style={styles.rowTop}>
                      <View style={[styles.dot, { backgroundColor: statusColor(row.status) }]} />
                      <Text style={styles.rowDate}>
                        {date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                      </Text>
                      <Text style={[styles.rowStatus, { color: statusColor(row.status) }]}>{dtrStatusLabel(row.status)}</Text>
                    </View>
                    <View style={styles.rowTimes}>
                      <Text style={styles.rowTime}>In {formatDtrTime(row.timeInAt)}</Text>
                      <Text style={styles.rowTime}>Out {formatDtrTime(row.timeOutAt)}</Text>
                      <Text style={styles.rowHours}>{dtrHoursLabel(row)}</Text>
                    </View>
                    {!!remarks && <Text style={styles.rowRemarks}>{remarks}</Text>}
                  </View>
                );
              })
            )}
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#F4F7FB" },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  backButton: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: "#E8EEF5" },
  headerSpacer: { width: 36 },
  headerTitle: { fontSize: 16, fontWeight: "800", color: "#062B59" },
  content: { padding: 16, paddingTop: 4, gap: 14 },
  card: {
    backgroundColor: "#fff",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#dbe5ef",
    padding: 16,
    shadowColor: "#062B59",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 6,
  },
  sectionLabel: { color: "#64748B", fontSize: 12, fontWeight: "700", marginBottom: 8 },
  yearRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 14 },
  yearButton: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: "#F1F5F9" },
  yearText: { color: "#062B59", fontSize: 16, fontWeight: "800" },
  monthGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 16 },
  monthChip: {
    width: "23%",
    flexGrow: 1,
    paddingVertical: 9,
    borderRadius: 10,
    alignItems: "center",
    backgroundColor: "#F1F5F9",
  },
  monthChipActive: { backgroundColor: "#062B59" },
  monthChipText: { color: "#475569", fontSize: 13, fontWeight: "700" },
  monthChipTextActive: { color: "#FFFFFF" },
  disabled: { opacity: 0.4 },
  actionRow: { flexDirection: "row", gap: 10 },
  primaryButton: {
    flex: 1,
    height: 46,
    borderRadius: 12,
    backgroundColor: "#1680D8",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  primaryButtonText: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" },
  secondaryButton: {
    flex: 1,
    height: 46,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#CBD5E1",
    backgroundColor: "#FFFFFF",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  secondaryButtonText: { color: "#062B59", fontSize: 14, fontWeight: "700" },
  notice: { flexDirection: "row", gap: 10, marginTop: 14, padding: 12, borderRadius: 12 },
  noticeSuccess: { backgroundColor: "#ECFDF3" },
  noticeError: { backgroundColor: "#FEF2F2" },
  noticeBody: { flex: 1 },
  noticeTitle: { color: "#0F172A", fontSize: 13, fontWeight: "800" },
  noticeText: { color: "#334155", fontSize: 12.5, marginTop: 2, lineHeight: 17 },
  noticeAction: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 8 },
  noticeActionText: { color: "#1680D8", fontSize: 12.5, fontWeight: "700" },
  previewHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  previewTitle: { color: "#062B59", fontSize: 16, fontWeight: "900" },
  previewTotal: { color: "#334155", fontSize: 12.5, fontWeight: "700" },
  centered: { alignItems: "center", gap: 8, paddingVertical: 24 },
  mutedText: { color: "#94A3B8", fontSize: 13, fontWeight: "600", textAlign: "center" },
  errorText: { color: "#DC2626" },
  retryButton: { marginTop: 4, paddingHorizontal: 18, paddingVertical: 9, borderRadius: 10, backgroundColor: "#062B59" },
  retryText: { color: "#FFFFFF", fontSize: 13, fontWeight: "700" },
  row: { paddingVertical: 10, borderTopWidth: 1, borderColor: "#edf3f8" },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  rowDate: { flex: 1, color: "#062B59", fontSize: 14, fontWeight: "700" },
  rowStatus: { fontSize: 12, fontWeight: "800" },
  rowTimes: { flexDirection: "row", gap: 14, marginTop: 4, marginLeft: 16 },
  rowTime: { color: "#334155", fontSize: 12.5, fontWeight: "600" },
  rowHours: { marginLeft: "auto", color: "#334155", fontSize: 12.5, fontWeight: "800" },
  rowRemarks: { color: "#64748B", fontSize: 12, marginTop: 3, marginLeft: 16 },
});
