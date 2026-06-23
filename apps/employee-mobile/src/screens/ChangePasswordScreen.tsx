import React, { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, ScrollView, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { changePassword } from "../api";

type Props = {
  onClose: () => void;
};

export default function ChangePasswordScreen({ onClose }: Props) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  async function handleSave() {
    if (!currentPassword) {
      Alert.alert("Missing Information", "Please enter your current password.");
      return;
    }
    if (newPassword.length < 8) {
      Alert.alert("Password Too Short", "Your new password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      Alert.alert("Passwords Don't Match", "Please make sure both passwords match.");
      return;
    }

    setIsSaving(true);
    try {
      await changePassword(currentPassword, newPassword);
      Alert.alert("Password Updated", "Your password has been changed.", [{ text: "OK", onPress: onClose }]);
    } catch (error) {
      Alert.alert("Update Failed", error instanceof Error ? error.message : "Please try again.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Pressable onPress={onClose} style={styles.backButton} hitSlop={10}>
        <Ionicons name="arrow-back" size={24} color="#062B59" />
      </Pressable>

      <Text style={styles.title}>Change Password</Text>
      <Text style={styles.subtitle}>Enter your current password and choose a new one.</Text>

      <Text style={styles.label}>Current Password</Text>
      <TextInput style={styles.input} value={currentPassword} onChangeText={setCurrentPassword} secureTextEntry autoCapitalize="none" />

      <Text style={styles.label}>New Password</Text>
      <TextInput style={styles.input} value={newPassword} onChangeText={setNewPassword} secureTextEntry autoCapitalize="none" />

      <Text style={styles.label}>Confirm New Password</Text>
      <TextInput style={styles.input} value={confirmPassword} onChangeText={setConfirmPassword} secureTextEntry autoCapitalize="none" />

      <Pressable style={styles.button} onPress={handleSave} disabled={isSaving}>
        <Text style={styles.buttonText}>{isSaving ? "Saving..." : "Update Password"}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#FFFFFF" },
  content: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 40 },
  backButton: { width: 40, height: 40, justifyContent: "center" },
  title: { fontSize: 22, fontWeight: "700", color: "#062B59", marginTop: 0 },
  subtitle: { color: "#64748B", marginTop: 6, marginBottom: 20, fontSize: 13 },
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
