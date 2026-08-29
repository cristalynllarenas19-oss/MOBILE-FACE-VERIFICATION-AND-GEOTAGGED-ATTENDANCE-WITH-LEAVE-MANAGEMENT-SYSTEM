import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
  Modal,
  Image,
  ImageBackground,
  Pressable,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import DateTimePickerModal from "react-native-modal-datetime-picker";
import { AttendanceHistoryRecord, AttendanceLogPhoto, getAttendanceHistory } from "../api";
import { CACHE_KEYS, useCachedData } from "../utils/dataCache";
import SegmentedControl from "../components/SegmentedControl";

type Props = {
  employeeId?: string;
};

type Tab = "office" | "field";
type PhotoStampTile = { key: string; url: string; left: number; top: number };

// Stable fallback so useMemo filters don't recompute on every render while
// the cache/network is still empty.
const EMPTY_RECORDS: AttendanceHistoryRecord[] = [];
const PHOTO_STAMP_TILE_SIZE = 256;
const PHOTO_STAMP_MAP_SIZE = 56;
const PHOTO_STAMP_MAP_ZOOM = 16;
// Matches the app's own accent blue (used for icons/CTAs elsewhere on this
// screen) instead of the picker's default iOS blue — only takes effect on
// iOS via the accentColor prop below; the Android calendar's colors come
// from the native theme instead (see the datetimepicker plugin config in
// app.json), which needs a rebuild, not just a JS change, to pick up.
const CALENDAR_ACCENT_COLOR = "#1680D8";

function buildPhotoStampTiles(latitude: string | number, longitude: string | number): PhotoStampTile[] {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];

  const worldSize = PHOTO_STAMP_TILE_SIZE * Math.pow(2, PHOTO_STAMP_MAP_ZOOM);
  const globalX = ((lng + 180) / 360) * worldSize;
  const latRad = (lat * Math.PI) / 180;
  const globalY = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * worldSize;
  const windowLeft = globalX - PHOTO_STAMP_MAP_SIZE / 2;
  const windowTop = globalY - PHOTO_STAMP_MAP_SIZE / 2;
  const tileX = Math.floor(windowLeft / PHOTO_STAMP_TILE_SIZE);
  const tileY = Math.floor(windowTop / PHOTO_STAMP_TILE_SIZE);

  return [0, 1].flatMap((dx) => [0, 1].map((dy) => {
    const x = tileX + dx;
    const y = tileY + dy;
    return {
      key: `${x}-${y}`,
      url: `https://a.basemaps.cartocdn.com/rastertiles/voyager/${PHOTO_STAMP_MAP_ZOOM}/${x}/${y}.png`,
      left: x * PHOTO_STAMP_TILE_SIZE - windowLeft,
      top: y * PHOTO_STAMP_TILE_SIZE - windowTop,
    };
  }));
}

function isMorning(value: string | null) {
  if (!value) return true;
  return new Date(value).getHours() < 12;
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// Compact form for the date-filter chips — no weekday, these sit side by
// side in a "From ... To ..." row where the full formatDate() output
// wouldn't fit.
function formatShortDate(value: Date) {
  return value.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Local calendar-day boundaries (not UTC) so a "From"/"To" pick matches what
// the user actually tapped on the date picker, not a day shifted by
// timezone — attendanceDate comparisons below use these, inclusive on both
// ends.
function startOfDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}
function endOfDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate(), 23, 59, 59, 999).getTime();
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

function formatPhotoStampTime(value: string) {
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatPhotoStampCoordinates(latitude: string | number, longitude: string | number) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "Location unavailable";
  return `${Math.abs(lat).toFixed(6)}°${lat >= 0 ? "N" : "S"}, ${Math.abs(lng).toFixed(6)}°${lng >= 0 ? "E" : "W"}`;
}

