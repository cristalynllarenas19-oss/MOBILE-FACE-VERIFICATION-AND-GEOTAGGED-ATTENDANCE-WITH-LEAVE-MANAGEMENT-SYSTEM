import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { MonthlyDtr, getMyMonthlyDtr } from "../api";
import CalendarPickerModal from "./CalendarPickerModal";
import {
  DtrDocument,
  MONTH_NAMES,
  SavedDtr,
  downloadDtrPdf,
  dtrFileName,
  dtrHoursLabel,
  dtrPeriodLabel,
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

// Same tones DTRScreen's statusTone() uses for its rows.
function statusTone(status: string) {
  if (status === "PRESENT") return { color: "#17A34A", bg: "#ECFDF3" };
  if (status === "LATE") return { color: "#CA8A04", bg: "#FEFCE8" };
  if (status === "ON_LEAVE") return { color: "#1680D8", bg: "#EFF6FF" };
  if (status === "ABSENT") return { color: "#DC2626", bg: "#FEF2F2" };
  if (status === "LEAVE_PENDING") return { color: "#B45309", bg: "#FEF3C7" };
  return { color: "#64748B", bg: "#F1F5F9" };
}

// Always shown, in this order, even at zero — so the summary keeps the same
// shape from month to month.
const TILE_STATUSES = ["PRESENT", "LATE", "ON_LEAVE", "ABSENT"];

// Tiles for the four main statuses, plus any other status that occurs this
// month (Leave Pending, Pending Review) as extras. Statuses that print under
// the same label (FLAGGED / PENDING_REVIEW) are counted together.
function statusCounts(dtr: DtrDocument) {
  const byLabel = new Map<string, { status: string; count: number }>();
  for (const row of dtr.rows) {
    const label = dtrStatusLabel(row.status);
    const entry = byLabel.get(label) ?? { status: row.status, count: 0 };
    entry.count += 1;
    byLabel.set(label, entry);
  }
  const tiles = TILE_STATUSES.map((status) => {
    const label = dtrStatusLabel(status);
    return { status, label, count: byLabel.get(label)?.count ?? 0 };
  });
  const tileLabels = new Set(tiles.map((tile) => tile.label));
  const extras = [...byLabel]
    .filter(([label]) => !tileLabels.has(label))
    .map(([label, entry]) => ({ label, ...entry }));
  return { tiles, extras };
}

// The year is already in the period above, so the From/To boxes skip it.
function formatShortDate(value: Date) {
  return value.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Backing out of the print dialog / share sheet rejects too — not a failure.
function isCancel(error: unknown) {
  return /cancel|did not complete|dismiss/i.test(error instanceof Error ? error.message : "");
}

// My DTR — pick a month, check the records as they'll appear on the
// document, then save them as a PDF or print them. Opened from the DTR
// tab's "Download / Print" button.
export default function DtrExportModal({ visible, onClose }: Props) {
  const now = new Date();
  // The app draws edge-to-edge, so this full-screen modal sits under the
  // status and navigation bars unless padded by their real size.
  const insets = useSafeAreaInsets();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [dtr, setDtr] = useState<MonthlyDtr | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"download" | "print" | "share" | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [saved, setSaved] = useState<SavedDtr | null>(null);
  // Optional days inside the selected month; blank means the whole month.
  const [fromDate, setFromDate] = useState<Date | null>(null);
  const [toDate, setToDate] = useState<Date | null>(null);
  const [rangePicker, setRangePicker] = useState<"from" | "to" | null>(null);
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

  useEffect(() => {
    if (!visible) setIsPickerOpen(false);
  }, [visible]);

  // A range belongs to one month — moving to another month (or closing)
  // starts it over.
  useEffect(() => {
    setFromDate(null);
    setToDate(null);
  }, [year, month, visible]);

  // A saved file or error is for the old range, not the new one.
  useEffect(() => {
    setNotice(null);
    setSaved(null);
  }, [fromDate, toDate]);

  const isFutureMonth = (y: number, m: number) =>
    y > now.getFullYear() || (y === now.getFullYear() && m > now.getMonth() + 1);
  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;
  const monthStart = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0).getDate();
  // No attendance exists past today, so the current month's range stops there.
  const latestDate = isCurrentMonth ? now : new Date(year, month - 1, lastDay);
  const hasRange = Boolean(fromDate || toDate);

  // What's previewed and exported: the month, or just the picked days of it.
  const doc: DtrDocument | null =
    dtr && hasRange
      ? (() => {
          const from = fromDate?.getDate() ?? 1;
          const to = toDate?.getDate() ?? lastDay;
          return {
            ...dtr,
            days: { from, to },
            rows: dtr.rows.filter((row) => {
              const day = new Date(row.attendanceDate).getDate();
              return day >= from && day <= to;
            }),
          };
        })()
      : dtr;

  function changeYear(next: number) {
    setYear(next);
    if (isFutureMonth(next, month)) setMonth(now.getMonth() + 1);
  }

  function stepMonth(delta: number) {
    const target = new Date(year, month - 1 + delta, 1);
    if (isFutureMonth(target.getFullYear(), target.getMonth() + 1)) return;
    setYear(target.getFullYear());
    setMonth(target.getMonth() + 1);
  }

  async function handleDownload() {
    if (!doc) return;
    setBusy("download");
    setNotice(null);
    try {
      const result = await downloadDtrPdf(doc);
      setSaved(result);
      setNotice({
        tone: "success",
        title: result.savedTo ? `Saved to ${result.savedTo}` : "PDF Ready",
        message: result.fileName,
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
    if (!doc) return;
    setBusy("print");
    setNotice(null);
    try {
      await printDtr(doc);
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

  const hasRows = Boolean(doc?.rows.length);
  // An empty period would only print a blank sheet.
  const canExport = hasRows && !isLoading && busy === null;
  const summary = doc ? statusCounts(doc) : { tiles: [], extras: [] };
  const periodLabel = doc ? dtrPeriodLabel(doc) : "";
  const employeeMeta = doc
    ? [doc.employee.employeeNo, doc.employee.department, doc.employee.position].filter(Boolean).join(" · ")
    : "";
  const footerHint = isLoading || loadError || !doc
    ? null
    : hasRows
      ? `Saves as ${dtrFileName(doc)}`
      : hasRange
        ? "Nothing to export for these dates."
        : "Nothing to export for this month.";

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <View style={styles.headerRow}>
          <Pressable onPress={onClose} style={styles.backButton} hitSlop={10} accessibilityLabel="Back">
            <Ionicons name="chevron-back" size={22} color="#062B59" />
          </Pressable>
          <View style={styles.headerText}>
            <Text style={styles.headerTitle}>My DTR</Text>
            <Text style={styles.headerSubtitle}>Download or print your monthly record</Text>
          </View>
          <View style={styles.headerSpacer} />
        </View>

        {/* Period — steps a month at a time; tapping the label opens the
            full month/year grid for jumping further back. */}
        <View style={[styles.card, styles.periodCard]}>
          <View style={styles.periodRow}>
            <Pressable
              style={({ pressed }) => [styles.stepButton, pressed && styles.pressed]}
              onPress={() => stepMonth(-1)}
              hitSlop={6}
              accessibilityLabel="Previous month"
            >
              <Ionicons name="chevron-back" size={18} color="#062B59" />
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.periodLabel, pressed && styles.pressed]}
              onPress={() => setIsPickerOpen((open) => !open)}
              accessibilityRole="button"
              accessibilityLabel="Choose month and year"
            >
              <Text style={styles.periodCaption}>Period</Text>
              <View style={styles.periodValueRow}>
                <Text style={styles.periodValue}>
                  {MONTH_NAMES[month - 1]} {year}
                </Text>
                <Ionicons name={isPickerOpen ? "chevron-up" : "chevron-down"} size={16} color="#1680D8" />
              </View>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.stepButton, isCurrentMonth && styles.disabled, pressed && styles.pressed]}
              disabled={isCurrentMonth}
              onPress={() => stepMonth(1)}
              hitSlop={6}
              accessibilityLabel="Next month"
            >
              <Ionicons name="chevron-forward" size={18} color="#062B59" />
            </Pressable>
          </View>

          {isPickerOpen && (
            <View style={styles.pickerPanel}>
              <View style={styles.yearRow}>
                <Pressable style={styles.yearButton} onPress={() => changeYear(year - 1)} hitSlop={8} accessibilityLabel="Previous year">
                  <Ionicons name="chevron-back" size={16} color="#062B59" />
                </Pressable>
                <Text style={styles.yearText}>{year}</Text>
                <Pressable
                  style={[styles.yearButton, year >= now.getFullYear() && styles.disabled]}
                  disabled={year >= now.getFullYear()}
                  onPress={() => changeYear(year + 1)}
                  hitSlop={8}
                  accessibilityLabel="Next year"
                >
                  <Ionicons name="chevron-forward" size={16} color="#062B59" />
                </Pressable>
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
                      onPress={() => {
                        setMonth(value);
                        setIsPickerOpen(false);
                      }}
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
            </View>
          )}

          {/* Optional days within the month (e.g. a 1–15 cutoff) — same
              From/To boxes as the DTR tab. Blank exports the whole month. */}
          <View style={styles.rangeRow}>
            <Pressable
              style={({ pressed }) => [styles.dateBox, fromDate && styles.dateBoxFilled, pressed && styles.pressed]}
              onPress={() => setRangePicker("from")}
              accessibilityLabel="From date"
            >
              <Text style={[styles.dateBoxText, fromDate && styles.dateBoxTextFilled]} numberOfLines={1}>
                {fromDate ? formatShortDate(fromDate) : "From"}
              </Text>
              <Ionicons name="calendar-outline" size={16} color={fromDate ? "#1680D8" : "#64748B"} />
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.dateBox, toDate && styles.dateBoxFilled, pressed && styles.pressed]}
              onPress={() => setRangePicker("to")}
              accessibilityLabel="To date"
            >
              <Text style={[styles.dateBoxText, toDate && styles.dateBoxTextFilled]} numberOfLines={1}>
                {toDate ? formatShortDate(toDate) : "To"}
              </Text>
              <Ionicons name="calendar-outline" size={16} color={toDate ? "#1680D8" : "#64748B"} />
            </Pressable>
            {hasRange && (
              <Pressable
                style={styles.dateClear}
                onPress={() => {
                  setFromDate(null);
                  setToDate(null);
                }}
                hitSlop={6}
                accessibilityLabel="Clear dates"
              >
                <Ionicons name="close" size={16} color="#94A3B8" />
              </Pressable>
            )}
          </View>
        </View>

        {/* Preview — laid out like the document itself: who it's for, the
            period's totals, then each day. Remounted per month so it opens
            scrolled to the top. */}
        <View style={[styles.card, styles.docCard]}>
          <ScrollView key={`${year}-${month}`} contentContainerStyle={styles.docContent}>
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
            ) : doc ? (
              <>
                <View style={styles.docHead}>
                  <View style={styles.docTitleRow}>
                    <Text style={styles.docTitle}>DAILY TIME RECORD</Text>
                    <View style={styles.previewBadge}>
                      <Ionicons name="eye-outline" size={11} color="#1680D8" />
                      <Text style={styles.previewBadgeText}>Preview</Text>
                    </View>
                  </View>
                  <Text style={styles.empName} numberOfLines={1}>
                    {doc.employee.name}
                  </Text>
                  {!!employeeMeta && (
                    <Text style={styles.empMeta} numberOfLines={2}>
                      {employeeMeta}
                    </Text>
                  )}
                  <View style={styles.periodLine}>
                    <Ionicons name="calendar-outline" size={12} color="#1680D8" />
                    <Text style={styles.periodLineText}>{periodLabel}</Text>
                  </View>
                </View>

                {hasRows ? (
                  <>
                    <View style={styles.stats}>
                      <View style={styles.totalBar}>
                        <View style={styles.totalBarIcon}>
                          <Ionicons name="time-outline" size={16} color="#FFFFFF" />
                        </View>
                        <Text style={styles.totalBarLabel}>Total Hours Worked</Text>
                        <Text style={styles.totalBarValue}>{dtrTotalHoursLabel(doc)}</Text>
                      </View>
                      <View style={styles.tileRow}>
                        {summary.tiles.map(({ status, label, count }) => {
                          const tone = statusTone(status);
                          const isZero = count === 0;
                          return (
                            <View key={status} style={[styles.statTile, { backgroundColor: isZero ? "#F8FAFC" : tone.bg }]}>
                              <Text style={[styles.statTileCount, { color: isZero ? "#CBD5E1" : tone.color }]}>{count}</Text>
                              <Text style={[styles.statTileLabel, isZero && styles.statTileLabelZero]} numberOfLines={1}>
                                {label}
                              </Text>
                            </View>
                          );
                        })}
                      </View>
                      {summary.extras.length > 0 && (
                        <View style={styles.extraRow}>
                          {summary.extras.map(({ status, label, count }) => {
                            const tone = statusTone(status);
                            return (
                              <View key={label} style={styles.extraItem}>
                                <View style={[styles.statDot, { backgroundColor: tone.color }]} />
                                <Text style={styles.extraText}>
                                  <Text style={[styles.extraCount, { color: tone.color }]}>{count}</Text> {label}
                                </Text>
                              </View>
                            );
                          })}
                        </View>
                      )}
                    </View>

                    <Text style={styles.sectionLabel}>
                      Records · {doc.rows.length}
                    </Text>
                    {doc.rows.map((row) => {
                      const date = new Date(row.attendanceDate);
                      const remarks = dtrRemarks(row);
                      // Absent / leave days have no punches — no empty "In — Out —".
                      const hasTimes = Boolean(row.timeInAt || row.timeOutAt);
                      const tone = statusTone(row.status);
                      return (
                        <View key={row.id} style={styles.row}>
                          <View style={styles.dateBlock}>
                            <Text style={styles.dateDay}>{date.toLocaleDateString("en-US", { weekday: "short" })}</Text>
                            <Text style={styles.dateNum}>{date.getDate()}</Text>
                          </View>
                          <View style={styles.rowBody}>
                            <View style={styles.rowTop}>
                              <View style={[styles.statusPill, { backgroundColor: tone.bg }]}>
                                <Text style={[styles.statusPillText, { color: tone.color }]}>{dtrStatusLabel(row.status)}</Text>
                              </View>
                              {hasTimes && <Text style={styles.rowHours}>{dtrHoursLabel(row)}</Text>}
                            </View>
                            {hasTimes && (
                              <View style={styles.rowTimes}>
                                <Text style={styles.rowTimeText}>{formatDtrTime(row.timeInAt)}</Text>
                                <Ionicons name="arrow-forward" size={11} color="#94A3B8" />
                                <Text style={styles.rowTimeText}>{formatDtrTime(row.timeOutAt)}</Text>
                              </View>
                            )}
                            {!!remarks && <Text style={styles.rowRemarks}>{remarks}</Text>}
                          </View>
                        </View>
                      );
                    })}
                  </>
                ) : (
                  <View style={styles.centered}>
                    <Ionicons name="document-text-outline" size={32} color="#CBD5E1" />
                    <Text style={styles.mutedText}>
                      No attendance records for {periodLabel}.
                    </Text>
                  </View>
                )}
              </>
            ) : null}
          </ScrollView>
        </View>

        {/* Actions sit under the preview, in thumb reach, with the result of
            the last one right above them. */}
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          {notice && (
            <View style={[styles.notice, notice.tone === "error" ? styles.noticeError : styles.noticeSuccess]}>
              <Ionicons
                name={notice.tone === "error" ? "warning" : "checkmark-circle"}
                size={18}
                color={notice.tone === "error" ? "#DC2626" : "#17A34A"}
              />
              <View style={styles.noticeBody}>
                <Text style={styles.noticeTitle}>{notice.title}</Text>
                <Text style={styles.noticeText} numberOfLines={3}>
                  {notice.message}
                </Text>
                <View style={styles.noticeActions}>
                  {notice.tone === "success" && saved && (
                    <Pressable style={styles.noticeAction} onPress={handleShare} disabled={busy !== null}>
                      {busy === "share" ? (
                        <ActivityIndicator color="#1680D8" size="small" />
                      ) : (
                        <Ionicons name="open-outline" size={14} color="#1680D8" />
                      )}
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
              <Pressable onPress={() => setNotice(null)} hitSlop={8} accessibilityLabel="Dismiss">
                <Ionicons name="close" size={16} color="#94A3B8" />
              </Pressable>
            </View>
          )}

          <View style={styles.actionRow}>
            <Pressable
              style={({ pressed }) => [styles.secondaryButton, !canExport && styles.disabled, pressed && styles.pressed]}
              disabled={!canExport}
              onPress={handlePrint}
            >
              {busy === "print" ? (
                <ActivityIndicator color="#062B59" size="small" />
              ) : (
                <Ionicons name="print-outline" size={18} color="#062B59" />
              )}
              <Text style={styles.secondaryButtonText}>{busy === "print" ? "Opening..." : "Print"}</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.primaryButton, !canExport && styles.disabled, pressed && styles.pressed]}
              disabled={!canExport}
              onPress={handleDownload}
            >
              {busy === "download" ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <Ionicons name="download-outline" size={18} color="#FFFFFF" />
              )}
              <Text style={styles.primaryButtonText}>{busy === "download" ? "Saving PDF..." : "Download PDF"}</Text>
            </Pressable>
          </View>

          {!!footerHint && (
            <View style={styles.footerHintRow}>
              <Ionicons name={hasRows ? "document-outline" : "information-circle-outline"} size={12} color="#94A3B8" />
              <Text style={styles.footerHint} numberOfLines={1}>
                {footerHint}
              </Text>
            </View>
          )}
        </View>
      </View>

      {/* Both calendars stay inside the selected month and stop at today. */}
      <CalendarPickerModal
        visible={rangePicker === "from"}
        title="Select From Date"
        selectedDate={fromDate ?? undefined}
        initialMonth={monthStart}
        minimumDate={monthStart}
        maximumDate={toDate ?? latestDate}
        onSelect={(value) => {
          setFromDate(value);
          setRangePicker(null);
        }}
        onClose={() => setRangePicker(null)}
      />
      <CalendarPickerModal
        visible={rangePicker === "to"}
        title="Select To Date"
        selectedDate={toDate ?? undefined}
        initialMonth={monthStart}
        minimumDate={fromDate ?? monthStart}
        maximumDate={latestDate}
        onSelect={(value) => {
          setToDate(value);
          setRangePicker(null);
        }}
        onClose={() => setRangePicker(null)}
      />
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
  headerText: { flex: 1, alignItems: "center" },
  headerTitle: { fontSize: 17, fontWeight: "800", color: "#062B59" },
  headerSubtitle: { fontSize: 11.5, fontWeight: "600", color: "#64748B", marginTop: 1 },
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
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.45 },

  periodCard: { padding: 10, marginBottom: 12 },
  periodRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  stepButton: { width: 38, height: 38, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: "#F1F5F9" },
  periodLabel: { flex: 1, alignItems: "center", paddingVertical: 2, borderRadius: 10 },
  periodCaption: { color: "#94A3B8", fontSize: 10.5, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.6 },
  periodValueRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 1 },
  periodValue: { color: "#062B59", fontSize: 16, fontWeight: "900" },
  pickerPanel: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderColor: "#edf3f8" },
  yearRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 14, marginBottom: 10 },
  yearButton: { width: 30, height: 30, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: "#F1F5F9" },
  yearText: { color: "#062B59", fontSize: 15, fontWeight: "800", minWidth: 44, textAlign: "center" },
  // Four months per row, three rows.
  monthGrid: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  monthChip: {
    width: "22%",
    flexGrow: 1,
    paddingVertical: 9,
    borderRadius: 9,
    alignItems: "center",
    backgroundColor: "#F1F5F9",
  },
  monthChipActive: { backgroundColor: "#062B59" },
  monthChipDisabled: { backgroundColor: "#F8FAFC" },
  monthChipText: { color: "#475569", fontSize: 13, fontWeight: "700" },
  monthChipTextActive: { color: "#FFFFFF" },
  monthChipTextDisabled: { color: "#CBD5E1" },
  // Same outlined boxes as the DTR tab's From/To filter.
  rangeRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 },
  dateBox: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    height: 48,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    backgroundColor: "#FFFFFF",
  },
  dateBoxFilled: { borderColor: "#B9D7F3", backgroundColor: "#F5FAFF" },
  dateBoxText: { flexShrink: 1, color: "#94A3B8", fontSize: 14, fontWeight: "600" },
  dateBoxTextFilled: { color: "#0F172A" },
  dateClear: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center", backgroundColor: "#F1F5F9" },

  docCard: { flex: 1, marginBottom: 12, overflow: "hidden" },
  docContent: { paddingHorizontal: 16, paddingBottom: 12, flexGrow: 1 },
  docHead: { paddingTop: 14, paddingBottom: 12, borderBottomWidth: 1, borderColor: "#edf3f8" },
  docTitleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
  docTitle: { color: "#1A3A5C", fontSize: 11, fontWeight: "800", letterSpacing: 1.2 },
  previewBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: "#E8F2FC",
  },
  previewBadgeText: { color: "#1680D8", fontSize: 10.5, fontWeight: "800" },
  empName: { color: "#062B59", fontSize: 17, fontWeight: "900" },
  empMeta: { color: "#64748B", fontSize: 12, fontWeight: "600", marginTop: 2 },
  periodLine: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 6 },
  periodLineText: { color: "#1680D8", fontSize: 12, fontWeight: "800" },

  stats: { gap: 8, paddingVertical: 12 },
  totalBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: "#062B59",
  },
  totalBarIcon: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.14)",
  },
  totalBarLabel: { flex: 1, color: "#BFD3EA", fontSize: 12.5, fontWeight: "700" },
  totalBarValue: { color: "#FFFFFF", fontSize: 18, fontWeight: "900", fontVariant: ["tabular-nums"] },
  tileRow: { flexDirection: "row", gap: 6 },
  statTile: { flex: 1, alignItems: "center", paddingVertical: 9, paddingHorizontal: 2, borderRadius: 11 },
  statTileCount: { fontSize: 18, fontWeight: "900", fontVariant: ["tabular-nums"] },
  statTileLabel: { color: "#475569", fontSize: 11, fontWeight: "700", marginTop: 1 },
  statTileLabelZero: { color: "#CBD5E1" },
  extraRow: { flexDirection: "row", flexWrap: "wrap", gap: 12, paddingHorizontal: 2 },
  extraItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  statDot: { width: 6, height: 6, borderRadius: 3 },
  extraText: { color: "#475569", fontSize: 12, fontWeight: "600" },
  extraCount: { fontWeight: "900" },

  sectionLabel: { color: "#94A3B8", fontSize: 10.5, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 2 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 28 },
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
  statusPill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  statusPillText: { fontSize: 12, fontWeight: "800" },
  rowHours: { color: "#062B59", fontSize: 13, fontWeight: "800", fontVariant: ["tabular-nums"] },
  rowTimes: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  rowTimeText: { color: "#334155", fontSize: 12.5, fontWeight: "600", fontVariant: ["tabular-nums"] },
  rowRemarks: { color: "#64748B", fontSize: 12, marginTop: 3 },

  footer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    backgroundColor: "#FFFFFF",
    borderTopWidth: 1,
    borderColor: "#dbe5ef",
  },
  notice: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginBottom: 10, padding: 12, borderRadius: 12 },
  noticeSuccess: { backgroundColor: "#ECFDF3" },
  noticeError: { backgroundColor: "#FEF2F2" },
  noticeBody: { flex: 1 },
  noticeTitle: { color: "#0F172A", fontSize: 13, fontWeight: "800" },
  noticeText: { color: "#334155", fontSize: 12.5, marginTop: 2, lineHeight: 17 },
  noticeActions: { flexDirection: "row", gap: 16 },
  noticeAction: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 8 },
  noticeActionText: { color: "#1680D8", fontSize: 12.5, fontWeight: "700" },
  actionRow: { flexDirection: "row", gap: 10 },
  primaryButton: {
    flex: 1.6,
    height: 48,
    borderRadius: 13,
    backgroundColor: "#1680D8",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  },
  primaryButtonText: { color: "#FFFFFF", fontSize: 14.5, fontWeight: "800" },
  secondaryButton: {
    flex: 1,
    height: 48,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: "#CBD5E1",
    backgroundColor: "#FFFFFF",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  },
  secondaryButtonText: { color: "#062B59", fontSize: 14.5, fontWeight: "800" },
  footerHintRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, marginTop: 8 },
  footerHint: { flexShrink: 1, color: "#94A3B8", fontSize: 11.5, fontWeight: "600" },
});
