import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Image,
  ScrollView,
  ActivityIndicator,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { File } from "expo-file-system";
import { EmployeeProfile, getMyProfile, updateMyProfile } from "../api";

type Props = {
  onClose: () => void;
  onUpdated: () => void;
};

export default function EditProfileScreen({ onClose, onUpdated }: Props) {
  const [profile, setProfile] = useState<EmployeeProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [contactNumber, setContactNumber] = useState("");
  const [photo, setPhoto] = useState<{ base64: string; mimeType: string } | null>(null);

  useEffect(() => {
    getMyProfile()
      .then((data) => {
        setProfile(data);
        setFirstName(data.firstName);
        setLastName(data.lastName);
        setEmail(data.user.email);
        setContactNumber(data.contactNumber ?? "");
      })
      .catch((error) => Alert.alert("Failed to Load Profile", error instanceof Error ? error.message : "Please try again."))
      .finally(() => setIsLoading(false));
  }, []);

  async function pickPhoto() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Permission Needed", "Please allow photo library access to set a profile picture.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.5,
      base64: true,
    });

    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    const base64 = asset.base64 ?? (await new File(asset.uri).base64());
    setPhoto({ base64: `data:${asset.mimeType ?? "image/jpeg"};base64,${base64}`, mimeType: asset.mimeType ?? "image/jpeg" });
  }

  async function handleSave() {
    if (!firstName.trim() || !lastName.trim() || !email.trim()) {
      Alert.alert("Missing Information", "Name and email are required.");
      return;
    }

    setIsSaving(true);
    try {
      await updateMyProfile({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
        contactNumber: contactNumber.trim(),
        ...(photo ? { profilePhotoData: photo.base64, profilePhotoMimeType: photo.mimeType } : {}),
      });
      onUpdated();
      Alert.alert("Profile Updated", "Your profile information has been saved.", [{ text: "OK", onPress: onClose }]);
    } catch (error) {
      Alert.alert("Update Failed", error instanceof Error ? error.message : "Please try again.");
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#1680D8" />
      </View>
    );
  }

  const avatarSource = photo?.base64
    ?? (profile?.profilePhotoData ? `data:${profile.profilePhotoMimeType ?? "image/jpeg"};base64,${profile.profilePhotoData}` : null);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Pressable onPress={onClose} style={styles.backButton} hitSlop={10}>
        <Ionicons name="arrow-back" size={24} color="#062B59" />
      </Pressable>

      <Text style={styles.title}>Edit Profile</Text>

      <Pressable onPress={pickPhoto} style={styles.avatarWrapper}>
        {avatarSource ? (
          <Image source={{ uri: avatarSource }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarPlaceholder]}>
            <Ionicons name="person" size={40} color="#94A3B8" />
          </View>
        )}
        <View style={styles.avatarEditBadge}>
          <Ionicons name="camera" size={14} color="#FFFFFF" />
        </View>
      </Pressable>

      <Text style={styles.label}>First Name</Text>
      <TextInput style={styles.input} value={firstName} onChangeText={setFirstName} />

      <Text style={styles.label}>Last Name</Text>
      <TextInput style={styles.input} value={lastName} onChangeText={setLastName} />

      <Text style={styles.label}>Email Address</Text>
      <TextInput
        style={styles.input}
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoCapitalize="none"
      />

      <Text style={styles.label}>Contact Number</Text>
      <TextInput
        style={styles.input}
        value={contactNumber}
        onChangeText={setContactNumber}
        keyboardType="phone-pad"
        placeholder="e.g. 09171234567"
      />

      <Pressable style={styles.button} onPress={handleSave} disabled={isSaving}>
        <Text style={styles.buttonText}>{isSaving ? "Saving..." : "Save Changes"}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#FFFFFF" },
  content: { padding: 20, paddingBottom: 40 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  backButton: { width: 40, height: 40, justifyContent: "center" },
  title: { fontSize: 22, fontWeight: "700", color: "#062B59", marginBottom: 16 },
  avatarWrapper: { alignSelf: "center", marginBottom: 24 },
  avatar: { width: 96, height: 96, borderRadius: 48 },
  avatarPlaceholder: { backgroundColor: "#F1F5F9", alignItems: "center", justifyContent: "center" },
  avatarEditBadge: {
    position: "absolute",
    bottom: 0,
    right: 0,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "#1680D8",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "#FFFFFF",
  },
  label: { color: "#334155", fontWeight: "600", marginBottom: 6, marginTop: 14, fontSize: 14 },
  input: {
    height: 50,
    borderWidth: 1,
    borderColor: "#D9E2EC",
    borderRadius: 12,
    paddingHorizontal: 14,
    fontSize: 15,
    color: "#0F172A",
  },
  button: {
    height: 54,
    borderRadius: 14,
    backgroundColor: "#062B59",
    justifyContent: "center",
    alignItems: "center",
    marginTop: 28,
  },
  buttonText: { color: "#FFFFFF", fontWeight: "700", fontSize: 15 },
});
