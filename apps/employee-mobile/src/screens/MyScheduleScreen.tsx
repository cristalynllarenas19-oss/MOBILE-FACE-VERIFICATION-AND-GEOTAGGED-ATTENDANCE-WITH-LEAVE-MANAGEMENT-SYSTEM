import React, { useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { EmployeeProfile, MySchedule, getMyProfile, getMySchedules } from "../api";
import { CACHE_KEYS, useCachedData } from "../utils/dataCache";
import EmptyState from "../components/EmptyState";

type Props = {
  onClose: () => void;
};

// Single letters fit the hero card's compact mini-row dots.
const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
// Two letters for the calendar's header row, so Sunday and Saturday don't
// both render as an ambiguous "S" there.
const CALENDAR_WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function toDateOnly(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatDate(value?: string | null) {
  return value
    ? new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
    : "Present";
}

// "08:00" -> "8:00 AM" — only used for the hero time range, where it reads
// better than the 24h strings shown elsewhere (shift management, supervisor
// views, etc).
function formatShiftTime(value: string) {
  const [h, m] = value.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const displayHour = h % 12 === 0 ? 12 : h % 12;
  return `${displayHour}:${String(m).padStart(2, "0")} ${period}`;
}

// Which (if any) of the employee's schedule assignments covers this date.
// Assignments shouldn't overlap in practice, but schedules is sorted
// startsOn-desc, so the most recently-started match wins if they ever do.
function scheduleForDate(schedules: MySchedule[], date: Date) {
  return schedules.find((schedule) => {
    const start = toDateOnly(new Date(schedule.startsOn));
    if (date < start) return false;
    if (!schedule.endsOn) return true;
    return date <= toDateOnly(new Date(schedule.endsOn));
  });
}

// Sunday is a fixed company-wide rest day for every role (see
// schedules.service.ts's assertValidWorkingDays) regardless of whether a
// schedule assignment happens to be on file for that date — so it always
// plots as a (legible) day off rather than falling through to the muted
// "no schedule" treatment.
function dayKind(schedules: MySchedule[], date: Date): "working" | "off" | "none" {
  if (date.getDay() === 0) return "off";
  const schedule = scheduleForDate(schedules, date);
  if (!schedule) return "none";
  return schedule.workingDays.includes(date.getDay()) ? "working" : "off";
}

export default function MyScheduleScreen({ onClose }: Props) {
  // Same cache key as ViewProfileScreen/SettingsScreen — reuses whatever
  // profile is already cached just to read the employee id, no extra fetch.
  const { data: profile } = useCachedData<EmployeeProfile>(CACHE_KEYS.myProfile, getMyProfile);
  const employeeId = profile?.id;

  const { data, isLoading } = useCachedData<MySchedule[]>(
    employeeId ? CACHE_KEYS.mySchedules(employeeId) : null,
    () => getMySchedules(),
  );
  const schedules = data ?? [];

  const today = toDateOnly(new Date());
  const [viewMonth, setViewMonth] = useState(() => toDateOnly(new Date()));

  // The shift summary card up top always reflects "today's" assignment (or
  // the most recent one, if today happens to fall outside every range) —
  // independent of whatever month the calendar below is scrolled to.
  const currentSchedule = useMemo(
    () => scheduleForDate(schedules, today) ?? schedules[0],
    [schedules, today],
  );

  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const leadingBlanks = firstOfMonth.getDay();

  const cells: Array<{ date: Date } | null> = [];
  for (let i = 0; i < leadingBlanks; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push({ date: new Date(year, month, day) });

  function changeMonth(delta: number) {
    setViewMonth(new Date(year, month + delta, 1));
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={onClose} style={styles.backButton} hitSlop={10}>
          <Ionicons name="chevron-back" size={24} color="#062B59" />
        </Pressable>
        <Text style={styles.title}>My Schedule</Text>
        <View style={styles.headerSpacer} />
      </View>

      {isLoading ? (
        <ActivityIndicator size="large" color="#1680D8" style={{ marginTop: 20 }} />
      ) : schedules.length === 0 ? (
        <EmptyState
          icon="calendar-outline"
          title="No active schedule"
          message="You don't have a shift schedule assigned yet. Contact HR/Admin if this doesn't look right."
        />
      ) : (
        <View style={styles.list}>
          {currentSchedule && (
            <View style={styles.shiftCard}>
              <View style={styles.shiftCardHeaderRow}>
                <Text style={styles.shiftCardEyebrow}>CURRENT SCHEDULE</Text>
                <View style={styles.shiftNameBadge}>
                  <Ionicons name="briefcase-outline" size={11} color="#1680D8" />
                  <Text style={styles.shiftNameBadgeText}>{currentSchedule.shift.name}</Text>
                </View>
              </View>

              <Text style={styles.shiftTimeHero}>
                {formatShiftTime(currentSchedule.shift.startTime)} – {formatShiftTime(currentSchedule.shift.endTime)}
              </Text>

              <View style={styles.weekMiniRow}>
                {WEEKDAY_LABELS.map((label, day) => {
                  const isWorking = currentSchedule.workingDays.includes(day);
                  return (
                    <View key={day} style={[styles.weekMiniDot, isWorking && styles.weekMiniDotActive]}>
                      <Text style={[styles.weekMiniDotText, isWorking && styles.weekMiniDotTextActive]}>{label}</Text>
                    </View>
                  );
                })}
              </View>

              <View style={styles.shiftCardDivider} />

              <View style={styles.shiftEffectiveRow}>
                <Ionicons name="calendar-outline" size={14} color="#94A3B8" />
                <Text style={styles.dateText}>
                  Effective {formatDate(currentSchedule.startsOn)} → {formatDate(currentSchedule.endsOn)}
                </Text>
              </View>
            </View>
          )}

          <View style={styles.calendarCard}>
            <View style={styles.monthRow}>
              <Pressable onPress={() => changeMonth(-1)} style={styles.navButton} hitSlop={8}>
                <Ionicons name="chevron-back" size={20} color="#062B59" />
              </Pressable>
              <Text style={styles.monthLabel}>{MONTH_LABELS[month]} {year}</Text>
              <Pressable onPress={() => changeMonth(1)} style={styles.navButton} hitSlop={8}>
                <Ionicons name="chevron-forward" size={20} color="#062B59" />
              </Pressable>
            </View>

            <View style={styles.weekdayRow}>
              {CALENDAR_WEEKDAY_LABELS.map((label, i) => (
                <Text key={i} style={styles.weekdayLabel}>{label}</Text>
              ))}
            </View>

            <View style={styles.grid}>
              {cells.map((cell, index) => {
                if (!cell) return <View key={index} style={styles.cell} />;
                const { date } = cell;
                const kind = dayKind(schedules, date);
                const isToday = isSameDay(date, today);
                return (
                  <View key={index} style={styles.cell}>
                    <View
                      style={[
                        styles.dayCircle,
                        kind === "working" && styles.dayCircleWorking,
                        kind === "off" && styles.dayCircleOff,
                        isToday && styles.dayCircleToday,
                      ]}
                    >
                      <Text
                        style={[
                          styles.dayText,
                          kind === "working" ? styles.dayTextWorking : kind === "off" ? styles.dayTextOff : styles.dayTextMuted,
                        ]}
                      >
                        {date.getDate()}
                      </Text>
                    </View>
                  </View>
                );
              })}
            </View>

            <View style={styles.legendRow}>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: "#062B59" }]} />
                <Text style={styles.legendText}>Working day</Text>
              </View>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: "#FEF3C7" }]} />
                <Text style={styles.legendText}>Day off</Text>
              </View>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: "#E2E8F0" }]} />
                <Text style={styles.legendText}>No schedule</Text>
              </View>
            </View>
          </View>

          <Text style={styles.note}>
            This is managed by HR/Admin. Contact HR/Admin if your schedule needs to be updated.
          </Text>
        </View>
      )}
    </View>
  );
}

