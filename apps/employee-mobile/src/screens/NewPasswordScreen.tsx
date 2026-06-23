import React, { useState } from "react";
import {
  SafeAreaView,
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { resetPassword } from "../api";

type Props = {
  resetToken: string;
  onDone: () => void;
};

export default function NewPasswordScreen({ resetToken, onDone }: Props) {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit() {
    if (newPassword.length < 8) {
      Alert.alert("Password Too Short", "Your new password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      Alert.alert("Passwords Don't Match", "Please make sure both passwords match.");
      return;
    }

    setIsLoading(true);
    try {
      await resetPassword(resetToken, newPassword);
      Alert.alert("Password Updated", "You can now log in with your new password.", [
        { text: "OK", onPress: onDone },
      ]);
    } catch (error) {
      Alert.alert("Something Went Wrong", error instanceof Error ? error.message : "Please try again.");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.content}>
          <Ionicons name="lock-closed-outline" size={48} color="#062B59" style={{ marginBottom: 12 }} />
          <Text style={styles.title}>Create New Password</Text>
          <Text style={styles.subtitle}>Your new password must be different from previously used passwords.</Text>

          <Text style={styles.label}>New Password</Text>
          <View style={styles.inputContainer}>
            <Ionicons name="lock-closed-outline" size={20} color="#64748B" />
            <TextInput
              style={styles.input}
              placeholder="Enter new password"
              placeholderTextColor="#94A3B8"
              secureTextEntry={!showPassword}
              value={newPassword}
              onChangeText={setNewPassword}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Pressable onPress={() => setShowPassword(!showPassword)}>
              <Ionicons name={showPassword ? "eye-off-outline" : "eye-outline"} size={20} color="#64748B" />
            </Pressable>
          </View>

          <Text style={styles.label}>Confirm New Password</Text>
          <View style={styles.inputContainer}>
            <Ionicons name="lock-closed-outline" size={20} color="#64748B" />
            <TextInput
              style={styles.input}
              placeholder="Re-enter new password"
              placeholderTextColor="#94A3B8"
              secureTextEntry={!showPassword}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <Pressable style={styles.button} onPress={handleSubmit} disabled={isLoading}>
            <Text style={styles.buttonText}>{isLoading ? "Updating..." : "Update Password"}</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F1F5F9" },
  content: { flex: 1, paddingHorizontal: 24, paddingTop: 60 },
  title: { fontSize: 26, fontWeight: "700", color: "#062B59" },
  subtitle: { color: "#64748B", marginTop: 8, marginBottom: 28, fontSize: 14, lineHeight: 20 },
  label: { color: "#334155", fontWeight: "600", marginBottom: 8, fontSize: 15 },
  inputContainer: {
    flexDirection: "row",
    alignItems: "center",
    height: 58,
    borderWidth: 1,
    borderColor: "#D9E2EC",
    borderRadius: 16,
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 18,
    marginBottom: 18,
  },
  input: { flex: 1, marginLeft: 12, fontSize: 16, color: "#0F172A" },
  button: {
    height: 58,
    borderRadius: 16,
    backgroundColor: "#062B59",
    justifyContent: "center",
    alignItems: "center",
    marginTop: 10,
  },
  buttonText: { color: "#FFFFFF", fontWeight: "700", fontSize: 16 },
});
