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
              const disabledReason = isDateDisabled?.(date);
              const outOfRange = (min && date < min) || (max && date > max);
              const disabled = Boolean(disabledReason) || Boolean(outOfRange);
              const selected = selectedDate ? isSameDay(date, selectedDate) : false;
              return (
                <Pressable
                  key={index}
                  style={styles.cell}
                  disabled={disabled}
                  onPress={() => onSelect(date)}
                >
                  <View style={[styles.dayCircle, selected && styles.dayCircleSelected, disabled && styles.dayCircleDisabled]}>
                    <Text style={[styles.dayText, selected && styles.dayTextSelected, disabled && styles.dayTextDisabled]}>
                      {date.getDate()}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.legendRow}>
            <View style={[styles.legendDot, { backgroundColor: "#FEE2E2" }]} />
            <Text style={styles.legendText}>Already filed for this leave type</Text>
          </View>

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
  dayCircle: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  dayCircleSelected: { backgroundColor: "#062B59" },
  dayCircleDisabled: { backgroundColor: "#FEE2E2" },
  dayText: { fontSize: 13, color: "#334155", fontWeight: "600" },
  dayTextSelected: { color: "#FFFFFF" },
  dayTextDisabled: { color: "#FCA5A5" },
  legendRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 12 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendText: { fontSize: 11, color: "#64748B" },
  closeButton: { marginTop: 14, backgroundColor: "#F1F5F9", borderRadius: 12, padding: 11 },
  closeButtonText: { textAlign: "center", color: "#334155", fontWeight: "700", fontSize: 13 },
});
