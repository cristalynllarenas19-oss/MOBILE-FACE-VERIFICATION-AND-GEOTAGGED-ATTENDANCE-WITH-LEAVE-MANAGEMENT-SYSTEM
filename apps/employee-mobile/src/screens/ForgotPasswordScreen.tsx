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
import { forgotPassword } from "../api";

type Props = {
  onSubmitted: (email: string) => void;
  onBack: () => void;
};

export default function ForgotPasswordScreen({ onSubmitted, onBack }: Props) {
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit() {
    if (!email.trim()) {
      Alert.alert("Email Required", "Please enter your registered email address.");
      return;
    }

    setIsLoading(true);
    try {
      await forgotPassword(email.trim());
      onSubmitted(email.trim());
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
          <Pressable onPress={onBack} style={styles.backButton} hitSlop={10}>
            <Ionicons name="arrow-back" size={24} color="#062B59" />
          </Pressable>

          <Ionicons name="lock-open-outline" size={48} color="#062B59" style={{ marginBottom: 12 }} />
          <Text style={styles.title}>Forgot Password?</Text>
          <Text style={styles.subtitle}>
            Enter your registered email address and we'll send you a verification code.
          </Text>

          <Text style={styles.label}>Email Address</Text>
          <View style={styles.inputContainer}>
            <Ionicons name="mail-outline" size={20} color="#64748B" />
            <TextInput
              style={styles.input}
              placeholder="Enter your email address"
              placeholderTextColor="#94A3B8"
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <Pressable style={styles.button} onPress={handleSubmit} disabled={isLoading}>
            <Text style={styles.buttonText}>{isLoading ? "Sending..." : "Send Verification Code"}</Text>
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
  button: {
    height: 58,
    borderRadius: 16,
    backgroundColor: "#062B59",
    justifyContent: "center",
    alignItems: "center",
  },
  buttonText: { color: "#FFFFFF", fontWeight: "700", fontSize: 16 },
});
