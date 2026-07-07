import React, { useEffect, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Animated,
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
  const badgeScale = useRef(new Animated.Value(unreadCount > 0 ? 1 : 0)).current;
  const bellShake = useRef(new Animated.Value(0)).current;
  const prevUnreadCount = useRef(unreadCount);

  useEffect(() => {
    Animated.spring(badgeScale, {
      toValue: unreadCount > 0 ? 1 : 0,
      useNativeDriver: true,
      friction: 5,
      tension: 140,
    }).start();

    if (unreadCount > prevUnreadCount.current) {
      bellShake.setValue(0);
      Animated.sequence([
        Animated.timing(bellShake, { toValue: 1, duration: 60, useNativeDriver: true }),
        Animated.timing(bellShake, { toValue: -1, duration: 100, useNativeDriver: true }),
        Animated.timing(bellShake, { toValue: 1, duration: 100, useNativeDriver: true }),
        Animated.timing(bellShake, { toValue: 0, duration: 60, useNativeDriver: true }),
      ]).start();
    }

    prevUnreadCount.current = unreadCount;
  }, [unreadCount]);

  const bellRotate = bellShake.interpolate({
    inputRange: [-1, 0, 1],
    outputRange: ["-18deg", "0deg", "18deg"],
  });

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

        <Pressable
          onPress={onPressNotifications}
          hitSlop={8}
          style={({ pressed }) => [styles.bellButton, pressed && styles.bellButtonPressed]}
        >
          <Animated.View style={{ transform: [{ rotate: bellRotate }] }}>
            <Ionicons
              name="notifications-outline"
              size={28}
              color="#244c7a"
            />
          </Animated.View>

          <Animated.View
            pointerEvents="none"
            style={[
              styles.bellBadge,
              {
                opacity: badgeScale,
                transform: [{ scale: badgeScale }],
              },
            ]}
          >
            <Text style={styles.bellBadgeText}>{unreadCount > 9 ? "9+" : unreadCount}</Text>
          </Animated.View>
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

  bellButtonPressed: {
    opacity: 0.6,
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