import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Modal } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Svg, { Circle } from "react-native-svg";
import { DashboardSummary, TeamAttendanceRecord, getDashboardSummary, getTeamAttendance } from "../../api";
import { useCachedData } from "../../utils/dataCache";
import Avatar from "../../components/Avatar";
import AestheticScrollView from "../../components/AestheticScrollView";
import { CARD_SHADOW, ui } from "../../styles/ui";

type Props = {
  departmentName?: string;
};

type CalendarDay = DashboardSummary["calendar"]["days"][number];

const RING_SIZE = 78;
const RING_STROKE = 10;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

// The four rows of the attendance card. Each one opens the list of people
// behind its number.
type DayStatus = "PRESENT" | "LATE" | "ABSENT" | "ON_LEAVE";

const STATUS_ROWS: { status: DayStatus; label: string; color: string; tint: string }[] = [
  { status: "PRESENT", label: "Present", color: "#1BAF7A", tint: "#ECFDF3" },
  { status: "LATE", label: "Late", color: "#EDA100", tint: "#FFFBEB" },
  { status: "ABSENT", label: "Absent", color: "#E34948", tint: "#FEF2F2" },
  { status: "ON_LEAVE", label: "On leave", color: "#7C3AED", tint: "#F5F3FF" },
];

function formatTime(value?: string | null) {
  return value ? new Date(value).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : null;
}

function KpiChip({ icon, label, value, tint }: { icon: keyof typeof Ionicons.glyphMap; label: string; value: number | string; tint: string }) {
  return (
    <View style={styles.kpiChip}>
      <View style={styles.kpiTopRow}>
        <View style={[styles.kpiIconWrap, { backgroundColor: `${tint}17` }]}>
          <Ionicons name={icon} size={15} color={tint} />
        </View>
        <Text style={styles.kpiValue} numberOfLines={1}>{value}</Text>
      </View>
      <Text style={styles.kpiLabel} numberOfLines={1}>{label}</Text>
    </View>
  );
}

function hasAttendanceData(day: CalendarDay) {
  return (day.present ?? 0) + (day.late ?? 0) + (day.absent ?? 0) + (day.onLeave ?? 0) > 0;
}

// A day cell is tinted by how much of the team was accounted for that day:
// green when nearly everyone logged in, amber when some did not, red when
// most did not. Rest days and days that have not happened yet carry no
// judgement — they read as plain slots.
function dayTone(day: CalendarDay) {
  if (day.isDayOff) return { backgroundColor: "#F1F5F9", color: "#94A3B8" };
  if (!hasAttendanceData(day)) return { backgroundColor: "#FFFFFF", color: "#CBD5E1" };
  const accounted = (day.present ?? 0) + (day.late ?? 0) + (day.onLeave ?? 0);
  const rate = accounted / (accounted + (day.absent ?? 0));
  if (rate >= 0.9) return { backgroundColor: "#DCFCE7", color: "#15803D" };
  if (rate >= 0.7) return { backgroundColor: "#FEF3C7", color: "#B45309" };
  return { backgroundColor: "#FEE2E2", color: "#B91C1C" };
}

