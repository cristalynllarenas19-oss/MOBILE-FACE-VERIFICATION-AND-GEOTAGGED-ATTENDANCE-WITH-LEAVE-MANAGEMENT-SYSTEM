import React from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
} from "react-native";

type Props = {
  onLogout: () => void;
};

export default function SettingsScreen({
  onLogout,
}: Props) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>
        Settings
      </Text>

      <View style={styles.listRow}>
        <Text>Notifications</Text>
      </View>

      <View style={styles.listRow}>
        <Text>Profile</Text>
      </View>

      <View style={styles.listRow}>
        <Text>Privacy</Text>
      </View>

      <Pressable
        onPress={onLogout}
        style={styles.logoutButton}
      >
        <Text style={styles.logoutText}>
          Logout
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: 18,
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#dbe5ef",
  },

  cardTitle: {
    color: "#062b59",
    fontSize: 18,
    fontWeight: "900",
    marginBottom: 15,
  },

  listRow: {
    minHeight: 50,
    justifyContent: "center",
    borderBottomWidth: 1,
    borderColor: "#edf3f8",
  },

  logoutButton: {
    marginTop: 20,
    backgroundColor: "#dc2626",
    height: 46,
    borderRadius: 8,
    justifyContent: "center",
    alignItems: "center",
  },

  logoutText: {
    color: "#fff",
    fontWeight: "bold",
  },
});