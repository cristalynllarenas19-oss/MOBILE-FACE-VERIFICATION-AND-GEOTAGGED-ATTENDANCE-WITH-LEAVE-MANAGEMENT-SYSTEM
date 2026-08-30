import React, { useCallback, useState } from "react";
import { View, Text, Image, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { EmployeeProfile, getMyProfile } from "../../api";
import { CACHE_KEYS, useCachedData } from "../../utils/dataCache";
import ViewProfileScreen from "../ViewProfileScreen";
import ChangePasswordScreen from "../ChangePasswordScreen";
import AboutScreen from "../AboutScreen";
import GeotaggedAreasScreen from "./GeotaggedAreasScreen";
import SupervisorSchedulesScreen from "./SupervisorSchedulesScreen";
import SupervisorReportsScreen from "./SupervisorReportsScreen";
import Avatar from "../../components/Avatar";
import AestheticScrollView from "../../components/AestheticScrollView";

type Props = {
  onLogout: () => void;
  canSwitchToEmployeePortal: boolean;
  onSwitchToEmployeePortal: () => void;
};

type MoreView = "root" | "profile" | "password" | "geotagging" | "schedules" | "reports" | "about";

export default function MoreScreen({ onLogout, canSwitchToEmployeePortal, onSwitchToEmployeePortal }: Props) {
  const [view, setView] = useState<MoreView>("root");

  // Same cache key as ViewProfileScreen/MainScreen so all three share one
  // fetched copy of the profile.
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
        }}
      />
    );
  }
  if (view === "password") {
    return <ChangePasswordScreen onClose={() => setView("root")} />;
  }
  if (view === "geotagging") {
    return <GeotaggedAreasScreen onClose={() => setView("root")} />;
  }
  if (view === "schedules") {
    return <SupervisorSchedulesScreen onClose={() => setView("root")} />;
  }
  if (view === "reports") {
    return <SupervisorReportsScreen onClose={() => setView("root")} />;
  }
  if (view === "about") {
    return <AboutScreen onClose={() => setView("root")} />;
  }

  const avatarSource = profile?.profilePhotoData
    ? `data:${profile.profilePhotoMimeType ?? "image/jpeg"};base64,${profile.profilePhotoData}`
    : null;

  return (
    <AestheticScrollView contentContainerStyle={styles.container}>
      <View style={styles.profileCard}>
        {avatarSource ? (
          <Image source={{ uri: avatarSource }} style={styles.avatarImage} />
        ) : (
          <Avatar firstName={profile?.firstName} lastName={profile?.lastName} size={54} />
        )}
        <View style={{ flex: 1 }}>
          <Text style={styles.profileName}>{profile ? `${profile.firstName} ${profile.lastName}` : "Loading..."}</Text>
          <Text style={styles.profileEmail}>{profile?.user.email}</Text>
        </View>
        <View style={styles.roleBadge}>
          <Text style={styles.roleBadgeText}>Supervisor</Text>
        </View>
      </View>

      <Text style={styles.sectionTitle}>Team Tools</Text>
      <View style={styles.group}>
        <MoreRow icon="location-outline" tint="#0EA5E9" label="Geotagged Areas" onPress={() => setView("geotagging")} />
        <MoreRow icon="time-outline" tint="#B45309" label="Schedules" onPress={() => setView("schedules")} />
        <MoreRow icon="bar-chart-outline" tint="#7C3AED" label="Reports" onPress={() => setView("reports")} last />
      </View>

      <Text style={styles.sectionTitle}>Account</Text>
      <View style={styles.group}>
        <MoreRow icon="person-outline" tint="#1680D8" label="My Profile" onPress={() => setView("profile")} />
        <MoreRow icon="key-outline" tint="#15803D" label="Change Password" onPress={() => setView("password")} />
        {canSwitchToEmployeePortal && (
          <MoreRow icon="swap-horizontal-outline" tint="#DB2777" label="Switch to My Attendance" onPress={onSwitchToEmployeePortal} />
        )}
        <MoreRow icon="information-circle-outline" tint="#64748B" label="About" onPress={() => setView("about")} last />
      </View>

      <Pressable style={({ pressed }) => [styles.logoutRow, pressed && styles.logoutRowPressed]} onPress={onLogout}>
        <Ionicons name="log-out-outline" size={22} color="#DC2626" />
        <Text style={styles.logoutText}>Log out</Text>
      </Pressable>
    </AestheticScrollView>
  );
}

function MoreRow({
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
      style={({ pressed }) => [styles.listRow, !last && styles.listRowDivider, pressed && styles.listRowPressed]}
      onPress={onPress}
    >
      <View style={[styles.rowIconWrap, { backgroundColor: `${tint}17` }]}>
        <Ionicons name={icon} size={22} color={tint} />
      </View>
      <Text style={styles.listRowText}>{label}</Text>
      <Ionicons name="chevron-forward" size={20} color="#CBD5E1" />
    </Pressable>
  );
}

const cardShadow = {
  shadowColor: "#0F172A",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.06,
  shadowRadius: 8,
  elevation: 2,
};

const styles = StyleSheet.create({
  container: { paddingBottom: 24 },
  profileCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#FFFFFF",
    borderRadius: 18,
    padding: 16,
    marginBottom: 18,
    ...cardShadow,
  },
  avatarImage: { width: 54, height: 54, borderRadius: 27 },
  profileName: { fontSize: 16, fontWeight: "700", color: "#062B59" },
  profileEmail: { fontSize: 12, color: "#64748B", marginTop: 2 },
  roleBadge: { backgroundColor: "#EAF3FC", paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  roleBadgeText: { fontSize: 11, fontWeight: "700", color: "#1680D8" },
  sectionTitle: { color: "#94A3B8", fontSize: 12, fontWeight: "700", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.4 },
  group: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    paddingHorizontal: 4,
    marginBottom: 18,
    ...cardShadow,
  },
  listRow: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  listRowDivider: { borderBottomWidth: 1, borderColor: "#F1F5F9" },
  listRowPressed: { backgroundColor: "#F8FAFC" },
  rowIconWrap: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  listRowText: { flex: 1, color: "#334155", fontWeight: "600", fontSize: 16 },
  logoutRow: {
    flexDirection: "row",
    gap: 10,
    minHeight: 60,
    paddingVertical: 14,
    borderRadius: 14,
    backgroundColor: "#FEF2F2",
    borderWidth: 1,
    borderColor: "#FCA5A5",
    justifyContent: "center",
    alignItems: "center",
  },
  logoutRowPressed: { backgroundColor: "#FEE2E2" },
  logoutText: { color: "#DC2626", fontWeight: "700", fontSize: 17 },
});
