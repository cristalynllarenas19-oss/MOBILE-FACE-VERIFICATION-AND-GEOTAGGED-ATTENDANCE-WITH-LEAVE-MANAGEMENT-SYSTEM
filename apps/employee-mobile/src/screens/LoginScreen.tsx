import React, { useState } from "react";
import {
  SafeAreaView,
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Image,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

type Props = {
  email: string;
  password: string;
  setEmail: (value: string) => void;
  setPassword: (value: string) => void;
  isLoading: boolean;
  onLogin: () => void;
};

export default function LoginScreen({
  email,
  password,
  setEmail,
  setPassword,
  isLoading,
  onLogin,
}: Props) {
  const [showPassword, setShowPassword] =
    useState(false);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Image
          source={require("../assets/unileaf-logo.png")}
          style={styles.logo}
          resizeMode="contain"
        />

        <Text style={styles.title}>
          Welcome Back!
        </Text>

        <Text style={styles.subtitle}>
          Attendance & Leave Management System
        </Text>

        <Text style={styles.label}>
          Email Address
        </Text>

        <View style={styles.inputContainer}>
          <Ionicons
            name="mail-outline"
            size={20}
            color="#64748B"
          />

          <TextInput
            style={styles.input}
            placeholder="Enter your email address"
            placeholderTextColor="#94A3B8"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
          />
        </View>

        <Text style={styles.label}>
          Password
        </Text>

        <View style={styles.inputContainer}>
          <Ionicons
            name="lock-closed-outline"
            size={20}
            color="#64748B"
          />

          <TextInput
            style={styles.input}
            placeholder="Enter your password"
            placeholderTextColor="#94A3B8"
            secureTextEntry={!showPassword}
            value={password}
            onChangeText={setPassword}
          />

          <Pressable
            onPress={() =>
              setShowPassword(!showPassword)
            }
          >
            <Ionicons
              name={
                showPassword
                  ? "eye-off-outline"
                  : "eye-outline"
              }
              size={20}
              color="#64748B"
            />
          </Pressable>
        </View>

        <Pressable
          style={styles.loginButton}
          onPress={onLogin}
          disabled={isLoading}
        >
          <Text style={styles.loginButtonText}>
            {isLoading
              ? "Logging In..."
              : "Log In"}
          </Text>
        </Pressable>

        <Text style={styles.forgotPassword}>
          Forgot your password?
        </Text>

        <View style={styles.divider} />

        <Text style={styles.signupText}>
          Don't have an account?
          <Text style={styles.signupLink}>
            {" "}
            Sign Up
          </Text>
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F1F5F9",
  },

  content: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 30,
  },

  logo: {
    width: 500,
    height: 160,
    alignSelf: "center",
    marginBottom: 10,
  },

  title: {
    fontSize: 42,
    fontWeight: "700",
    color: "#062B59",
    textAlign: "center",
  },

  subtitle: {
    textAlign: "center",
    color: "#64748B",
    marginTop: 8,
    marginBottom: 40,
    fontSize: 13,
  },

  label: {
    color: "#334155",
    fontWeight: "600",
    marginBottom: 8,
    marginTop: 10,
    fontSize: 15,
  },

  inputContainer: {
    flexDirection: "row",
    alignItems: "center",
    height: 58,
    borderWidth: 1,
    borderColor: "#DBE5EF",
    borderRadius: 14,
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 16,
    marginBottom: 18,
  },

  input: {
    flex: 1,
    marginLeft: 10,
    fontSize: 15,
    color: "#0F172A",
  },

  loginButton: {
    height: 58,
    borderRadius: 14,
    backgroundColor: "#062B59",
    justifyContent: "center",
    alignItems: "center",
    marginTop: 12,
  },

  loginButtonText: {
    color: "#FFFFFF",
    fontWeight: "700",
    fontSize: 17,
  },

  forgotPassword: {
    textAlign: "center",
    color: "#94A3B8",
    marginTop: 24,
    fontSize: 15,
  },

  divider: {
    height: 1,
    backgroundColor: "#E2E8F0",
    marginVertical: 28,
    marginTop: 29,

  },

  signupText: {
    textAlign: "center",
    color: "#94A3B8",
    fontSize: 15,
    marginTop: 24,

  },

  signupLink: {
    color: "#062B59",
    fontWeight: "700",

  },
});