import React, { useEffect, useState } from "react";
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
import { forgotPassword, verifyResetOtp } from "../api";

const RESEND_COOLDOWN_SECONDS = 60;

type Props = {
  email: string;
  onVerified: (resetToken: string) => void;
  onBack: () => void;
};

export default function VerifyOtpScreen({ email, onVerified, onBack }: Props) {
  const [otp, setOtp] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function handleVerify() {
    if (otp.trim().length !== 6) {
      Alert.alert("Invalid Code", "Please enter the 6-digit code sent to your email.");
      return;
    }

    setIsLoading(true);
    try {
      const { resetToken } = await verifyResetOtp(email, otp.trim());
      onVerified(resetToken);
    } catch (error) {
      Alert.alert("Verification Failed", error instanceof Error ? error.message : "Please try again.");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleResend() {
    if (cooldown > 0) return;
    try {
      await forgotPassword(email);
      setCooldown(RESEND_COOLDOWN_SECONDS);
      Alert.alert("Code Sent", "A new verification code has been sent to your email.");
    } catch (error) {
      Alert.alert("Something Went Wrong", error instanceof Error ? error.message : "Please try again.");
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.content}>
          <Pressable onPress={onBack} style={styles.backButton} hitSlop={10}>
            <Ionicons name="arrow-back" size={24} color="#062B59" />
          </Pressable>

          <Ionicons name="mail-unread-outline" size={48} color="#062B59" style={{ marginBottom: 12 }} />
          <Text style={styles.title}>Enter Verification Code</Text>
          <Text style={styles.subtitle}>We sent a 6-digit code to {email}. It expires in 10 minutes.</Text>

          <Text style={styles.label}>Verification Code</Text>
          <View style={styles.inputContainer}>
            <Ionicons name="key-outline" size={20} color="#64748B" />
            <TextInput
              style={[styles.input, styles.otpInput]}
              placeholder="000000"
              placeholderTextColor="#94A3B8"
              value={otp}
              onChangeText={(value) => setOtp(value.replace(/[^0-9]/g, "").slice(0, 6))}
              keyboardType="number-pad"
              maxLength={6}
            />
          </View>

          <Pressable style={styles.button} onPress={handleVerify} disabled={isLoading}>
            <Text style={styles.buttonText}>{isLoading ? "Verifying..." : "Verify Code"}</Text>
          </Pressable>

          <Pressable onPress={handleResend} disabled={cooldown > 0} style={styles.resendButton}>
            <Text style={[styles.resendText, cooldown > 0 && styles.resendTextDisabled]}>
              {cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend Code"}
            </Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F1F5F9" },
  content: { flex: 1, paddingHorizontal: 24, paddingTop: 20 },
  backButton: { width: 40, height: 40, justifyContent: "center", marginBottom: 12 },
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
    marginBottom: 24,
  },
  input: { flex: 1, marginLeft: 12, fontSize: 16, color: "#0F172A" },
  otpInput: { fontSize: 20, fontWeight: "700", letterSpacing: 4 },
  button: {
    height: 58,
    borderRadius: 16,
    backgroundColor: "#062B59",
    justifyContent: "center",
    alignItems: "center",
  },
  buttonText: { color: "#FFFFFF", fontWeight: "700", fontSize: 16 },
  resendButton: { marginTop: 20, alignItems: "center" },
  resendText: { color: "#1680D8", fontWeight: "700", fontSize: 14 },
  resendTextDisabled: { color: "#94A3B8" },
});
