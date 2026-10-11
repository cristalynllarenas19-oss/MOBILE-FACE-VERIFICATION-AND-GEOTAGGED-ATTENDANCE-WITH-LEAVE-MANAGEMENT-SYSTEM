import React from "react";
import { Modal, View, Text, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";

type Props = {
  // Null while hidden. minutesEarly is how far short of expectedAt "now" is.
  prompt: { minutesEarly: number; now: Date; expectedAt: Date } | null;
  onConfirm: () => void;
  onCancel: () => void;
};

function formatDuration(totalMinutes: number) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

function formatClock(value: Date) {
  return value.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// Asks before an early Time Out — it can't be undone by the employee, so it
// shouldn't close the day on an accidental tap. Same layout as the employee
// portal's version (admin-web AttendancePage.tsx): how early is the headline,
// with both times laid out underneath.
export default function EarlyTimeOutModal({ prompt, onConfirm, onCancel }: Props) {
  return (
    <Modal visible={!!prompt} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.overlay}>
        {prompt && (
          <View style={styles.card}>
            <View style={styles.iconCircle}>
              <Ionicons name="alert" size={38} color="#D97706" />
            </View>
            <Text style={styles.title}>Time Out Early?</Text>
            <Text style={styles.amount}>{formatDuration(prompt.minutesEarly)}</Text>
            <Text style={styles.amountCaption}>before your expected time out</Text>

            <View style={styles.facts}>
              <View style={styles.factRow}>
                <Text style={styles.factLabel}>Time out now</Text>
                <Text style={styles.factValue}>{formatClock(prompt.now)}</Text>
              </View>
              <View style={styles.factRow}>
                <Text style={styles.factLabel}>Expected time out</Text>
                <Text style={styles.factValue}>{formatClock(prompt.expectedAt)}</Text>
              </View>
            </View>

            <Text style={styles.message}>This will be recorded as an early time out and can't be undone.</Text>

            <Pressable style={({ pressed }) => [styles.confirmButton, pressed && styles.pressed]} onPress={onConfirm}>
              <Text style={styles.confirmText}>Time Out Anyway</Text>
            </Pressable>
            <Pressable style={({ pressed }) => [styles.cancelButton, pressed && styles.pressed]} onPress={onCancel}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // Same overlay/card as ResultModal, so the two read as one family.
  overlay: {
    flex: 1,
    backgroundColor: "rgba(6, 43, 89, 0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: "#fff",
    borderRadius: 24,
    padding: 24,
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.2,
    shadowRadius: 20,
    elevation: 10,
  },
  iconCircle: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: "#FFFBEB",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  title: {
    fontSize: 19,
    fontWeight: "700",
    color: "#062B59",
    marginBottom: 6,
    textAlign: "center",
  },
  amount: {
    fontSize: 34,
    fontWeight: "800",
    color: "#D97706",
    fontVariant: ["tabular-nums"],
    textAlign: "center",
  },
  amountCaption: {
    fontSize: 13,
    fontWeight: "600",
    color: "#64748B",
    marginBottom: 16,
    textAlign: "center",
  },
  facts: {
    alignSelf: "stretch",
    backgroundColor: "#F8FAFC",
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    gap: 8,
    marginBottom: 14,
  },
  factRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  factLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#64748B",
  },
  factValue: {
    fontSize: 13.5,
    fontWeight: "700",
    color: "#0F172A",
    fontVariant: ["tabular-nums"],
  },
  message: {
    fontSize: 13.5,
    color: "#475569",
    textAlign: "center",
    lineHeight: 19,
    marginBottom: 18,
  },
  confirmButton: {
    width: "100%",
    height: 50,
    borderRadius: 14,
    backgroundColor: "#D97706",
    alignItems: "center",
    justifyContent: "center",
  },
  confirmText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
  },
  cancelButton: {
    width: "100%",
    height: 48,
    borderRadius: 14,
    backgroundColor: "#F1F5F9",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 10,
  },
  cancelText: {
    color: "#475569",
    fontSize: 15,
    fontWeight: "700",
  },
  pressed: {
    opacity: 0.85,
  },
});
