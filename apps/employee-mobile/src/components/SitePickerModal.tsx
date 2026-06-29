import React from "react";
import { Modal, View, Text, FlatList, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { WorkLocation } from "../api";

type Props = {
  visible: boolean;
  sites: WorkLocation[];
  onSelect: (site: WorkLocation) => void;
  onCancel: () => void;
};

export default function SitePickerModal({ visible, sites, onSelect, onCancel }: Props) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <Text style={styles.title}>Select Site to Visit</Text>
          <Text style={styles.subtitle}>Choose which assigned site you're starting a visit at.</Text>

          <FlatList
            data={sites}
            keyExtractor={(item) => item.id}
            style={styles.list}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            renderItem={({ item }) => (
              <Pressable style={styles.siteRow} onPress={() => onSelect(item)}>
                <View style={styles.siteIcon}>
                  <Ionicons name="location" size={18} color="#1680D8" />
                </View>
                <Text style={styles.siteName}>{item.name}</Text>
                <Ionicons name="chevron-forward" size={18} color="#CBD5E1" />
              </Pressable>
            )}
          />

          <Pressable style={styles.cancelButton} onPress={onCancel}>
            <Text style={styles.cancelText}>Cancel</Text>
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
    maxWidth: 400,
    maxHeight: "80%",
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 20,
  },
  title: {
    fontSize: 18,
    fontWeight: "800",
    color: "#062B59",
    textAlign: "center",
  },
  subtitle: {
    fontSize: 13,
    color: "#64748B",
    textAlign: "center",
    marginTop: 6,
    marginBottom: 16,
  },
  list: {
    flexGrow: 0,
  },
  separator: {
    height: 1,
    backgroundColor: "#edf3f8",
  },
  siteRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 14,
  },
  siteIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#EFF6FF",
    alignItems: "center",
    justifyContent: "center",
  },
  siteName: {
    flex: 1,
    fontSize: 15,
    fontWeight: "700",
    color: "#334155",
  },
  cancelButton: {
    marginTop: 16,
    height: 46,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F1F5F9",
  },
  cancelText: {
    color: "#475569",
    fontSize: 14,
    fontWeight: "700",
  },
});
