import { useState } from "react";
import { Alert } from "react-native";
import * as Location from "expo-location";

import LoginScreen from "./src/screens/LoginScreen";
import MainScreen from "./src/screens/MainScreen";

import {
  MobileUser,
  login,
  logout,
  apiRequest,
} from "./src/api";

export default function App() {
  // Empty by default
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [user, setUser] =
    useState<MobileUser | null>(null);

  const [isLoading, setIsLoading] =
    useState(false);

  async function handleLogin() {
    if (!email.trim() || !password.trim()) {
      Alert.alert(
        "Missing Information",
        "Please enter your email and password."
      );
      return;
    }

    setIsLoading(true);

    try {
      const loggedInUser =
        await login(email, password);

      setUser(loggedInUser);
    } catch {
      Alert.alert(
        "Login Failed",
        "Invalid email or password."
      );
    } finally {
      setIsLoading(false);
    }
  }

  async function handleLogout() {
    await logout();
    setUser(null);

    // Clear fields after logout
    setEmail("");
    setPassword("");
  }

  async function submitAttendance(
    logType: "TIME_IN" | "TIME_OUT"
  ) {
    if (!user?.employeeId) {
      Alert.alert(
        "Missing Employee Profile",
        "This account is not linked to an employee."
      );
      return;
    }

    const permission =
      await Location.requestForegroundPermissionsAsync();

    if (permission.status !== "granted") {
      Alert.alert(
        "Location Required",
        "Allow location access to submit attendance."
      );
      return;
    }

    setIsLoading(true);

    try {
      const location =
        await Location.getCurrentPositionAsync({
          accuracy:
            Location.Accuracy.High,
        });

      const result =
        await apiRequest<{
          approved: boolean;
          verificationStatus: string;
          geoResult: {
            reason?: string;
          };
        }>("/attendance/submit", {
          method: "POST",
          body: JSON.stringify({
            employeeId:
              user.employeeId,
            logType,
            latitude:
              location.coords.latitude,
            longitude:
              location.coords.longitude,
            accuracyMeters:
              location.coords.accuracy ??
              999,
            livenessScore: 98,
            similarityScore: 97,
            deviceId:
              "expo-demo-device",
          }),
        });

      Alert.alert(
        result.approved
          ? "Attendance Approved"
          : "Needs Review",
        result.geoResult.reason ??
          result.verificationStatus
      );
    } catch {
      Alert.alert(
        "Attendance Failed",
        "Check API Server and Geofence Configuration."
      );
    } finally {
      setIsLoading(false);
    }
  }

  if (!user) {
    return (
      <LoginScreen
        email={email}
        password={password}
        setEmail={setEmail}
        setPassword={setPassword}
        isLoading={isLoading}
        onLogin={handleLogin}
      />
    );
  }

  return (
    <MainScreen
      user={user}
      isLoading={isLoading}
      onLogout={handleLogout}
      onTimeIn={() =>
        submitAttendance("TIME_IN")
      }
      onTimeOut={() =>
        submitAttendance("TIME_OUT")
      }
    />
  );
}