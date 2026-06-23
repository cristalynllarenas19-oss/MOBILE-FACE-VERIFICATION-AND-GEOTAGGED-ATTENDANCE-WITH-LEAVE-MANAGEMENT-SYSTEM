import React, { useEffect, useState } from "react";
import { View, Text, Image, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { EmployeeProfile, getMyProfile } from "../api";

type Props = {
  onClose: () => void;
};

export default function ViewProfileScreen({ onClose }: Props) {
  const [profile, setProfile] = useState<EmployeeProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    getMyProfile()
      .then(setProfile)
      .finally(() => setIsLoading(false));
  }, []);

  const avatarSource = profile?.profilePhotoData
    ? `data:${profile.profilePhotoMimeType ?? "image/jpeg"};base64,${profile.profilePhotoData}`
    : null;

  return (
    <View style={styles.container}>
      <Pressable onPress={onClose} style={styles.backButton} hitSlop={10}>
        <Ionicons name="arrow-back" size={24} color="#062B59" />
      </Pressable>

      <Text style={styles.title}>My Profile</Text>

      {isLoading ? (
        <ActivityIndicator size="large" color="#1680D8" style={{ marginTop: 20 }} />
      ) : (
        <>
          {avatarSource ? (
            <Image source={{ uri: avatarSource }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, styles.avatarPlaceholder]}>
              <Ionicons name="person" size={32} color="#94A3B8" />
            </View>
          )}

          <View style={styles.card}>
            <InfoRow icon="person-outline" label="Full Name" value={`${profile?.firstName ?? ""} ${profile?.lastName ?? ""}`} />
            <InfoRow icon="mail-outline" label="Email Address" value={profile?.user.email ?? "--"} />
            <InfoRow icon="call-outline" label="Contact Number" value={profile?.contactNumber ?? "Not provided"} />
            <InfoRow icon="business-outline" label="Department" value={profile?.department.name ?? "--"} />
            <InfoRow icon="briefcase-outline" label="Position" value={profile?.position.title ?? "--"} last />
          </View>

          <Text style={styles.note}>
            Profile information is managed by HR. Contact HR/Admin if any details need to be updated.
          </Text>
        </>
      )}
    </View>
  );
}

function InfoRow({
  icon,
  label,
  value,
  last,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
  last?: boolean;
}) {
  return (
    <View style={[styles.row, last && { borderBottomWidth: 0 }]}>
      <Ionicons name={icon} size={18} color="#244c7a" />
      <View style={{ flex: 1 }}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowValue}>{value}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#FFFFFF", paddingHorizontal: 20, paddingTop: 4, paddingBottom: 16 },
  backButton: { width: 40, height: 40, justifyContent: "center" },
  title: { fontSize: 20, fontWeight: "700", color: "#062B59", marginTop: 0, marginBottom: 12 },
  avatar: { width: 68, height: 68, borderRadius: 34, alignSelf: "center", marginBottom: 12 },
  avatarPlaceholder: { backgroundColor: "#F1F5F9", alignItems: "center", justifyContent: "center" },
  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#E2E8F0",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: "#F1F5F9",
  },
  rowLabel: { fontSize: 11.5, color: "#64748B" },
  rowValue: { fontSize: 14, fontWeight: "700", color: "#062B59", marginTop: 2 },
  note: {
    marginTop: 14,
    fontSize: 12,
    color: "#94A3B8",
    textAlign: "center",
    lineHeight: 18,
  },
});