const cardShadow = {
  shadowColor: "#0F172A",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.06,
  shadowRadius: 8,
  elevation: 2,
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#FFFFFF", paddingHorizontal: 20, paddingTop: 4, paddingBottom: 12 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  backButton: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center", backgroundColor: "#F1F5F9" },
  // Balances the back button's width so the title sits truly centered.
  headerSpacer: { width: 34 },
  title: { fontSize: 16, fontWeight: "700", color: "#062B59" },
  list: { gap: 10 },

  shiftCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    padding: 12,
    ...cardShadow,
  },
  shiftCardHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  shiftCardEyebrow: {
    fontSize: 10,
    fontWeight: "700",
    color: "#94A3B8",
    letterSpacing: 0.6,
  },
  shiftNameBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#EFF6FF",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  shiftNameBadgeText: { fontSize: 10.5, color: "#1680D8", fontWeight: "700" },
  // The hero: this is what the whole card exists to show, so it's the
  // single biggest, boldest thing on it.
  shiftTimeHero: { fontSize: 22, fontWeight: "800", color: "#062B59", marginTop: 4, letterSpacing: -0.5, textAlign: "center" },
  weekMiniRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 8 },
  weekMiniDot: {
    width: 24,
    height: 24,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F1F5F9",
  },
  weekMiniDotActive: { backgroundColor: "#062B59" },
  weekMiniDotText: { fontSize: 10, fontWeight: "700", color: "#94A3B8" },
  weekMiniDotTextActive: { color: "#FFFFFF" },
  shiftCardDivider: { height: 1, backgroundColor: "#F1F5F9", marginTop: 8, marginBottom: 6 },
  shiftEffectiveRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
  dateText: { fontSize: 11, color: "#64748B" },

  calendarCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    padding: 12,
    ...cardShadow,
  },
  monthRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
  navButton: { padding: 2 },
  monthLabel: { fontSize: 13, fontWeight: "700", color: "#062B59" },
  weekdayRow: { flexDirection: "row" },
  weekdayLabel: { flex: 1, textAlign: "center", fontSize: 10, fontWeight: "700", color: "#94A3B8", marginBottom: 2 },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  // Flatter than square so six rows of weeks reliably fit without the
  // screen having to scroll.
  cell: { width: `${100 / 7}%`, aspectRatio: 0.7, alignItems: "center", justifyContent: "center" },
  dayCircle: { width: 26, height: 26, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  dayCircleWorking: { backgroundColor: "#062B59" },
  dayCircleOff: { backgroundColor: "#FEF3C7" },
  // Today's ring layers on top of whichever fill (or none) the day already
  // has — doesn't replace the working/off/no-schedule color coding.
  dayCircleToday: { borderWidth: 2, borderColor: "#1680D8" },
  dayText: { fontSize: 12, color: "#334155", fontWeight: "600" },
  dayTextWorking: { color: "#FFFFFF" },
  dayTextOff: { color: "#D97706" },
  dayTextMuted: { color: "#CBD5E1" },

  legendRow: { flexDirection: "row", justifyContent: "center", gap: 14, marginTop: 6, flexWrap: "wrap" },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  legendDot: { width: 9, height: 9, borderRadius: 4.5 },
  legendText: { fontSize: 10.5, color: "#64748B" },

  note: {
    marginTop: 0,
    fontSize: 11,
    color: "#94A3B8",
    textAlign: "center",
    lineHeight: 15,
  },
});
