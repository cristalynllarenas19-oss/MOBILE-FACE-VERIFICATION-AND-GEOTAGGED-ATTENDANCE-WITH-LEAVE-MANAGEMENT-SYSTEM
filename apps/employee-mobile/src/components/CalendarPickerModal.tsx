import React, { useState } from "react";
import { Modal, View, Text, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";

const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
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

type Props = {
  visible: boolean;
  title: string;
  selectedDate?: Date;
  minimumDate?: Date;
  maximumDate?: Date;
  // Returns a short reason if the date should render disabled (grey, not
  // tappable) — e.g. already covered by a filed leave of this same type.
  isDateDisabled?: (date: Date) => string | undefined;
  // Same shape, checked separately so it gets its own visual treatment (amber
  // "day off", not the red "conflict" used above) — e.g. a weekly rest day or
  // a day outside the employee's own working-days schedule.
  isDateNonWorking?: (date: Date) => string | undefined;
  onSelect: (date: Date) => void;
  onClose: () => void;
};

export default function CalendarPickerModal({
  visible,
  title,
  selectedDate,
  minimumDate,
  maximumDate,
  isDateDisabled,
  isDateNonWorking,
  onSelect,
  onClose,
}: Props) {
  const [viewMonth, setViewMonth] = useState(() => toDateOnly(selectedDate ?? new Date()));

  // Re-anchor to the selected/current month each time the modal opens, so it
  // doesn't reopen wherever the user last scrolled to.
  React.useEffect(() => {
    if (visible) setViewMonth(toDateOnly(selectedDate ?? new Date()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const min = minimumDate ? toDateOnly(minimumDate) : undefined;
  const max = maximumDate ? toDateOnly(maximumDate) : undefined;

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

  const canGoPrev = !min || new Date(year, month, 0) >= min;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <Text style={styles.title}>{title}</Text>

          <View style={styles.monthRow}>
            <Pressable
              onPress={() => canGoPrev && changeMonth(-1)}
              disabled={!canGoPrev}
              style={styles.navButton}
              hitSlop={8}
            >
              <Ionicons name="chevron-back" size={20} color={canGoPrev ? "#062B59" : "#CBD5E1"} />
            </Pressable>
            <Text style={styles.monthLabel}>{MONTH_LABELS[month]} {year}</Text>
            <Pressable onPress={() => changeMonth(1)} style={styles.navButton} hitSlop={8}>
              <Ionicons name="chevron-forward" size={20} color="#062B59" />
            </Pressable>
          </View>

          <View style={styles.weekdayRow}>
            {WEEKDAY_LABELS.map((label, i) => (
              <Text key={i} style={styles.weekdayLabel}>{label}</Text>
            ))}
          </View>

          <View style={styles.grid}>
            {cells.map((cell, index) => {
              if (!cell) return <View key={index} style={styles.cell} />;
              const { date } = cell;
              // Three different reasons a day can't be picked, kept visually
              // distinct: an actual conflict with an existing filed request
              // (red), a day off / non-working day per the employee's own
              // schedule (amber), or simply outside the min/max range, e.g.
              // past what the remaining balance can cover (muted grey —
              // nothing wrong with the date itself, there just isn't enough
              // balance left to reach it).
              const conflictReason = isDateDisabled?.(date);
              const conflict = Boolean(conflictReason);
              const nonWorkingReason = !conflict ? isDateNonWorking?.(date) : undefined;
              const nonWorking = Boolean(nonWorkingReason);
              const outOfRange = !conflict && !nonWorking && ((min && date < min) || (max && date > max));
              const disabled = conflict || nonWorking || outOfRange;
              const selected = selectedDate ? isSameDay(date, selectedDate) : false;
              return (
                <Pressable
                  key={index}
                  style={styles.cell}
                  disabled={disabled}
                  onPress={() => onSelect(date)}
                >
                  <View
                    style={[
                      styles.dayCircle,
                      selected && styles.dayCircleSelected,
                      conflict && styles.dayCircleConflict,
                      nonWorking && styles.dayCircleNonWorking,
                      outOfRange && styles.dayCircleOutOfRange,
                    ]}
                  >
                    <Text
                      style={[
                        styles.dayText,
                        selected && styles.dayTextSelected,
                        conflict && styles.dayTextConflict,
                        nonWorking && styles.dayTextNonWorking,
                        outOfRange && styles.dayTextOutOfRange,
                      ]}
                    >
                      {date.getDate()}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>

          {isDateDisabled && (
            <View style={styles.legendRow}>
              <View style={[styles.legendDot, { backgroundColor: "#FEE2E2" }]} />
              <Text style={styles.legendText}>Already filed for this leave type</Text>
            </View>
          )}
          {isDateNonWorking && (
            <View style={styles.legendRow}>
              <View style={[styles.legendDot, { backgroundColor: "#FEF3C7" }]} />
              <Text style={styles.legendText}>Day off / non-working day</Text>
            </View>
          )}

          <Pressable style={styles.closeButton} onPress={onClose}>
            <Text style={styles.closeButtonText}>Close</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "center", alignItems: "center", padding: 20 },
  card: { width: "100%", maxWidth: 360, backgroundColor: "#FFFFFF", borderRadius: 18, padding: 18 },
  title: { fontSize: 16, fontWeight: "700", color: "#062B59", marginBottom: 12 },
  monthRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  navButton: { padding: 4 },
  monthLabel: { fontSize: 14, fontWeight: "700", color: "#062B59" },
  weekdayRow: { flexDirection: "row" },
  weekdayLabel: { flex: 1, textAlign: "center", fontSize: 11, fontWeight: "700", color: "#94A3B8", marginBottom: 4 },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: { width: `${100 / 7}%`, aspectRatio: 1, alignItems: "center", justifyContent: "center" },
  // Soft card: rounded square instead of a circle, larger touch target, with
  // a soft navy shadow lifting the selected day for depth.
  dayCircle: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  dayCircleSelected: {
    backgroundColor: "#062B59",
    shadowColor: "#062B59",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.32,
    shadowRadius: 8,
    elevation: 4,
  },
  // Actual conflict with an existing filed request — matches the legend.
  dayCircleConflict: { backgroundColor: "#FEE2E2" },
  // Day off / non-working day per the employee's own schedule — amber,
  // distinct from both the red conflict and the muted out-of-range grey.
  dayCircleNonWorking: { backgroundColor: "#FEF3C7" },
  // Simply outside the min/max range (e.g. no remaining balance to cover
  // it) — muted, not red, since nothing about the date itself is a
  // conflict.
  dayCircleOutOfRange: { backgroundColor: "transparent" },
  dayText: { fontSize: 13, color: "#334155", fontWeight: "600" },
  dayTextSelected: { color: "#FFFFFF" },
  dayTextConflict: { color: "#FCA5A5" },
  dayTextNonWorking: { color: "#D97706" },
  dayTextOutOfRange: { color: "#CBD5E1" },
  legendRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 12 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendText: { fontSize: 11, color: "#64748B" },
  closeButton: { marginTop: 14, backgroundColor: "#F1F5F9", borderRadius: 12, padding: 11 },
  closeButtonText: { textAlign: "center", color: "#334155", fontWeight: "700", fontSize: 13 },
});