export default function SupervisorDashboardScreen({ departmentName }: Props) {
  const [isRefreshing, setIsRefreshing] = useState(false);

  const { data: summary, isLoading, refresh } = useCachedData<DashboardSummary>(
    "supervisor-dashboard",
    () => getDashboardSummary(),
  );

  const load = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setIsRefreshing(true);
      try {
        await refresh();
      } catch (error) {
        console.error("Failed to load dashboard summary", error);
      } finally {
        setIsRefreshing(false);
      }
    },
    [refresh],
  );

  const now = new Date();
  const todayDayOfMonth = now.getDate();

  // The month the calendar card is showing, paged with its two arrows.
  const [viewed, setViewed] = useState(() => ({ year: now.getFullYear(), month: now.getMonth() }));
  const year = viewed.year;
  const month = viewed.month;
  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth();

  // The day picked on the calendar, which the attendance card then
  // describes. Null means "today" — the card's resting state.
  const [selectedDayNumber, setSelectedDayNumber] = useState<number | null>(null);
  // Whether the attendance card was tapped open into the full list of
  // everyone on the shown date.
  const [isDayOpen, setIsDayOpen] = useState(false);
  const [dayPeople, setDayPeople] = useState<{ dateKey: string; records: TeamAttendanceRecord[] } | null>(null);
  const [peopleError, setPeopleError] = useState(false);

  // Another month is its own request (and its own cache entry, so paging
  // back to a month already seen is instant); the current month reuses the
  // summary this screen already loaded.
  const { data: otherMonth, isLoading: isOtherMonthLoading } = useCachedData<DashboardSummary>(
    isCurrentMonth ? null : `supervisor-dashboard:${year}-${month}`,
    () => getDashboardSummary(month, year),
  );
  const calendarSummary = isCurrentMonth ? summary : otherMonth;
  const calendarDays = calendarSummary?.calendar.days;
  const isCalendarLoading = !isCurrentMonth && isOtherMonthLoading && !otherMonth;
  const monthTitle = new Date(year, month, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });

  function shiftMonth(delta: number) {
    setSelectedDayNumber(null);
    setViewed((current) => {
      const next = new Date(current.year, current.month + delta, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
  }

  function backToToday() {
    setSelectedDayNumber(null);
    setViewed({ year: now.getFullYear(), month: now.getMonth() });
  }

  // Whole weeks, Sunday first, padded with empty slots — rendered as equal
  // flex rows so the grid fills whatever height the screen has left instead
  // of forcing the dashboard to scroll. The weekday the 1st falls on comes
  // from this device's own calendar rather than from parsing the server's
  // serialized dates (which shift a day across timezones).
  const weeks = useMemo(() => {
    const days = calendarDays ?? [];
    if (days.length === 0) return [] as (CalendarDay | null)[][];
    const slots: (CalendarDay | null)[] = [
      ...Array.from({ length: new Date(year, month, 1).getDay() }, () => null),
      ...days,
    ];
    while (slots.length % 7 !== 0) slots.push(null);
    const rows: (CalendarDay | null)[][] = [];
    for (let index = 0; index < slots.length; index += 7) rows.push(slots.slice(index, index + 7));
    return rows;
  }, [calendarDays, year, month]);

  const selectedDay = selectedDayNumber === null ? null : calendarDays?.find((day) => day.day === selectedDayNumber) ?? null;
  const isShowingToday = !selectedDay || (isCurrentMonth && selectedDay.day === todayDayOfMonth);
  const shownDate = isShowingToday ? now : new Date(year, month, selectedDay!.day);
  const shownDateKey = `${shownDate.getFullYear()}-${String(shownDate.getMonth() + 1).padStart(2, "0")}-${String(shownDate.getDate()).padStart(2, "0")}`;

  // The summary only carries counts. The names come from that date's
  // attendance list, which rebuilds absentees and people on leave for a
  // single day the same way admin-web's Attendance page does. Loaded when
  // the card is opened, and kept until a different date is asked for.
  useEffect(() => {
    if (!isDayOpen || dayPeople?.dateKey === shownDateKey) return;
    let cancelled = false;
    setPeopleError(false);
    getTeamAttendance({ date: shownDateKey })
      .then((records) => {
        if (!cancelled) setDayPeople({ dateKey: shownDateKey, records });
      })
      .catch(() => {
        if (!cancelled) setPeopleError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isDayOpen, shownDateKey, dayPeople?.dateKey]);

  // Everyone on the shown date, grouped under the same four statuses the
  // card counts. One row per person per group: a field employee with
  // several visits in a day has several records, but is still one present
  // employee.
  const peopleByStatus = useMemo(() => {
    if (dayPeople?.dateKey !== shownDateKey) return null;
    return STATUS_ROWS.map((row) => {
      const seen = new Set<string>();
      const records = dayPeople.records.filter((record) => {
        if (record.status !== row.status) return false;
        const key = record.employee.employeeNo ?? `${record.employee.firstName} ${record.employee.lastName}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return { ...row, records };
    });
  }, [dayPeople, shownDateKey]);

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#062B59" size="large" />
      </View>
    );
  }

  const stats = summary?.stats ?? {
    totalEmployees: 0,
    presentToday: 0,
    lateToday: 0,
    absentToday: 0,
    pendingLeaves: 0,
    geotaggedLogs: 0,
  };
  const onLeaveToday = summary?.calendar.days.find((day) => day.day === todayDayOfMonth)?.onLeave ?? 0;

  // What the attendance card shows: today's live numbers by default, or the
  // counts of whichever day was tapped on the calendar.
  const counts: Record<DayStatus, number> = isShowingToday
    ? { PRESENT: stats.presentToday, LATE: stats.lateToday, ABSENT: stats.absentToday, ON_LEAVE: onLeaveToday }
    : {
        PRESENT: selectedDay!.present ?? 0,
        LATE: selectedDay!.late ?? 0,
        ABSENT: selectedDay!.absent ?? 0,
        ON_LEAVE: selectedDay!.onLeave ?? 0,
      };
  const countedTotal = counts.PRESENT + counts.LATE + counts.ABSENT + counts.ON_LEAVE;
  // Today is measured against the whole team, so people who have not logged
  // yet show as the unfilled part of the ring; a past day is already final.
  const ringTotal = isShowingToday ? Math.max(stats.totalEmployees, countedTotal) : countedTotal;
  const attended = counts.PRESENT + counts.LATE;
  const attendedPct = ringTotal > 0 ? Math.round((attended / ringTotal) * 100) : 0;

  let cumulativeOffset = 0;
  const ringSegments =
    ringTotal > 0
      ? STATUS_ROWS.filter((row) => counts[row.status] > 0).map((row) => {
          const length = (counts[row.status] / ringTotal) * RING_CIRCUMFERENCE;
          const offset = cumulativeOffset;
          cumulativeOffset += length;
          return { key: row.status, color: row.color, length, offset };
        })
      : [];

  const cardTitle = isShowingToday
    ? "Today's Attendance"
    : shownDate.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const emptyCardText = isShowingToday
    ? "No employees in this department yet."
    : selectedDay?.isDayOff
      ? "Rest day — no attendance is expected."
      : shownDate.getTime() > now.getTime()
        ? "This day has not happened yet."
        : "No attendance was recorded for this day.";
  const listedCount = peopleByStatus?.reduce((sum, group) => sum + group.records.length, 0) ?? 0;

  return (
    <View style={styles.container}>
      <View style={styles.heroCard}>
        <View style={styles.heroIconWrap}>
          <Ionicons name="business" size={19} color="#FFFFFF" />
        </View>
        <View style={styles.heroTextCol}>
          <Text style={styles.heroTitle} numberOfLines={1}>{departmentName ?? "Your Team"}</Text>
          <Text style={styles.heroSubtitle} numberOfLines={1}>{summary?.calendar.monthLabel ?? "This month"}</Text>
        </View>
        <Pressable
          style={({ pressed }) => [styles.refreshButton, pressed && styles.refreshButtonPressed]}
          onPress={() => load(true)}
          disabled={isRefreshing}
          hitSlop={8}
        >
          {isRefreshing ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Ionicons name="refresh" size={17} color="#FFFFFF" />}
        </Pressable>
      </View>

      <View style={styles.kpiRow}>
        <KpiChip icon="people" label="Employees" value={stats.totalEmployees} tint="#1680D8" />
        <KpiChip icon="calendar" label="Pending" value={stats.pendingLeaves} tint="#7C3AED" />
        <KpiChip icon="person-remove-outline" label="On leave" value={onLeaveToday} tint="#0EA5E9" />
      </View>

      {/* Describes today until a day is tapped on the calendar below, then
          that day. Tapping the card opens everyone on that date. */}
      <Pressable
        style={({ pressed }) => [styles.card, pressed && ringTotal > 0 && styles.cardPressed]}
        disabled={ringTotal === 0}
        onPress={() => setIsDayOpen(true)}
      >
        <View style={styles.cardHeaderRow}>
          <Text style={styles.cardTitle} numberOfLines={1}>{cardTitle}</Text>
          {ringTotal > 0 && <Text style={styles.cardSubtleLabel}>{attendedPct}% attended</Text>}
          {!isShowingToday && (
            <Pressable style={styles.todayChip} onPress={backToToday} hitSlop={6}>
              <Text style={styles.todayChipText}>Today</Text>
            </Pressable>
          )}
        </View>

        {ringTotal === 0 ? (
          <Text style={styles.emptyText}>{emptyCardText}</Text>
        ) : (
          <View style={styles.ringRow}>
            <View style={styles.ringWrap}>
              <Svg width={RING_SIZE} height={RING_SIZE}>
                <Circle cx={RING_SIZE / 2} cy={RING_SIZE / 2} r={RING_RADIUS} fill="none" stroke="#F1F5F9" strokeWidth={RING_STROKE} />
                {ringSegments.map((segment) => (
                  <Circle
                    key={segment.key}
                    cx={RING_SIZE / 2}
                    cy={RING_SIZE / 2}
                    r={RING_RADIUS}
                    fill="none"
                    stroke={segment.color}
                    strokeWidth={RING_STROKE}
                    strokeDasharray={`${segment.length} ${RING_CIRCUMFERENCE - segment.length}`}
                    strokeDashoffset={-segment.offset}
                    strokeLinecap="butt"
                    transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
                  />
                ))}
              </Svg>
              <View style={styles.ringCenter}>
                <Text style={styles.ringValue} numberOfLines={1} adjustsFontSizeToFit>{attended}</Text>
                <Text style={styles.ringLabel} numberOfLines={1}>of {ringTotal}</Text>
              </View>
            </View>

            <View style={styles.legendCol}>
              {STATUS_ROWS.map((row) => (
                <View key={row.status} style={styles.legendRow}>
                  <View style={[styles.legendDot, { backgroundColor: row.color }]} />
                  <Text style={styles.legendLabel} numberOfLines={1}>{row.label}</Text>
                  <Text style={styles.legendValue}>{counts[row.status]}</Text>
                </View>
              ))}
            </View>
            <Ionicons name="chevron-forward" size={18} color="#CBD5E1" />
          </View>
        )}
        {ringTotal > 0 && <Text style={styles.cardFootHint}>Tap to see everyone on this date</Text>}
      </Pressable>

      {/* The month at a glance, from the same calendar data admin-web's
          dashboard charts. This card takes whatever height is left, so the
          whole dashboard fits one screen with nothing to scroll. */}
      <View style={[styles.card, styles.calendarCard]}>
        <View style={styles.monthNav}>
          <Pressable
            style={({ pressed }) => [styles.monthNavButton, pressed && styles.pressed]}
            onPress={() => shiftMonth(-1)}
            hitSlop={8}
          >
            <Ionicons name="chevron-back" size={16} color="#062B59" />
          </Pressable>
          <View style={styles.monthNavTitle}>
            <Text style={styles.monthTitle} numberOfLines={1}>{monthTitle}</Text>
            <Text style={styles.cardHint}>Tap a day to see it above</Text>
          </View>
          <Pressable
            style={({ pressed }) => [styles.monthNavButton, pressed && styles.pressed]}
            onPress={() => shiftMonth(1)}
            hitSlop={8}
          >
            <Ionicons name="chevron-forward" size={16} color="#062B59" />
          </Pressable>
        </View>

        {isCalendarLoading ? (
          <View style={styles.calendarLoading}>
            <ActivityIndicator color="#062B59" />
          </View>
        ) : weeks.length === 0 ? (
          <Text style={styles.emptyText}>No attendance recorded for this month.</Text>
        ) : (
          <>
            <View style={styles.weekLabelRow}>
              {WEEKDAY_LABELS.map((label, index) => (
                <Text key={`${label}-${index}`} style={styles.weekLabel}>
                  {label}
                </Text>
              ))}
            </View>

            <View style={styles.calendarGrid}>
              {weeks.map((week, weekIndex) => (
                <View key={weekIndex} style={styles.weekRow}>
                  {week.map((day, dayIndex) => {
                    if (!day) return <View key={`blank-${dayIndex}`} style={styles.dayCellSpacer} />;
                    const tone = dayTone(day);
                    const isToday = isCurrentMonth && day.day === todayDayOfMonth;
                    const isSelected = selectedDayNumber === day.day;
                    return (
                      <Pressable
                        key={day.day}
                        style={({ pressed }) => [
                          styles.dayCell,
                          { backgroundColor: tone.backgroundColor },
                          isToday && styles.dayCellToday,
                          isSelected && styles.dayCellSelected,
                          pressed && styles.pressed,
                        ]}
                        onPress={() => setSelectedDayNumber(isSelected ? null : day.day)}
                      >
                        <Text style={[styles.dayCellText, { color: isSelected ? "#FFFFFF" : tone.color }]}>{day.day}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              ))}
            </View>

            <View style={styles.calendarLegend}>
              <View style={styles.calendarLegendItem}>
                <View style={[styles.legendDot, { backgroundColor: "#86EFAC" }]} />
                <Text style={styles.calendarLegendText}>Full</Text>
              </View>
              <View style={styles.calendarLegendItem}>
                <View style={[styles.legendDot, { backgroundColor: "#FCD34D" }]} />
                <Text style={styles.calendarLegendText}>Partial</Text>
              </View>
              <View style={styles.calendarLegendItem}>
                <View style={[styles.legendDot, { backgroundColor: "#FCA5A5" }]} />
                <Text style={styles.calendarLegendText}>Mostly absent</Text>
              </View>
              <View style={styles.calendarLegendItem}>
                <View style={[styles.legendDot, { backgroundColor: "#CBD5E1" }]} />
                <Text style={styles.calendarLegendText}>Rest day</Text>
              </View>
            </View>
          </>
        )}
      </View>

      <Modal visible={isDayOpen} transparent animationType="fade" onRequestClose={() => setIsDayOpen(false)}>
        <View style={ui.modalOverlay}>
          <View style={[ui.modalCard, styles.dayDialog]}>
            <Text style={ui.modalTitle}>
              {shownDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
            </Text>

            {/* The same four numbers as the card, so the list below reads
                as their breakdown. */}
            <View style={styles.daySummaryRow}>
              {STATUS_ROWS.map((row) => (
                <View key={row.status} style={[styles.daySummaryTile, { backgroundColor: row.tint }]}>
                  <Text style={[styles.daySummaryValue, { color: row.color }]}>{counts[row.status]}</Text>
                  <Text style={styles.daySummaryLabel} numberOfLines={1}>{row.label}</Text>
                </View>
              ))}
            </View>

            {peopleError ? (
              <View style={ui.emptyState}>
                <Ionicons name="cloud-offline-outline" size={32} color="#DC2626" />
                <Text style={ui.emptyText}>Could not load the list for this day. Close and try again.</Text>
              </View>
            ) : !peopleByStatus ? (
              <View style={styles.peopleLoading}>
                <ActivityIndicator color="#062B59" />
              </View>
            ) : listedCount === 0 ? (
              <View style={ui.emptyState}>
                <Ionicons name="people-outline" size={32} color="#CBD5E1" />
                <Text style={ui.emptyText}>No one to list for this date.</Text>
              </View>
            ) : (
              <AestheticScrollView style={styles.peopleList}>
                {peopleByStatus
                  .filter((group) => group.records.length > 0)
                  .map((group) => (
                    <View key={group.status} style={styles.peopleGroup}>
                      <View style={styles.peopleHeader}>
                        <View style={[styles.legendDot, { backgroundColor: group.color }]} />
                        <Text style={styles.peopleHeaderText}>{group.label}</Text>
                        <Text style={[styles.peopleHeaderCount, { backgroundColor: group.tint }]}>
                          {group.records.length}
                        </Text>
                      </View>
                      {group.records.map((record) => {
                        const timeIn = formatTime(record.timeInAt);
                        const timeOut = formatTime(record.timeOutAt);
                        const lunchOut = formatTime(record.lunchOutAt);
                        const lunchIn = formatTime(record.lunchInAt);
                        const breakWord = record.breakKind === "BREAK" ? "Break" : "Lunch";
                        return (
                          <View key={record.id} style={styles.personRow}>
                            <Avatar firstName={record.employee.firstName} lastName={record.employee.lastName} size={34} />
                            <View style={{ flex: 1, minWidth: 0 }}>
                              <Text style={styles.personName} numberOfLines={1}>
                                {record.employee.firstName} {record.employee.lastName}
                              </Text>
                              <Text style={styles.personMeta} numberOfLines={1}>
                                {[record.employee.position?.title, record.employee.employeeNo].filter(Boolean).join(" · ") || "—"}
                              </Text>
                              {timeIn && (
                                <Text style={styles.personTimes} numberOfLines={1}>
                                  In {timeIn} · Out {timeOut ?? "--:--"}
                                  {lunchOut ? ` · ${breakWord} ${lunchOut} - ${lunchIn ?? "--:--"}` : ""}
                                </Text>
                              )}
                              {record.workLocation?.name && (
                                <Text style={styles.personMeta} numberOfLines={1}>
                                  {record.recordType === "FIELD" ? "Field" : "Non-field"} · {record.workLocation.name}
                                </Text>
                              )}
                            </View>
                          </View>
                        );
                      })}
                    </View>
                  ))}
              </AestheticScrollView>
            )}

            <Pressable style={styles.modalCloseButton} onPress={() => setIsDayOpen(false)}>
              <Text style={styles.modalCloseText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// The employee-facing screens card shadow, shared from styles/ui so every
// card in the app floats the same way instead of this screen keeping its own
// flatter copy.
const cardShadow = CARD_SHADOW;

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  container: { flex: 1 },
  pressed: { opacity: 0.6 },

  heroCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#062B59",
    borderRadius: 18,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 8,
    shadowColor: "#062B59",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 3,
  },
  heroIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  heroTextCol: { flex: 1, minWidth: 0 },
  heroTitle: { color: "#FFFFFF", fontSize: 16, fontWeight: "800" },
  heroSubtitle: { color: "#B9CBE0", fontSize: 12, marginTop: 1 },
  refreshButton: { width: 32, height: 32, borderRadius: 16, backgroundColor: "rgba(255,255,255,0.15)", alignItems: "center", justifyContent: "center" },
  refreshButtonPressed: { opacity: 0.7 },

  kpiRow: { flexDirection: "row", gap: 8, marginBottom: 8 },
  kpiChip: {
    flex: 1,
    minWidth: 0,
    gap: 6,
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    paddingVertical: 10,
    paddingHorizontal: 12,
    ...cardShadow,
  },
  kpiTopRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  kpiIconWrap: { width: 30, height: 30, borderRadius: 10, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  kpiValue: { flexShrink: 1, fontSize: 22, lineHeight: 26, fontWeight: "800", color: "#062B59" },
  kpiLabel: { fontSize: 12, color: "#64748B", fontWeight: "600" },

  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    padding: 12,
    marginBottom: 8,
    ...cardShadow,
  },
  cardHeaderRow: { flexDirection: "row", alignItems: "center", marginBottom: 8, gap: 8 },
  cardTitle: { flex: 1, fontSize: 14, fontWeight: "800", color: "#062B59" },
  cardSubtleLabel: { fontSize: 11, fontWeight: "700", color: "#1BAF7A", flexShrink: 0 },
  cardHint: { fontSize: 10, fontWeight: "600", color: "#94A3B8" },
  todayChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: "#062B59" },
  todayChipText: { fontSize: 10.5, fontWeight: "800", color: "#FFFFFF" },
  emptyText: { fontSize: 12, color: "#94A3B8", textAlign: "center", paddingVertical: 8 },

  ringRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  ringWrap: { width: RING_SIZE, height: RING_SIZE, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  ringCenter: { position: "absolute", alignItems: "center" },
  ringValue: { fontSize: 19, fontWeight: "800", color: "#062B59" },
  ringLabel: { fontSize: 9.5, color: "#64748B", marginTop: 1 },

  legendCol: { flex: 1, minWidth: 0, gap: 6 },
  legendRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  legendDot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  legendLabel: { flex: 1, minWidth: 0, fontSize: 11.5, color: "#475569", fontWeight: "600" },
  legendValue: { fontSize: 12.5, fontWeight: "800", color: "#062B59", flexShrink: 0 },

  // Last card on the screen: it absorbs the remaining height, and the week
  // rows inside split it evenly — no fixed cell size, so nothing overflows
  // on a short phone and nothing leaves a gap on a tall one.
  calendarCard: { flex: 1, minHeight: 0, marginBottom: 0 },
  monthNav: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  monthNavTitle: { flex: 1, alignItems: "center" },
  monthTitle: { fontSize: 14, fontWeight: "800", color: "#062B59" },
  monthNavButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F1F5F9",
  },
  calendarLoading: { flex: 1, alignItems: "center", justifyContent: "center" },
  weekLabelRow: { flexDirection: "row", marginBottom: 4 },
  weekLabel: { flex: 1, textAlign: "center", fontSize: 10, fontWeight: "800", color: "#94A3B8" },
  calendarGrid: { flex: 1, minHeight: 0, gap: 4 },
  weekRow: { flex: 1, flexDirection: "row", gap: 4 },
  dayCell: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: "#F1F5F9",
  },
  dayCellSpacer: { flex: 1 },
  dayCellToday: { borderColor: "#062B59" },
  dayCellSelected: { backgroundColor: "#062B59", borderColor: "#062B59" },
  dayCellText: { fontSize: 11.5, fontWeight: "800" },

  calendarLegend: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", columnGap: 12, rowGap: 4, marginTop: 8 },
  calendarLegendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  calendarLegendText: { fontSize: 10.5, color: "#64748B", fontWeight: "600" },

  peopleHeader: { flexDirection: "row", alignItems: "center", gap: 7, marginBottom: 8 },
  peopleHeaderText: { fontSize: 14, fontWeight: "800", color: "#062B59" },
  peopleHeaderCount: {
    fontSize: 11.5,
    fontWeight: "800",
    color: "#062B59",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    overflow: "hidden",
  },
  peopleLoading: { flex: 1, paddingVertical: 30, alignItems: "center", justifyContent: "center" },
  peopleList: { flex: 1 },
  peopleGroup: { marginBottom: 14 },
  personTimes: { fontSize: 11.5, fontWeight: "700", color: "#334155", marginTop: 2 },
  dayDialog: { height: "86%" },
  daySummaryRow: { flexDirection: "row", gap: 6, marginBottom: 14 },
  daySummaryTile: { flex: 1, borderRadius: 12, paddingVertical: 8, alignItems: "center" },
  daySummaryValue: { fontSize: 18, fontWeight: "900" },
  daySummaryLabel: { fontSize: 10, fontWeight: "700", color: "#64748B", marginTop: 1 },
  cardPressed: { opacity: 0.85 },
  cardFootHint: { fontSize: 10, fontWeight: "600", color: "#94A3B8", textAlign: "center", marginTop: 8 },
  personRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#E2E8F0",
  },
  personName: { fontSize: 13.5, fontWeight: "700", color: "#0F172A" },
  personMeta: { fontSize: 11, fontWeight: "600", color: "#94A3B8", marginTop: 1 },
  modalCloseButton: { marginTop: 16, height: 46, borderRadius: 14, backgroundColor: "#062B59", alignItems: "center", justifyContent: "center" },
  modalCloseText: { color: "#FFFFFF", fontSize: 14, fontWeight: "800" },
});
