import React, { useEffect, useState } from "react";
import { View, Text, Switch, Pressable, StyleSheet, ActivityIndicator, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { getNotificationPreferences, updateNotificationPreferences } from "../api";

type Props = {
  onClose: () => void;
};

export default function NotificationPreferencesScreen({ onClose }: Props) {
  const [notifyOnAttendance, setNotifyOnAttendance] = useState(true);
  const [notifyOnLeaveUpdates, setNotifyOnLeaveUpdates] = useState(true);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    getNotificationPreferences()
      .then((prefs) => {
        setNotifyOnAttendance(prefs.notifyOnAttendance);
        setNotifyOnLeaveUpdates(prefs.notifyOnLeaveUpdates);
      })
      .catch((error) => Alert.alert("Failed to Load", error instanceof Error ? error.message : "Please try again."))
      .finally(() => setIsLoading(false));
  }, []);

  async function toggle(key: "notifyOnAttendance" | "notifyOnLeaveUpdates", value: boolean) {
    if (key === "notifyOnAttendance") setNotifyOnAttendance(value);
    else setNotifyOnLeaveUpdates(value);

    try {
      await updateNotificationPreferences({ [key]: value });
    } catch (error) {
      // Revert on failure
      if (key === "notifyOnAttendance") setNotifyOnAttendance(!value);
      else setNotifyOnLeaveUpdates(!value);
      Alert.alert("Update Failed", error instanceof Error ? error.message : "Please try again.");
    }
  }

  return (
    <View style={styles.container}>
      <Pressable onPress={onClose} style={styles.backButton} hitSlop={10}>
        <Ionicons name="arrow-back" size={24} color="#062B59" />
      </Pressable>

      <Text style={styles.title}>Notification Settings</Text>

      {isLoading ? (
        <ActivityIndicator size="large" color="#1680D8" style={{ marginTop: 20 }} />
      ) : (
        <View style={styles.card}>
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>Attendance Confirmations</Text>
              <Text style={styles.rowSubtitle}>Get notified when your time in/out is recorded.</Text>
            </View>
            <Switch
              value={notifyOnAttendance}
              onValueChange={(value) => toggle("notifyOnAttendance", value)}
              trackColor={{ true: "#1680D8" }}
            />
          </View>

          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>Leave Updates</Text>
              <Text style={styles.rowSubtitle}>Get notified when your leave requests are reviewed.</Text>
            </View>
            <Switch
              value={notifyOnLeaveUpdates}
              onValueChange={(value) => toggle("notifyOnLeaveUpdates", value)}
              trackColor={{ true: "#1680D8" }}
            />
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#FFFFFF", padding: 20 },
  backButton: { width: 40, height: 40, justifyContent: "center" },
  title: { fontSize: 22, fontWeight: "700", color: "#062B59", marginTop: 4, marginBottom: 20 },
  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#E2E8F0",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#F1F5F9",
    gap: 10,
  },
  rowTitle: { fontSize: 14, fontWeight: "700", color: "#062B59" },
  rowSubtitle: { fontSize: 12, color: "#64748B", marginTop: 2 },
});
