import React from "react";
import {
  View,
  Pressable,
  Text,
  StyleSheet,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type Props = {
  tab: string;
  setTab: (tab: any) => void;
};

export default function BottomTab({
  tab,
  setTab,
}: Props) {
  const insets = useSafeAreaInsets();
  // RN's built-in SafeAreaView (used by the screen wrapping this bar) only
  // reserves bottom inset space on iOS. On Android it's a no-op, which is
  // what made this bar sit flush against the gesture/nav bar — so only add
  // the extra padding there; iOS already gets correct spacing for free.
  const extraBottomInset = Platform.OS === "android" ? insets.bottom : 0;

  return (
    <View style={[styles.container, { paddingBottom: Math.max(extraBottomInset, 10) }]}>
      <TabItem
        icon="time-outline"
        activeIcon="time"
        label="Attendance"
        active={tab === "attendance"}
        onPress={() =>
          setTab("attendance")
        }
      />

      <TabItem
        icon="calendar-outline"
        activeIcon="calendar"
        label="Leave"
        active={tab === "leave"}
        onPress={() =>
          setTab("leave")
        }
      />

      <TabItem
        icon="document-text-outline"
        activeIcon="document-text"
        label="DTR"
        active={tab === "dtr"}
        onPress={() =>
          setTab("dtr")
        }
      />

      <TabItem
        icon="settings-outline"
        activeIcon="settings"
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
  activeIcon,
  label,
  active,
  onPress,
}: any) {
  return (
    <Pressable
      style={styles.tab}
      onPress={onPress}
      android_ripple={{ color: "#E2E8F0", borderless: true }}
      hitSlop={6}
    >
      <View style={[styles.iconWrap, active && styles.iconWrapActive]}>
        <Ionicons
          name={active ? activeIcon : icon}
          size={20}
          color={
            active
              ? "#244c7a"
              : "#94A3B8"
          }
        />
      </View>

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

    paddingTop: 10,

    borderTopWidth: 1,
    borderTopColor: "#EDF1F6",

    shadowColor: "#0F172A",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 12,
  },

  tab: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
  },

  iconWrap: {
    width: 44,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },

  iconWrapActive: {
    backgroundColor: "#E5EEFA",
  },

  label: {
    fontSize: 11,
    color: "#94A3B8",
    fontWeight: "600",
  },

  activeLabel: {
    color: "#244c7a",
    fontWeight: "700",
  },
});
