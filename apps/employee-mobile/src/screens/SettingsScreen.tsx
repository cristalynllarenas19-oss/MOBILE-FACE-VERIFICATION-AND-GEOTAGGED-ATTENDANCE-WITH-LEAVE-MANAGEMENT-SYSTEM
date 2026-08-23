import React, { useCallback, useState } from "react";
import { View, Text, Image, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { EmployeeProfile, getMyProfile } from "../api";
import { CACHE_KEYS, useCachedData } from "../utils/dataCache";
import ViewProfileScreen from "./ViewProfileScreen";
import ChangePasswordScreen from "./ChangePasswordScreen";
import AboutScreen from "./AboutScreen";

type Props = {
  onLogout: () => void;
  onProfileChanged?: () => void;
  canSwitchToSupervisorPortal?: boolean;
  onSwitchToSupervisorPortal?: () => void;
};

type SettingsView = "root" | "profile" | "password" | "about";

export default function SettingsScreen({ onLogout, onProfileChanged, canSwitchToSupervisorPortal, onSwitchToSupervisorPortal }: Props) {
  const [view, setView] = useState<SettingsView>("root");
  const { data: profile, refresh: refreshProfile } = useCachedData<EmployeeProfile>(
    CACHE_KEYS.myProfile,
    getMyProfile,
  );

  const loadProfile = useCallback(() => {
    refreshProfile().catch(() => undefined);
  }, [refreshProfile]);

  if (view === "profile") {
    return (
      <ViewProfileScreen
        onClose={() => {
          setView("root");
          loadProfile();
          onProfileChanged?.();
        }}
      />
    );
  }
  if (view === "password") {
    return <ChangePasswordScreen onClose={() => setView("root")} />;
  }
  if (view === "about") {
    return <AboutScreen onClose={() => setView("root")} />;
  }

  const avatarSource = profile?.profilePhotoData
    ? `data:${profile.profilePhotoMimeType ?? "image/jpeg"};base64,${profile.profilePhotoData}`
    : null;

  return (
    <View style={styles.card}>
      <View style={styles.profileHeader}>
        {avatarSource ? (
          <Image source={{ uri: avatarSource }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarPlaceholder]}>
            <Ionicons name="person" size={28} color="#94A3B8" />
          </View>
        )}
        <View style={{ flex: 1 }}>
          <Text style={styles.profileName}>
            {profile ? `${profile.firstName} ${profile.lastName}` : "Loading..."}
          </Text>
          <Text style={styles.profileEmail}>{profile?.user.email}</Text>
        </View>
      </View>

      <Text style={styles.cardTitle}>Settings</Text>

      <SettingsRow icon="person-outline" tint="#1680D8" label="My Profile" onPress={() => setView("profile")} />
      <SettingsRow icon="key-outline" tint="#15803D" label="Change Password" onPress={() => setView("password")} />
      {canSwitchToSupervisorPortal && onSwitchToSupervisorPortal && (
        <SettingsRow icon="swap-horizontal-outline" tint="#DB2777" label="Switch to Supervisor View" onPress={onSwitchToSupervisorPortal} />
      )}
      <SettingsRow icon="information-circle-outline" tint="#64748B" label="About" onPress={() => setView("about")} last />

      <Pressable onPress={onLogout} style={({ pressed }) => [styles.logoutRow, pressed && styles.logoutRowPressed]}>
        <Ionicons name="log-out-outline" size={22} color="#DC2626" />
        <Text style={styles.logoutText}>Log out</Text>
      </Pressable>
    </View>
  );
}

function SettingsRow({
  icon,
  tint,
  label,
  onPress,
  last,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  tint: string;
  label: string;
  onPress: () => void;
  last?: boolean;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.listRow, last && styles.listRowLast, pressed && styles.listRowPressed]}
      onPress={onPress}
      hitSlop={4}
    >
      <View style={[styles.rowIconWrap, { backgroundColor: `${tint}17` }]}>
        <Ionicons name={icon} size={22} color={tint} />
      </View>
      <Text style={styles.listRowText}>{label}</Text>
      <Ionicons name="chevron-forward" size={20} color="#CBD5E1" />
    </Pressable>
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

  profileHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingBottom: 16,
    marginBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#edf3f8",
  },

  avatar: { width: 52, height: 52, borderRadius: 26 },
  avatarPlaceholder: { backgroundColor: "#F1F5F9", alignItems: "center", justifyContent: "center" },

  profileName: { fontSize: 16, fontWeight: "700", color: "#062B59" },
  profileEmail: { fontSize: 12, color: "#64748B", marginTop: 2 },

  cardTitle: {
    color: "#062b59",
    fontSize: 18,
    fontWeight: "900",
    marginBottom: 15,
  },

  listRow: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderColor: "#edf3f8",
  },

  listRowLast: {
    borderBottomWidth: 0,
  },

  listRowPressed: {
    backgroundColor: "#F8FAFC",
  },

  rowIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },

  listRowText: {
    flex: 1,
    color: "#334155",
    fontWeight: "600",
    fontSize: 16,
  },

  logoutRow: {
    marginTop: 20,
    minHeight: 60,
    borderRadius: 14,
    flexDirection: "row",
    gap: 10,
    paddingVertical: 14,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#FEF2F2",
    borderWidth: 1,
    borderColor: "#FCA5A5",
  },

  logoutRowPressed: {
    backgroundColor: "#FEE2E2",
  },

  logoutText: {
    color: "#DC2626",
    fontWeight: "700",
    fontSize: 17,
  },
});