function photoTabLabel(tab: "TIME_IN" | "TIME_OUT" | "LUNCH_OUT" | "LUNCH_IN", isOfficeTab: boolean) {
  if (tab === "LUNCH_OUT") return "Lunch Start";
  if (tab === "LUNCH_IN") return "Lunch End";
  if (tab === "TIME_IN") return isOfficeTab ? "Time In" : "Visit Start";
  return isOfficeTab ? "Time Out" : "Visit End";
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
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("office");
  const [selectedRecord, setSelectedRecord] = useState<AttendanceHistoryRecord | null>(null);
  const [photoTab, setPhotoTab] = useState<"TIME_IN" | "TIME_OUT" | "LUNCH_OUT" | "LUNCH_IN">("TIME_IN");
  const [amPmFilter, setAmPmFilter] = useState<"ALL" | "AM" | "PM">("ALL");
  // Date-range filter for the list below the (now-pinned) summary card —
  // both ends optional/independent, inclusive. Deliberately does not affect
  // the "Today's Hours Rendered" summary card above it (see
  // todayOfficeRecord/todayFieldRecord below), which always reflects today
  // regardless of what range the list itself is filtered to.
  const [dateFrom, setDateFrom] = useState<Date | null>(null);
  const [dateTo, setDateTo] = useState<Date | null>(null);
  const [isFromPickerVisible, setIsFromPickerVisible] = useState(false);
  const [isToPickerVisible, setIsToPickerVisible] = useState(false);
  const activeLog = selectedRecord?.logs.find((l) => l.logType === photoTab) ?? null;
  // The GPS stamp is drawn from the log's own permanently stored address
  // (resolved once, server-side, at submission time — see attendance.
  // service.ts submit()). Deliberately never re-geocoded here: a capture is
  // a frozen record, and re-deriving its address on-device is exactly what
  // let this screen and web disagree on the same log. Every row has a
  // stored address (backfilled for anything captured before this field
  // existed), so the coordinate fallback below is only a last resort.
  const photoStampAddress = activeLog
    ? activeLog.address ?? formatPhotoStampCoordinates(activeLog.latitude, activeLog.longitude)
    : null;

  const { data, isLoading, refresh } = useCachedData<AttendanceHistoryRecord[]>(
    employeeId ? CACHE_KEYS.attendanceHistory(employeeId) : null,
    () => getAttendanceHistory(employeeId!),
  );
  const records = data ?? EMPTY_RECORDS;

  async function handleRefresh() {
    setIsRefreshing(true);
    await refresh().catch((error) => console.error("Failed to load attendance history", error));
    setIsRefreshing(false);
  }

  // Unfiltered by date — these back the "Today's Hours Rendered" summary
  // card, which should keep reflecting today even while the list below is
  // filtered to a different date range.
  const officeRecordsAll = useMemo(() => records.filter((r) => r.recordType !== "FIELD"), [records]);
  const fieldRecordsAll = useMemo(() => records.filter((r) => r.recordType === "FIELD"), [records]);
  const todayOfficeRecord = useMemo(() => latestOf(officeRecordsAll), [officeRecordsAll]);
  const todayFieldRecord = useMemo(() => latestOf(fieldRecordsAll), [fieldRecordsAll]);

  const dateFilteredRecords = useMemo(() => {
    if (!dateFrom && !dateTo) return records;
    const fromMs = dateFrom ? startOfDay(dateFrom) : -Infinity;
    const toMs = dateTo ? endOfDay(dateTo) : Infinity;
    return records.filter((r) => {
      const ts = new Date(r.attendanceDate).getTime();
      return ts >= fromMs && ts <= toMs;
    });
  }, [records, dateFrom, dateTo]);

  const officeRecords = useMemo(
    () => dateFilteredRecords.filter((r) => r.recordType !== "FIELD"),
    [dateFilteredRecords],
  );
  const fieldRecords = useMemo(
    () => dateFilteredRecords.filter((r) => r.recordType === "FIELD"),
    [dateFilteredRecords],
  );

  const filteredFieldRecords = useMemo(() => {
    if (amPmFilter === "ALL") return fieldRecords;
    return fieldRecords.filter((record) => isMorning(record.timeInAt) === (amPmFilter === "AM"));
  }, [fieldRecords, amPmFilter]);

  const isOfficeTab = activeTab === "office";
  const todayRecord = isOfficeTab ? todayOfficeRecord : todayFieldRecord;
  const todayInProgress = Boolean(todayRecord?.timeInAt) && !todayRecord?.timeOutAt;
  const listData = isOfficeTab ? officeRecords : filteredFieldRecords;
  const hasDateFilter = Boolean(dateFrom || dateTo);

  return (
    <>
    <View style={styles.card}>
      {/* Pinned header — title, tabs, today's-hours summary, and filters
          all stay fixed above the list instead of scrolling away with it
          (previously a FlatList ListHeaderComponent, which scrolls with
          the content). Only the record rows below scroll now. */}
      <View style={styles.pinnedHeader}>
        <Text style={styles.cardTitle}>Daily Time Record</Text>

        <SegmentedControl
          segments={[
            { key: "office", label: "Office" },
            { key: "field", label: "Field" },
          ]}
          value={activeTab}
          onChange={(key) => setActiveTab(key as Tab)}
          style={styles.tabSwitcher}
        />

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

        <View style={styles.filterRow}>
          <Pressable
            style={[styles.dateFilterChip, dateFrom && styles.dateFilterChipActive]}
            onPress={() => setIsFromPickerVisible(true)}
          >
            <Ionicons name="calendar-outline" size={13} color={dateFrom ? "#FFFFFF" : "#1680D8"} />
            <Text style={[styles.dateFilterChipText, dateFrom && styles.dateFilterChipTextActive]} numberOfLines={1}>
              {dateFrom ? formatShortDate(dateFrom) : "From"}
            </Text>
          </Pressable>
          <Pressable
            style={[styles.dateFilterChip, dateTo && styles.dateFilterChipActive]}
            onPress={() => setIsToPickerVisible(true)}
          >
            <Ionicons name="calendar-outline" size={13} color={dateTo ? "#FFFFFF" : "#1680D8"} />
            <Text style={[styles.dateFilterChipText, dateTo && styles.dateFilterChipTextActive]} numberOfLines={1}>
              {dateTo ? formatShortDate(dateTo) : "To"}
            </Text>
          </Pressable>
          {hasDateFilter && (
            <Pressable
              style={styles.dateFilterClear}
              onPress={() => {
                setDateFrom(null);
                setDateTo(null);
              }}
            >
              <Ionicons name="close" size={16} color="#94A3B8" />
            </Pressable>
          )}
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
      </View>

      <DateTimePickerModal
        isVisible={isFromPickerVisible}
        mode="date"
        date={dateFrom ?? new Date()}
        // Can't be later than today (no attendance exists for future dates
        // yet) or later than "To", whichever is earlier.
        maximumDate={dateTo ?? new Date()}
        accentColor={CALENDAR_ACCENT_COLOR}
        themeVariant="light"
        onConfirm={(value) => {
          setDateFrom(value);
          setIsFromPickerVisible(false);
        }}
        onCancel={() => setIsFromPickerVisible(false)}
      />
      <DateTimePickerModal
        isVisible={isToPickerVisible}
        mode="date"
        date={dateTo ?? new Date()}
        minimumDate={dateFrom ?? undefined}
        // No attendance exists for future dates yet, so "To" can never be
        // set past today either.
        maximumDate={new Date()}
        accentColor={CALENDAR_ACCENT_COLOR}
        themeVariant="light"
        onConfirm={(value) => {
          setDateTo(value);
          setIsToPickerVisible(false);
        }}
        onCancel={() => setIsToPickerVisible(false)}
      />

    <FlatList
      style={styles.list}
      data={listData}
      keyExtractor={(item) => item.id}
      refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} colors={["#1680D8"]} />}
      ListEmptyComponent={
        !isLoading ? (
          <View style={styles.emptyState}>
            <Ionicons name="document-text-outline" size={36} color="#CBD5E1" />
            <Text style={styles.emptyText}>
              {hasDateFilter
                ? "No attendance records in this date range."
                : isOfficeTab
                  ? "No office attendance records yet."
                  : "No visit records yet."}
            </Text>
          </View>
        ) : null
      }
      contentContainerStyle={styles.listContent}
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

            {isOfficeTab && item.lunchOutAt && (
              <View style={styles.lunchRow}>
                <Ionicons name="cafe-outline" size={13} color="#EA580C" />
                <Text style={styles.lunchRowText}>
                  Lunch: {formatTime(item.lunchOutAt)} – {formatTime(item.lunchInAt ?? null)}
                </Text>
              </View>
            )}
          </Pressable>
        );
      }}
    />
    </View>

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

          <SegmentedControl
            segments={[
              { key: "TIME_IN", label: photoTabLabel("TIME_IN", isOfficeTab) },
              ...(isOfficeTab ? [{ key: "LUNCH_OUT", label: "Lunch Start" }] : []),
              ...(isOfficeTab ? [{ key: "LUNCH_IN", label: "Lunch End" }] : []),
              { key: "TIME_OUT", label: photoTabLabel("TIME_OUT", isOfficeTab) },
            ]}
            value={photoTab}
            onChange={(key) => setPhotoTab(key as typeof photoTab)}
            style={styles.photoTabSwitcher}
          />

          {(() => {
            const log = selectedRecord?.logs.find((l) => l.logType === photoTab);
            const uri = log ? photoUri(log) : null;
            const photoStampTiles = log ? buildPhotoStampTiles(log.latitude, log.longitude) : [];
            return (
              <View style={styles.modalPhotoBlock}>
                {uri ? (
                  <ImageBackground source={{ uri }} style={styles.modalPhoto} resizeMode="contain">
                    <View style={styles.photoStamp}>
                      <View style={styles.photoStampMap}>
                        {photoStampTiles.map((tile) => (
                          <Image key={tile.key} source={{ uri: tile.url }} style={[styles.photoStampTile, tile]} />
                        ))}
                        <Ionicons name="location" size={26} color="#DC2626" style={styles.photoStampPin} />
                      </View>
                      <View style={styles.photoStampText}>
                        <View style={styles.photoStampTimeBadge}>
                          <Text style={styles.photoStampTimeText}>
                            {photoTabLabel(photoTab, isOfficeTab).toUpperCase()} · {formatPhotoStampTime(log!.capturedAt)}
                          </Text>
                        </View>
                        <Text style={styles.photoStampLocationText} numberOfLines={2}>
                          {photoStampAddress ?? "Locating..."}
                        </Text>
                      </View>
                    </View>
                  </ImageBackground>
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
  // Outer card border/background — previously on the FlatList's own
  // contentContainerStyle (listContainer), which meant it only wrapped
  // scrollable content. Now a real sibling wrapper around both the pinned
  // header and the FlatList, so the card look is unchanged even though the
  // header no longer scrolls with the list inside it.
  card: {
    flex: 1,
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#dbe5ef",
  },
  // Title, tabs, summary card, and filters — fixed above the list, not part
  // of the FlatList's scrollable content.
  pinnedHeader: {
    padding: 18,
    paddingBottom: 0,
  },
  list: {
    flex: 1,
  },
  listContent: {
    padding: 18,
    paddingTop: 4,
    flexGrow: 1,
  },
  cardTitle: {
    color: "#062b59",
    fontSize: 18,
    fontWeight: "900",
    marginBottom: 14,
  },
  tabSwitcher: {
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
  // Blue-tinted (matches the summary card above and the app's accent color)
  // rather than the plain gray of the AM/PM chips, so the date filter reads
  // as its own distinct control — and, unlike before, actually has a
  // matching active-state background instead of leaving white text sitting
  // on the same light gray fill.
  dateFilterChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: "#EFF6FF",
  },
  dateFilterChipActive: {
    backgroundColor: "#1680D8",
  },
  dateFilterChipText: {
    color: "#1680D8",
    fontSize: 12,
    fontWeight: "700",
  },
  dateFilterChipTextActive: {
    color: "#FFFFFF",
  },
  dateFilterClear: {
    alignItems: "center",
    justifyContent: "center",
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#F1F5F9",
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
  lunchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginTop: 8,
  },
  lunchRowText: {
    color: "#9A3412",
    fontSize: 12,
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
    marginBottom: 14,
  },
  modalPhotoBlock: {
    gap: 8,
    marginBottom: 14,
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
  photoStamp: {
    position: "absolute",
    left: 10,
    right: 10,
    bottom: 10,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
  },
  photoStampMap: {
    width: 56,
    height: 56,
    borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.94)",
    borderWidth: 2,
    borderColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    position: "relative",
  },
  photoStampTile: {
    position: "absolute",
    width: PHOTO_STAMP_TILE_SIZE,
    height: PHOTO_STAMP_TILE_SIZE,
  },
  photoStampPin: {
    position: "absolute",
    left: PHOTO_STAMP_MAP_SIZE / 2 - 13,
    top: PHOTO_STAMP_MAP_SIZE / 2 - 21,
    textShadowColor: "#FFFFFF",
    textShadowRadius: 3,
    textShadowOffset: { width: 0, height: 0 },
  },
  photoStampText: {
    flex: 1,
    gap: 4,
  },
  photoStampTimeBadge: {
    alignSelf: "flex-start",
    backgroundColor: "#DC2626",
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 4,
  },
  photoStampTimeText: {
    color: "#FFFFFF",
    fontSize: 10,
    fontWeight: "800",
  },
  photoStampLocationText: {
    color: "#FFFFFF",
    fontSize: 11,
    fontWeight: "700",
    lineHeight: 14,
    textShadowColor: "rgba(0,0,0,0.9)",
    textShadowRadius: 4,
    textShadowOffset: { width: 0, height: 1 },
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
