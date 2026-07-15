import React, { useState } from "react";
import { View, Text, Image, Pressable, StyleSheet, ActivityIndicator, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { EmployeeProfile, getMyProfile, updateMyPhoto } from "../api";
import { useCachedData } from "../utils/dataCache";

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

type Props = {
  onClose: () => void;
};

export default function ViewProfileScreen({ onClose }: Props) {
  const { data: profile, isLoading, setData: setProfile } = useCachedData<EmployeeProfile>(
    "my-profile",
    getMyProfile,
  );
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);

  async function handleChangePhoto() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "image/*",
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];

      if (asset.size && asset.size > MAX_PHOTO_BYTES) {
        Alert.alert("Photo Too Large", "Please choose an image under 5MB.");
        return;
      }

      const base64 = asset.base64 ?? (await new File(asset.uri).base64());
      const sizeBytes = asset.size ?? Math.ceil((base64.length * 3) / 4);

      if (sizeBytes > MAX_PHOTO_BYTES) {
        Alert.alert("Photo Too Large", "Please choose an image under 5MB.");
        return;
      }

      setIsUploadingPhoto(true);
      const updated = await updateMyPhoto(base64, asset.mimeType ?? "image/jpeg");
      setProfile(updated);
    } catch (error) {
      Alert.alert("Upload Failed", error instanceof Error ? error.message : "Please try again.");
    } finally {
      setIsUploadingPhoto(false);
    }
  }

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
          <View style={styles.avatarWrap}>
            {avatarSource ? (
              <Image source={{ uri: avatarSource }} style={styles.avatar} />
            ) : (
              <View style={[styles.avatar, styles.avatarPlaceholder]}>
                <Ionicons name="person" size={32} color="#94A3B8" />
              </View>
            )}

            <Pressable
              onPress={handleChangePhoto}
              disabled={isUploadingPhoto}
              style={({ pressed }) => [styles.avatarEditButton, pressed && { opacity: 0.8 }]}
            >
              {isUploadingPhoto ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Ionicons name="camera" size={16} color="#FFFFFF" />
              )}
            </Pressable>
          </View>

          <View style={styles.card}>
            <InfoRow icon="person-outline" label="Full Name" value={`${profile?.firstName ?? ""} ${profile?.lastName ?? ""}`} />
            <InfoRow icon="mail-outline" label="Email Address" value={profile?.user.email ?? "--"} />
            <InfoRow icon="call-outline" label="Contact Number" value={profile?.contactNumber ?? "Not provided"} />
            <InfoRow icon="business-outline" label="Department" value={profile?.department.name ?? "--"} />
            <InfoRow icon="briefcase-outline" label="Position" value={profile?.position.title ?? "--"} last />
          </View>

          <Text style={styles.note}>
            You can update your profile photo above. Other profile information is managed by HR — contact HR/Admin
            if any details need to be updated.
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
  avatarWrap: { alignSelf: "center", marginBottom: 12 },
  avatar: { width: 68, height: 68, borderRadius: 34 },
  avatarPlaceholder: { backgroundColor: "#F1F5F9", alignItems: "center", justifyContent: "center" },
  avatarEditButton: {
    position: "absolute",
    bottom: -2,
    right: -2,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: "#1680D8",
    borderWidth: 2,
    borderColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },
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
