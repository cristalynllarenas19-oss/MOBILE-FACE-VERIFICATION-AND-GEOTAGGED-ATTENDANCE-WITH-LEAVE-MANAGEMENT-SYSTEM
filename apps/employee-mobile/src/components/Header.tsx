import React from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

type Props = {
  user: any;
  unreadCount?: number;
  onPressNotifications?: () => void;
};

export default function Header({
  user,
  unreadCount = 0,
  onPressNotifications,
}: Props) {
  return (
    <View style={styles.container}>
      <View style={styles.topRow}>
        <View style={styles.userSection}>
          <Ionicons
            name="person-circle"
            size={40}
            color="#244c7a"
          />

          <Text style={styles.name}>
            {user?.displayName}
          </Text>
        </View>

        <Pressable onPress={onPressNotifications} style={styles.bellButton}>
          <Ionicons
            name="notifications-outline"
            size={28}
            color="#244c7a"
          />
          {unreadCount > 0 && (
            <View style={styles.bellBadge}>
              <Text style={styles.bellBadgeText}>{unreadCount > 9 ? "9+" : unreadCount}</Text>
            </View>
          )}
        </Pressable>
      </View>

      <Text style={styles.subtitle}>
        Employee
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: "#fff",
    paddingHorizontal: 20,
    paddingTop: 50,
    paddingBottom: 15,
    borderBottomWidth: 1,
    borderBottomColor: "#edf3f8",
  },

  topRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },

  userSection: {
    flexDirection: "row",
    alignItems: "center",
  },

  name: {
    fontSize: 22,
    fontWeight: "700",
    color: "#062B59",
    marginLeft: 8,
  },

  subtitle: {
    marginTop: 4,
    marginLeft: 48,
    fontSize: 13,
    color: "#64748B",
  },

  bellButton: {
    position: "relative",
  },

  bellBadge: {
    position: "absolute",
    top: -4,
    right: -4,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 3,
    borderRadius: 8,
    backgroundColor: "#DC2626",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "#FFFFFF",
  },

  bellBadgeText: {
    color: "#FFFFFF",
    fontSize: 9,
    fontWeight: "700",
  },
});