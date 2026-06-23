import React, { useEffect, useRef } from "react";
import {
  View,
  Pressable,
  Text,
  StyleSheet,
  Animated,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Tab } from "../types";

type Props = {
  tab: Tab;
  setTab: (tab: Tab) => void;
};

const TABS: { key: Tab; icon: keyof typeof Ionicons.glyphMap; activeIcon: keyof typeof Ionicons.glyphMap; label: string }[] = [
  { key: "attendance", icon: "time-outline", activeIcon: "time", label: "Attendance" },
  { key: "leave", icon: "calendar-outline", activeIcon: "calendar", label: "Leave" },
  { key: "dtr", icon: "document-text-outline", activeIcon: "document-text", label: "DTR" },
  { key: "workarea", icon: "location-outline", activeIcon: "location", label: "Work Area" },
  { key: "settings", icon: "settings-outline", activeIcon: "settings", label: "Settings" },
];

export default function BottomTab({ tab, setTab }: Props) {
  const insets = useSafeAreaInsets();
  // RN's built-in SafeAreaView (used by the screen wrapping this bar) only
  // reserves bottom inset space on iOS. On Android it's a no-op, which is
  // what made this bar sit flush against the gesture/nav bar — so only add
  // the extra padding there; iOS already gets correct spacing for free.
  const extraBottomInset = Platform.OS === "android" ? insets.bottom : 0;

  return (
    <View style={[styles.container, { paddingBottom: Math.max(extraBottomInset, 10) }]}>
      {TABS.map((item) => (
        <TabItem
          key={item.key}
          icon={item.icon}
          activeIcon={item.activeIcon}
          label={item.label}
          active={tab === item.key}
          onPress={() => setTab(item.key)}
        />
      ))}
    </View>
  );
}

function TabItem({
  icon,
  activeIcon,
  label,
  active,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  activeIcon: keyof typeof Ionicons.glyphMap;
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const lift = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(lift, {
      toValue: active ? 1 : 0,
      useNativeDriver: true,
      friction: 6,
      tension: 80,
    }).start();
  }, [active]);

  const translateY = lift.interpolate({ inputRange: [0, 1], outputRange: [0, -16] });
  const scale = lift.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] });

  return (
    <Pressable
      style={styles.tab}
      onPress={onPress}
      android_ripple={{ color: "#E2E8F0", borderless: true }}
      hitSlop={6}
    >
      <Animated.View
        style={[
          styles.iconWrap,
          active && styles.iconWrapActive,
          { transform: [{ translateY }, { scale }] },
        ]}
      >
        <Ionicons name={active ? activeIcon : icon} size={20} color={active ? "#FFFFFF" : "#94A3B8"} />
      </Animated.View>

      <Text style={[styles.label, active && styles.activeLabel]} numberOfLines={1}>
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
    backgroundColor: "#244c7a",
    shadowColor: "#244c7a",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
    elevation: 6,
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
