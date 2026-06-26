import React, { useState } from "react";
import {
  SafeAreaView,
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  TouchableWithoutFeedback,
  Keyboard,
  Dimensions,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

const { width } = Dimensions.get("window");

type Props = {
  email: string;
  password: string;
  setEmail: (value: string) => void;
  setPassword: (value: string) => void;
  isLoading: boolean;
  onLogin: () => void;
  onForgotPassword: () => void;
};

export default function LoginScreen({
  email,
  password,
  setEmail,
  setPassword,
  isLoading,
  onLogin,
  onForgotPassword,
}: Props) {
  const [showPassword, setShowPassword] =
    useState(false);

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={
          Platform.OS === "ios" || Platform.OS === "android"
            ? "padding"
            : undefined
        }
      >
        <TouchableWithoutFeedback
          onPress={Keyboard.dismiss}
        >
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={
              styles.content
            }
            keyboardShouldPersistTaps="handled"
            bounces={false}
            alwaysBounceVertical={false}
            overScrollMode="never"
            showsVerticalScrollIndicator={
              false
            }
          >
            <Image
              source={require("../assets/unileaf-logo.png")}
              style={styles.logo}
              resizeMode="contain"
            />

            <Text style={styles.title}>
              Log In
            </Text>

            <Text style={styles.subtitle}>
              Attendance & Leave Management
              System
            </Text>

            <Text style={styles.label}>
              Email Address
            </Text>

            <View
              style={styles.inputContainer}
            >
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
                autoCorrect={false}
              />
            </View>

            <Text style={styles.label}>
              Password
            </Text>

            <View
              style={styles.inputContainer}
            >
              <Ionicons
                name="lock-closed-outline"
                size={20}
                color="#64748B"
              />

              <TextInput
                style={styles.input}
                placeholder="Enter your password"
                placeholderTextColor="#94A3B8"
                secureTextEntry={
                  !showPassword
                }
                value={password}
                onChangeText={
                  setPassword
                }
                autoCapitalize="none"
                autoCorrect={false}
              />

              <Pressable
                onPress={() =>
                  setShowPassword(
                    !showPassword
                  )
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
              style={
                styles.loginButton
              }
              onPress={onLogin}
              disabled={isLoading}
            >
              <Text
                style={
                  styles.loginButtonText
                }
              >
                {isLoading
                  ? "Logging In..."
                  : "Log In"}
              </Text>
            </Pressable>

            <Pressable onPress={onForgotPassword}>
              <Text
                style={
                  styles.forgotPassword
                }
              >
                Forgot your password?
              </Text>
            </Pressable>
          </ScrollView>
        </TouchableWithoutFeedback>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F1F5F9",
  },

  scroll: {
    flex: 1,
  },

  content: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
    paddingVertical: 40,
  },

  logo: {
    width: Math.min(width * 0.8, 320),
    height: 140,
    alignSelf: "center",
    marginBottom: 15,
  },

  title: {
    fontSize: width > 768 ? 48 : 42,
    fontWeight: "700",
    color: "#062B59",
    textAlign: "center",
  },

  subtitle: {
    textAlign: "center",
    color: "#64748B",
    marginTop: 8,
    marginBottom: 40,
    fontSize: 14,
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
    height: 60,
    borderWidth: 1,
    borderColor: "#D9E2EC",
    borderRadius: 16,
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 18,
    marginBottom: 18,

    shadowColor: "#000",
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },

  input: {
    flex: 1,
    marginLeft: 12,
    fontSize: 16,
    color: "#0F172A",
  },

  loginButton: {
    height: 60,
    borderRadius: 16,
    backgroundColor: "#062B59",
    justifyContent: "center",
    alignItems: "center",
    marginTop: 14,

    shadowColor: "#062B59",
    shadowOffset: {
      width: 0,
      height: 4,
    },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 5,
  },

  loginButtonText: {
    color: "#FFFFFF",
    fontWeight: "700",
    fontSize: 17,
  },

  forgotPassword: {
    textAlign: "center",
    color: "#1680D8",
    fontWeight: "600",
    marginTop: 22,
    fontSize: 15,
  },
});
