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
  ScrollView,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { setInitialPassword } from "../api";
import { checkRequirements, getStrength } from "../utils/passwordStrength";

type Props = {
  onDone: () => void;
};

const STRENGTH_COPY: Record<"weak" | "strong", { label: string; color: string }> = {
  weak: { label: "Weak", color: "#DC2626" },
  strong: { label: "Strong", color: "#16A34A" },
};

export default function SetInitialPasswordScreen({ onDone }: Props) {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const requirements = checkRequirements(newPassword);
  const strength = getStrength(newPassword);
  const passwordsMatch = newPassword.length > 0 && newPassword === confirmPassword;
  const canSubmit = requirements.isValid && passwordsMatch && !isLoading;

  async function handleSubmit() {
    if (!canSubmit) return;

    setIsLoading(true);
    try {
      await setInitialPassword(newPassword);
      Alert.alert(
        "Password Set",
        "Your password has been saved. Please log in again using your new password.",
        [{ text: "OK", onPress: onDone }],
      );
    } catch (error) {
      Alert.alert("Something Went Wrong", error instanceof Error ? error.message : "Please try again.");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Ionicons name="shield-checkmark-outline" size={48} color="#062B59" style={{ marginBottom: 12 }} />
          <Text style={styles.title}>Set Your Password</Text>
          <Text style={styles.subtitle}>
            For your account's security, you need to set a password before you can continue using the app.
          </Text>

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
              contextMenuHidden
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

          {newPassword.length > 0 && !passwordsMatch && confirmPassword.length > 0 && (
            <Text style={styles.mismatch}>Passwords don't match.</Text>
          )}

          <View style={styles.requirements}>
            <RequirementRow met={requirements.minLength} label="At least 10 characters" />
            <RequirementRow met={requirements.hasLetter} label="Contains a letter" />
            <RequirementRow met={requirements.hasDigit} label="Contains a number" />
            <RequirementRow met={requirements.validCharset} label="Letters and numbers only" />
          </View>

          {strength && (
            <View style={styles.strengthRow}>
              <Text style={styles.strengthLabel}>Password Strength:</Text>
              <Text style={[styles.strengthValue, { color: STRENGTH_COPY[strength].color }]}>
                {STRENGTH_COPY[strength].label}
              </Text>
            </View>
          )}

          <Pressable
            style={[styles.button, !canSubmit && styles.buttonDisabled]}
            onPress={handleSubmit}
            disabled={!canSubmit}
          >
            <Text style={styles.buttonText}>{isLoading ? "Saving..." : "Set Password"}</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function RequirementRow({ met, label }: { met: boolean; label: string }) {
  return (
    <View style={styles.requirementRow}>
      <Ionicons
        name={met ? "checkmark-circle" : "ellipse-outline"}
        size={18}
        color={met ? "#16A34A" : "#94A3B8"}
      />
      <Text style={[styles.requirementText, met && styles.requirementTextMet]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F1F5F9" },
  content: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 60, paddingBottom: 40 },
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
  mismatch: { color: "#DC2626", fontSize: 13, marginTop: -12, marginBottom: 14 },
  requirements: { marginBottom: 8 },
  requirementRow: { flexDirection: "row", alignItems: "center", marginBottom: 8, gap: 8 },
  requirementText: { color: "#64748B", fontSize: 14 },
  requirementTextMet: { color: "#0F172A" },
  strengthRow: { flexDirection: "row", alignItems: "center", marginTop: 4, marginBottom: 20, gap: 6 },
  strengthLabel: { color: "#334155", fontSize: 14, fontWeight: "600" },
  strengthValue: { fontSize: 14, fontWeight: "700" },
  button: {
    height: 58,
    borderRadius: 16,
    backgroundColor: "#062B59",
    justifyContent: "center",
    alignItems: "center",
    marginTop: 10,
  },
  buttonDisabled: { backgroundColor: "#94A3B8" },
  buttonText: { color: "#FFFFFF", fontWeight: "700", fontSize: 16 },
});
