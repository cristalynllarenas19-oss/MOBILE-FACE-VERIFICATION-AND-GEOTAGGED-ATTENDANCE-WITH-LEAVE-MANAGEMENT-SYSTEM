import React from "react";
import { Modal, View, Text, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";

export type ResultModalStatus = "approved" | "pending" | "rejected" | "error" | "info";

type Props = {
  visible: boolean;
  status: ResultModalStatus;
  title: string;
  message: string;
  onClose: () => void;
};

const STATUS_CONFIG: Record<
  ResultModalStatus,
  { icon: keyof typeof Ionicons.glyphMap; color: string; bg: string }
> = {
  approved: { icon: "checkmark-circle", color: "#17A34A", bg: "#ECFDF3" },
  pending: { icon: "time", color: "#D97706", bg: "#FFFBEB" },
  rejected: { icon: "close-circle", color: "#DC2626", bg: "#FEF2F2" },
  error: { icon: "warning", color: "#DC2626", bg: "#FEF2F2" },
  info: { icon: "information-circle", color: "#1680D8", bg: "#EFF6FF" },
};

export default function ResultModal({ visible, status, title, message, onClose }: Props) {
  const config = STATUS_CONFIG[status];

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={[styles.iconCircle, { backgroundColor: config.bg }]}>
            <Ionicons name={config.icon} size={48} color={config.color} />
          </View>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.message}>{message}</Text>
          <Pressable style={[styles.button, { backgroundColor: config.color }]} onPress={onClose}>
            <Text style={styles.buttonText}>Done</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
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
    padding: 28,
    alignItems: "center",

    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.2,
    shadowRadius: 20,
    elevation: 10,
  },
  iconCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 18,
  },
  title: {
    fontSize: 20,
    fontWeight: "700",
    color: "#062B59",
    marginBottom: 8,
    textAlign: "center",
  },
  message: {
    fontSize: 14,
    color: "#475569",
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 22,
  },
  button: {
    width: "100%",
    height: 50,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
  },
});
