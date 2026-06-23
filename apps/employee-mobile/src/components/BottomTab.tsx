import React, { useRef, useState } from "react";
import {
  View,
  Pressable,
  Text,
  StyleSheet,
  Animated,
  Platform,
  LayoutChangeEvent,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Tab } from "../types";

type Props = {
  tab: Tab;
  setTab: (tab: Tab) => void;
};

const HIGHLIGHT_WIDTH = 44;

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

  const layoutsRef = useRef<Record<string, { x: number; width: number }>>({});
  const highlightX = useRef(new Animated.Value(0)).current;
  const [highlightReady, setHighlightReady] = useState(false);

  function animateHighlightTo(key: string) {
    const layout = layoutsRef.current[key];
    if (!layout) return;
    Animated.spring(highlightX, {
      toValue: layout.x + layout.width / 2 - HIGHLIGHT_WIDTH / 2,
      useNativeDriver: true,
      friction: 8,
      tension: 70,
    }).start();
  }

  function handleTabLayout(key: string, event: LayoutChangeEvent) {
    const { x, width } = event.nativeEvent.layout;
    layoutsRef.current[key] = { x, width };
    if (key === tab && !highlightReady) {
      highlightX.setValue(x + width / 2 - HIGHLIGHT_WIDTH / 2);
      setHighlightReady(true);
    }
  }

  function handlePress(key: Tab) {
    setTab(key);
    animateHighlightTo(key);
  }

  return (
    <View style={[styles.wrapper, { bottom: Math.max(extraBottomInset, 10) + 12 }]}>
      <View style={styles.container}>
        <Animated.View
          style={[
            styles.highlight,
            { opacity: highlightReady ? 1 : 0, transform: [{ translateX: highlightX }] },
          ]}
        />

        {TABS.map((item) => (
          <TabItem
            key={item.key}
            icon={item.icon}
            activeIcon={item.activeIcon}
            label={item.label}
            active={tab === item.key}
            onPress={() => handlePress(item.key)}
            onLayout={(event: LayoutChangeEvent) => handleTabLayout(item.key, event)}
          />
        ))}
      </View>
    </View>
  );
}

function TabItem({
  icon,
  activeIcon,
  label,
  active,
  onPress,
  onLayout,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  activeIcon: keyof typeof Ionicons.glyphMap;
  label: string;
  active: boolean;
  onPress: () => void;
  onLayout: (event: LayoutChangeEvent) => void;
}) {
  const scale = useRef(new Animated.Value(1)).current;

  function handlePressIn() {
    Animated.spring(scale, { toValue: 0.85, useNativeDriver: true, friction: 5 }).start();
  }

  function handlePressOut() {
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, friction: 4, tension: 90 }).start();
  }

  return (
    <Pressable
      style={styles.tab}
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onLayout={onLayout}
      android_ripple={{ color: "#E2E8F0", borderless: true }}
      hitSlop={6}
    >
      <Animated.View style={[styles.iconWrap, { transform: [{ scale }] }]}>
        <Ionicons name={active ? activeIcon : icon} size={19} color={active ? "#244c7a" : "#94A3B8"} />
      </Animated.View>

      <Text style={[styles.label, active && styles.activeLabel]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: "absolute",
    left: 14,
    right: 14,
  },

  container: {
    flexDirection: "row",
    backgroundColor: "#fff",
    borderRadius: 26,
    paddingVertical: 10,

    shadowColor: "#0F172A",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 12,
  },

  highlight: {
    position: "absolute",
    top: 6,
    width: HIGHLIGHT_WIDTH,
    height: 28,
    borderRadius: 14,
    backgroundColor: "#E5EEFA",
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

  label: {
    fontSize: 10,
    color: "#94A3B8",
    fontWeight: "600",
  },

  activeLabel: {
    color: "#244c7a",
    fontWeight: "700",
  },
});
