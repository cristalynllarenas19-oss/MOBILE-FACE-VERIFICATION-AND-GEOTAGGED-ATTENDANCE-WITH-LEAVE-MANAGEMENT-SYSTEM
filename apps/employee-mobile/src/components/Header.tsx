import React, { useEffect, useRef } from "react";
import {
  View,
  Text,
  Image,
  StyleSheet,
  Pressable,
  Animated,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { EmployeeProfile } from "../api";

type Props = {
  user: any;
  profile?: EmployeeProfile | null;
  unreadCount?: number;
  onPressNotifications?: () => void;
  subtitle?: string;
};

export default function Header({
  user,
  profile,
  unreadCount = 0,
  onPressNotifications,
  subtitle = "Employee",
}: Props) {
  const avatarSource = profile?.profilePhotoData
    ? `data:${profile.profilePhotoMimeType ?? "image/jpeg"};base64,${profile.profilePhotoData}`
    : null;
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
          <View style={styles.avatarWrap}>
            {avatarSource ? (
              <Image source={{ uri: avatarSource }} style={styles.avatarImage} />
            ) : (
              <Ionicons
                name="person"
                size={22}
                color="#1680D8"
              />
            )}
          </View>

          <View style={styles.userTextCol}>
            <Text style={styles.name} numberOfLines={1} ellipsizeMode="tail">
              {user?.displayName}
            </Text>
            <View style={styles.rolePill}>
              <Text style={styles.roleText}>{subtitle}</Text>
            </View>
          </View>
        </View>

        <Pressable
          onPress={onPressNotifications}
          hitSlop={8}
          style={({ pressed }) => [styles.bellButton, pressed && styles.bellButtonPressed]}
        >
          <Animated.View style={{ transform: [{ rotate: bellRotate }] }}>
            <Ionicons
              name="notifications-outline"
              size={22}
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
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginRight: 12,
  },

  avatarWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#EAF3FC",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "#BFDBFE",
    overflow: "hidden",
  },

  avatarImage: {
    width: "100%",
    height: "100%",
  },

  userTextCol: {
    flex: 1,
    gap: 4,
  },

  name: {
    fontSize: 19,
    fontWeight: "800",
    color: "#062B59",
    letterSpacing: -0.2,
  },

  rolePill: {
    alignSelf: "flex-start",
    backgroundColor: "#EAF3FC",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },

  roleText: {
    fontSize: 10.5,
    fontWeight: "700",
    color: "#1680D8",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },

  bellButton: {
    position: "relative",
    padding: 7,
    borderRadius: 999,
    backgroundColor: "#F8FAFF",
    borderWidth: 1,
    borderColor: "#EEF2F7",
  },

  bellButtonPressed: {
    opacity: 0.6,
  },

  bellBadge: {
    position: "absolute",
    top: 3,
    right: 3,
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