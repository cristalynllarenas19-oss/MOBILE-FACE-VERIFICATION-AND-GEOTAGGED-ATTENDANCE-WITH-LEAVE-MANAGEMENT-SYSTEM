import React from "react";
import {
  View,
  Pressable,
  Text,
  StyleSheet,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

type Props = {
  tab: string;
  setTab: (tab: any) => void;
};

export default function BottomTab({
  tab,
  setTab,
}: Props) {
  return (
    <View style={styles.container}>
      <TabItem
        icon="time-outline"
        label="Attendance"
        active={tab === "attendance"}
        onPress={() =>
          setTab("attendance")
        }
      />

      <TabItem
        icon="calendar-outline"
        label="Leave"
        active={tab === "leave"}
        onPress={() =>
          setTab("leave")
        }
      />

      <TabItem
        icon="document-text-outline"
        label="DTR"
        active={tab === "dtr"}
        onPress={() =>
          setTab("dtr")
        }
      />

      <TabItem
        icon="settings-outline"
        label="Settings"
        active={tab === "settings"}
        onPress={() =>
          setTab("settings")
        }
      />
    </View>
  );
}

function TabItem({
  icon,
  label,
  active,
  onPress,
}: any) {
  return (
    <Pressable
      style={styles.tab}
      onPress={onPress}
    >
      <Ionicons
        name={icon}
        size={22}
        color={
          active
            ? "#244c7a"
            : "#94A3B8"
        }
      />

      <Text
        style={[
          styles.label,
          active &&
            styles.activeLabel,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    backgroundColor: "#fff",

    paddingVertical: 12,

    borderTopWidth: 1,
    borderTopColor: "#E2E8F0",

    elevation: 10,
  },

  tab: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },

  label: {
    fontSize: 12,
    marginTop: 4,
    color: "#94A3B8",
  },

  activeLabel: {
    color: "#244c7a",
    fontWeight: "700",
  },
});