import React, { useCallback, useEffect, useState } from "react";
import { View, Text, Image, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { EmployeeProfile, getMyProfile } from "../api";
import EditProfileScreen from "./EditProfileScreen";
import ChangePasswordScreen from "./ChangePasswordScreen";
import NotificationPreferencesScreen from "./NotificationPreferencesScreen";

type Props = {
  onLogout: () => void;
};

type SettingsView = "root" | "profile" | "password" | "notifications";

export default function SettingsScreen({ onLogout }: Props) {
  const [view, setView] = useState<SettingsView>("root");
  const [profile, setProfile] = useState<EmployeeProfile | null>(null);

  const loadProfile = useCallback(() => {
    getMyProfile().then(setProfile).catch(() => undefined);
  }, []);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  if (view === "profile") {
    return <EditProfileScreen onClose={() => setView("root")} onUpdated={loadProfile} />;
  }
  if (view === "password") {
    return <ChangePasswordScreen onClose={() => setView("root")} />;
  }
  if (view === "notifications") {
    return <NotificationPreferencesScreen onClose={() => setView("root")} />;
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

      <SettingsRow icon="person-outline" label="Edit Profile" onPress={() => setView("profile")} />
      <SettingsRow icon="key-outline" label="Change Password" onPress={() => setView("password")} />
      <SettingsRow icon="notifications-outline" label="Notification Settings" onPress={() => setView("notifications")} />

      <Pressable onPress={onLogout} style={styles.logoutButton}>
        <Text style={styles.logoutText}>Logout</Text>
      </Pressable>
    </View>
  );
}

function SettingsRow({ icon, label, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) {
  return (
    <Pressable style={styles.listRow} onPress={onPress}>
      <Ionicons name={icon} size={20} color="#244c7a" />
      <Text style={styles.listRowText}>{label}</Text>
      <Ionicons name="chevron-forward" size={18} color="#CBD5E1" />
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
    minHeight: 50,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderBottomWidth: 1,
    borderColor: "#edf3f8",
  },

  listRowText: {
    flex: 1,
    color: "#334155",
    fontWeight: "600",
    fontSize: 14,
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
