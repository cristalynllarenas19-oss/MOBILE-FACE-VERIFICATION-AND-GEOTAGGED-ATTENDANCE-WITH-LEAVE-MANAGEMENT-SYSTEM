import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  StyleSheet,
  SafeAreaView,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Coffee, Utensils } from "lucide-react-native";
import {
  FlaggedAttendanceLog,
  TeamAttendanceRecord,
  getFlaggedAttendanceLogs,
  getTeamAttendance,
} from "../../api";
import { CACHE_KEYS, useCachedData } from "../../utils/dataCache";
import AestheticScrollView from "../../components/AestheticScrollView";

// Stable fallbacks so useMemo filters don't recompute on every render while
// the cache/network is still empty.
const EMPTY_RECORDS: TeamAttendanceRecord[] = [];
const EMPTY_FLAGGED: FlaggedAttendanceLog[] = [];
import Avatar from "../../components/Avatar";
import StatusPill from "../../components/StatusPill";
import SegmentedControl from "../../components/SegmentedControl";
import CalendarPickerModal from "../../components/CalendarPickerModal";
import ResultModal, { ResultModalStatus } from "../../components/ResultModal";
import FlaggedAttendanceReviewModal from "./FlaggedAttendanceReviewModal";
import { ui } from "../../styles/ui";

function formatTime(value?: string | null) {
  return value ? new Date(value).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "--:--";
}

function toDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseDateKey(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

// Same short form DTRScreen's From/To filters show.
function formatShortDate(value: string) {
  return parseDateKey(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Same two labels admin-web's Attendance page uses for a record's mode —
// "Non-field", not "Office", is the wording shown to the user.
function recordTypeLabel(recordType?: string | null) {
  return recordType === "FIELD" ? "Field" : "Non-field";
}

// "All" leads every filter in this app, so the unfiltered view is the one
// the thumb lands on first.
const STATUS_FILTERS = ["ALL", "PRESENT", "LATE", "ABSENT", "ON_LEAVE"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number] | "FLAGGED";
type RecordTypeFilter = "ALL" | "OFFICE" | "FIELD";

function statusLabel(status: StatusFilter) {
  if (status === "ALL") return "All";
  const words = status.toLowerCase().split("_");
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

// One list row, from either source: a real AttendanceRecord, or a flagged
// AttendanceLog that has no record behind it yet (the same merge
// admin-web's AttendancePage does via flaggedLogToRecord).
type AttendanceRow = {
  key: string;
  attendanceDate: string;
  status: string;
  recordType?: string | null;
  timeInAt?: string | null;
  timeOutAt?: string | null;
  lunchOutAt?: string | null;
  lunchInAt?: string | null;
  breakKind?: "LUNCH" | "BREAK";
  workLocation?: { name: string } | null;
  employee: { firstName: string; lastName: string; department: { name: string } };
  flaggedLog?: FlaggedAttendanceLog;
};

function recordToRow(record: TeamAttendanceRecord): AttendanceRow {
  return {
    key: record.id,
    attendanceDate: record.attendanceDate,
    status: record.status,
    recordType: record.recordType,
    timeInAt: record.timeInAt,
    timeOutAt: record.timeOutAt,
    lunchOutAt: record.lunchOutAt,
    lunchInAt: record.lunchInAt,
    breakKind: record.breakKind,
    workLocation: record.workLocation,
    employee: record.employee,
  };
}

function flaggedLogToRow(log: FlaggedAttendanceLog): AttendanceRow {
  return {
    key: `flagged-${log.id}`,
    attendanceDate: log.attendanceDate ?? log.capturedAt,
    status: "FLAGGED",
    recordType: log.recordType,
    timeInAt: null,
    timeOutAt: null,
    workLocation: log.workLocation,
    employee: log.employee,
    flaggedLog: log,
  };
}

export default function SupervisorAttendanceScreen({
  // Mirrors admin-web's `canWrite` on the Attendance page: the flagged
  // review queue is gated on attendance:write, which a Supervisor role only
  // has if an admin granted it. Without it GET /attendance/flagged answers
  // 403, so no flagged rows and no review actions are shown at all.
  canReviewFlagged = false,
}: {
  canReviewFlagged?: boolean;
}) {
  const today = toDateKey(new Date());

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [recordTypeFilter, setRecordTypeFilter] = useState<RecordTypeFilter>("ALL");
  // Both default to today, which is what this screen showed before a range
  // could be picked at all; clearing them widens it the same way leaving
  // admin-web's From/To inputs empty does.
  const [dateFrom, setDateFrom] = useState(today);
  const [dateTo, setDateTo] = useState(today);
  const [pickingDate, setPickingDate] = useState<"from" | "to" | null>(null);
  const [reviewingLog, setReviewingLog] = useState<FlaggedAttendanceLog | null>(null);
  const [resultModal, setResultModal] = useState<{ status: ResultModalStatus; title: string; message: string } | null>(
    null,
  );

  const isTodayOnly = dateFrom === today && dateTo === today;
  // Keyed by the filters that reach the server so one filter combination is
  // never shown as another's result. The default (today, all modes) keeps
  // the exact key App.tsx prefetches at sign-in, so opening this tab shows
  // that data instantly instead of refetching it.
  const cacheKey =
    isTodayOnly && recordTypeFilter === "ALL"
      ? CACHE_KEYS.teamAttendance(today)
      : CACHE_KEYS.teamAttendance(`${dateFrom || "any"}|${dateTo || "any"}|${recordTypeFilter}`);

  const fetchRecords = useCallback(
    () =>
      getTeamAttendance({
        ...(isTodayOnly ? { date: today } : {}),
        ...(!isTodayOnly && dateFrom ? { from: dateFrom } : {}),
        ...(!isTodayOnly && dateTo ? { to: dateTo } : {}),
        ...(recordTypeFilter !== "ALL" ? { recordType: recordTypeFilter } : {}),
      }),
    [dateFrom, dateTo, isTodayOnly, recordTypeFilter, today],
  );

  const { data, isLoading, refresh } = useCachedData<TeamAttendanceRecord[]>(cacheKey, fetchRecords);
  const records = data ?? EMPTY_RECORDS;

  // Deliberately not run through the data cache: the pending-review queue
  // has to be gone the moment it is decided on, and each log carries its
  // captured face photo, which has no business being written to the
  // on-disk cache.
  const [flaggedLogs, setFlaggedLogs] = useState<FlaggedAttendanceLog[]>(EMPTY_FLAGGED);

  const loadFlagged = useCallback(async () => {
    if (!canReviewFlagged) {
      setFlaggedLogs(EMPTY_FLAGGED);
      return;
    }
    try {
      setFlaggedLogs(await getFlaggedAttendanceLogs());
    } catch {
      // 403 for a Supervisor role without attendance:write — same silent
      // fallback to "no flagged rows" admin-web uses.
      setFlaggedLogs(EMPTY_FLAGGED);
    }
  }, [canReviewFlagged]);

  useEffect(() => {
    loadFlagged();
  }, [loadFlagged]);

  const load = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setIsRefreshing(true);
      try {
        await Promise.all([refresh(), loadFlagged()]);
      } catch (error) {
        console.error("Failed to load team attendance", error);
      } finally {
        setIsRefreshing(false);
      }
    },
    [refresh, loadFlagged],
  );

  // /attendance/flagged takes no filters, so the date range and mode are
  // applied here — otherwise flagged attempts from any date would show up
  // inside a narrower range (the same client-side pass AttendancePage.tsx
  // makes).
  const flaggedRows = useMemo(() => {
    const fromTime = dateFrom ? parseDateKey(dateFrom).getTime() : null;
    const toTime = dateTo ? parseDateKey(dateTo).getTime() + 86_399_999 : null;
    return flaggedLogs.map(flaggedLogToRow).filter((row) => {
      if (recordTypeFilter !== "ALL" && row.recordType !== recordTypeFilter) return false;
      const time = new Date(row.attendanceDate).getTime();
      if (fromTime !== null && time < fromTime) return false;
      if (toTime !== null && time > toTime) return false;
      return true;
    });
  }, [dateFrom, dateTo, flaggedLogs, recordTypeFilter]);

  // Newest date first across both sources, flagged rows ahead of records on
  // the same date so a pending review is never buried under that day's
  // settled rows.
  const rows = useMemo(
    () =>
      [...flaggedRows, ...records.map(recordToRow)].sort(
        (a, b) => new Date(b.attendanceDate).getTime() - new Date(a.attendanceDate).getTime(),
      ),
    [flaggedRows, records],
  );

  const searched = useMemo(
    () =>
      rows.filter((row) =>
        `${row.employee.firstName} ${row.employee.lastName}`.toLowerCase().includes(search.toLowerCase()),
      ),
    [rows, search],
  );

  const filtered = useMemo(
    () => (statusFilter === "ALL" ? searched : searched.filter((row) => row.status === statusFilter)),
    [searched, statusFilter],
  );

  const presentCount = searched.filter((row) => row.status === "PRESENT" || row.status === "LATE").length;
  const flaggedCount = searched.filter((row) => row.status === "FLAGGED").length;
  const statusFilters: StatusFilter[] = canReviewFlagged ? [...STATUS_FILTERS, "FLAGGED"] : [...STATUS_FILTERS];
  // Sunday is the company-wide rest day, so an empty list then is expected
  // rather than a sign nobody has logged in yet.
  const isRestDayToday = isTodayOnly && new Date().getDay() === 0;

  const rangeLabel = !dateFrom && !dateTo
    ? "All dates"
    : isTodayOnly
      ? new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })
      : dateFrom && dateTo
        ? dateFrom === dateTo
          ? formatShortDate(dateFrom)
          : `${formatShortDate(dateFrom)} - ${formatShortDate(dateTo)}`
        : dateFrom
          ? `From ${formatShortDate(dateFrom)}`
          : `Until ${formatShortDate(dateTo)}`;

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* Mode first, as its own tab track — the same place DTRScreen puts
          its Office / Field switch. */}
      <SegmentedControl
        segments={[
          { key: "ALL", label: "All" },
          { key: "OFFICE", label: "Non-field" },
          { key: "FIELD", label: "Field" },
        ]}
        value={recordTypeFilter}
        onChange={(key) => setRecordTypeFilter(key as RecordTypeFilter)}
        style={ui.tabSwitcher}
      />

      <View style={ui.card}>
        <View style={ui.pinnedHeader}>
          <View style={styles.titleRow}>
            <View style={{ flex: 1 }}>
              <Text style={ui.cardTitle}>Team Attendance</Text>
              <Text style={ui.cardSubtitle} numberOfLines={1}>
                {rangeLabel}
              </Text>
            </View>
            {/* No "0/0 in" on an empty day — a count only when there is
                something to count. */}
            {!isLoading && searched.length > 0 && (
              <View style={styles.badges}>
                {flaggedCount > 0 && <Text style={styles.flaggedBadge}>{flaggedCount} flagged</Text>}
                <Text style={styles.countBadge}>
                  {isTodayOnly ? `${presentCount}/${searched.length} in` : `${searched.length} records`}
                </Text>
              </View>
            )}
          </View>

          <View style={styles.searchRow}>
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

          {/* Tighter than the shared input box so a full "Oct 11, 2026" and
              its icon both fit inside each box with the reset button in the
              row. */}
          <View style={[ui.filterRow, styles.dateRow]}>
            <Pressable style={[ui.inputBox, styles.dateBox]} onPress={() => setPickingDate("from")}>
              <Text style={[ui.inputBoxText, styles.dateText, !!dateFrom && ui.inputBoxTextFilled]} numberOfLines={1}>
                {dateFrom ? formatShortDate(dateFrom) : "From"}
              </Text>
              <Ionicons name="calendar-outline" size={15} color="#64748B" />
            </Pressable>
            <Pressable style={[ui.inputBox, styles.dateBox]} onPress={() => setPickingDate("to")}>
              <Text style={[ui.inputBoxText, styles.dateText, !!dateTo && ui.inputBoxTextFilled]} numberOfLines={1}>
                {dateTo ? formatShortDate(dateTo) : "To"}
              </Text>
              <Ionicons name="calendar-outline" size={15} color="#64748B" />
            </Pressable>
            {!isTodayOnly && (
              <Pressable
                style={styles.dateReset}
                hitSlop={10}
                onPress={() => {
                  setDateFrom(today);
                  setDateTo(today);
                }}
              >
                <Ionicons name="close" size={13} color="#94A3B8" />
              </Pressable>
            )}
          </View>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.statusChipScroller}
            contentContainerStyle={styles.statusChipRow}
            keyboardShouldPersistTaps="handled"
          >
            {statusFilters.map((status) => {
              const isActive = statusFilter === status;
              return (
                <Pressable
                  key={status}
                  style={[ui.filterChip, isActive && ui.filterChipActive]}
                  onPress={() => setStatusFilter(status)}
                >
                  <Text style={[ui.filterChipText, isActive && ui.filterChipTextActive]}>{statusLabel(status)}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
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
                <Ionicons name={isRestDayToday ? "moon-outline" : "time-outline"} size={36} color="#CBD5E1" />
                <Text style={ui.emptyText}>
                  {statusFilter !== "ALL"
                    ? `No ${statusLabel(statusFilter).toLowerCase()} records for this filter.`
                    : search.trim()
                      ? "No employees match your search."
                      : isRestDayToday
                        ? "Today is a rest day — no attendance is expected."
                        : isTodayOnly
                          ? "Nothing logged for your team today yet."
                          : "Nothing logged for your team in this date range."}
                </Text>
              </View>
            ) : (
              <View style={styles.rowList}>
                {filtered.map((row) => {
                  const isFlagged = !!row.flaggedLog;
                  const body = (
                    <View style={[ui.innerCard, styles.row, isFlagged && styles.rowFlagged]}>
                      <Avatar firstName={row.employee.firstName} lastName={row.employee.lastName} size={38} />
                      <View style={{ flex: 1 }}>
                        <View style={styles.rowHeader}>
                          <Text style={styles.employeeName} numberOfLines={1}>
                            {row.employee.firstName} {row.employee.lastName}
                          </Text>
                          <StatusPill status={row.status} />
                        </View>
                        <View style={styles.metaRow}>
                          <Text style={styles.metaBadge}>{recordTypeLabel(row.recordType)}</Text>
                          {!isTodayOnly && (
                            <Text style={styles.metaText}>
                              {formatShortDate(toDateKey(new Date(row.attendanceDate)))}
                            </Text>
                          )}
                        </View>
                        {isFlagged ? (
                          <View style={styles.flaggedRow}>
                            <Ionicons name="warning-outline" size={13} color="#B45309" />
                            <Text style={styles.flaggedText} numberOfLines={1}>
                              Face mismatch · tap to review
                            </Text>
                          </View>
                        ) : (
                          <View style={styles.timesRow}>
                            <View style={styles.timeChip}>
                              <Ionicons name="log-in-outline" size={13} color="#15803D" />
                              <Text style={styles.timeText}>{formatTime(row.timeInAt)}</Text>
                            </View>
                            <View style={styles.timeChip}>
                              <Ionicons name="log-out-outline" size={13} color="#B91C1C" />
                              <Text style={styles.timeText}>{formatTime(row.timeOutAt)}</Text>
                            </View>
                            {(row.lunchOutAt || row.lunchInAt) && (
                              <View style={styles.timeChip}>
                                {row.breakKind === "BREAK" ? (
                                  <Coffee size={13} color="#EA580C" />
                                ) : (
                                  <Utensils size={13} color="#EA580C" />
                                )}
                                <Text style={styles.timeText}>
                                  {row.breakKind === "BREAK" ? "Break" : "Lunch"} {formatTime(row.lunchOutAt)} -{" "}
                                  {formatTime(row.lunchInAt)}
                                </Text>
                              </View>
                            )}
                          </View>
                        )}
                        {row.workLocation && (
                          <View style={styles.locationRow}>
                            <Ionicons name="location-outline" size={12} color="#64748B" />
                            <Text style={styles.locationText} numberOfLines={1}>
                              {row.workLocation.name}
                            </Text>
                          </View>
                        )}
                      </View>
                      {isFlagged && <Ionicons name="chevron-forward" size={18} color="#CBD5E1" />}
                    </View>
                  );

                  return isFlagged ? (
                    <Pressable
                      key={row.key}
                      onPress={() => setReviewingLog(row.flaggedLog ?? null)}
                      style={({ pressed }) => (pressed ? styles.rowPressed : undefined)}
                    >
                      {body}
                    </Pressable>
                  ) : (
                    <View key={row.key}>{body}</View>
                  );
                })}
              </View>
            )}
          </AestheticScrollView>
        )}
      </View>

      {/* Same in-app CalendarPickerModal the employee screens use for their
          date filters, rather than the OS-native picker. */}
      <CalendarPickerModal
        visible={pickingDate !== null}
        title={pickingDate === "to" ? "Select To Date" : "Select From Date"}
        selectedDate={
          pickingDate === "to"
            ? dateTo
              ? parseDateKey(dateTo)
              : undefined
            : dateFrom
              ? parseDateKey(dateFrom)
              : undefined
        }
        minimumDate={pickingDate === "to" && dateFrom ? parseDateKey(dateFrom) : undefined}
        // No attendance exists for future dates, so neither bound goes past
        // today; "From" also can't pass "To".
        maximumDate={pickingDate === "from" && dateTo ? parseDateKey(dateTo) : new Date()}
        onSelect={(date) => {
          if (pickingDate === "to") setDateTo(toDateKey(date));
          else setDateFrom(toDateKey(date));
          setPickingDate(null);
        }}
        onClose={() => setPickingDate(null)}
      />

      <FlaggedAttendanceReviewModal
        log={reviewingLog}
        onClose={() => setReviewingLog(null)}
        onResolved={(decision, title, message) => {
          setReviewingLog(null);
          setResultModal({ status: decision === "validate" ? "approved" : "rejected", title, message });
          load().catch(() => undefined);
        }}
      />

      <ResultModal
        visible={!!resultModal}
        status={resultModal?.status ?? "info"}
        title={resultModal?.title ?? ""}
        message={resultModal?.message ?? ""}
        onClose={() => setResultModal(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 40 },
  titleRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginBottom: 14 },
  badges: { alignItems: "flex-end", gap: 4 },
  countBadge: {
    fontSize: 11.5,
    color: "#15803D",
    fontWeight: "700",
    backgroundColor: "#DCFCE7",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    overflow: "hidden",
  },
  flaggedBadge: {
    fontSize: 11.5,
    color: "#B91C1C",
    fontWeight: "700",
    backgroundColor: "#FEE2E2",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    overflow: "hidden",
  },
  searchRow: { flexDirection: "row", marginBottom: 14 },
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
  dateRow: { gap: 6 },
  dateBox: { paddingHorizontal: 10, gap: 6 },
  dateText: { fontSize: 13 },
  dateReset: {
    alignItems: "center",
    justifyContent: "center",
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "#F1F5F9",
  },
  statusChipScroller: { marginHorizontal: -18 },
  statusChipRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingBottom: 14, paddingHorizontal: 18 },
  rowList: { gap: 10 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  rowFlagged: { borderColor: "#FCA5A5", backgroundColor: "#FEF7F7" },
  rowPressed: { opacity: 0.85 },
  rowHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  employeeName: { fontSize: 14, fontWeight: "700", color: "#062B59", flexShrink: 1 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 },
  metaBadge: {
    fontSize: 10.5,
    fontWeight: "700",
    color: "#475569",
    backgroundColor: "#E2E8F0",
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    overflow: "hidden",
  },
  metaText: { fontSize: 11, color: "#64748B", fontWeight: "600" },
  timesRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  timeChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#E2E8F0",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  timeText: { fontSize: 12, color: "#334155", fontWeight: "600" },
  flaggedRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 8 },
  flaggedText: { fontSize: 11.5, color: "#B45309", fontWeight: "700" },
  locationRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 6 },
  locationText: { flex: 1, fontSize: 11, color: "#64748B" },
});
