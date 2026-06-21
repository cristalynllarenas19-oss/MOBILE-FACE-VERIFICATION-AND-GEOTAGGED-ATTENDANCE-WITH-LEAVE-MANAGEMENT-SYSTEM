import { useState } from "react";
import { Alert } from "react-native";
import * as Location from "expo-location";

import LoginScreen from "./src/screens/LoginScreen";
import MainScreen from "./src/screens/MainScreen";
import CameraScanner from "./src/components/CameraScanner";

import {
  MobileUser,
  login,
  logout,
  apiRequest,
  checkApiHealth,
} from "./src/api";

export default function App() {
  // Empty by default
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [user, setUser] =
    useState<MobileUser | null>(null);

  const [isLoading, setIsLoading] =
    useState(false);

  const [scanType, setScanType] = useState<"TIME_IN" | "TIME_OUT" | null>(null);

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
      await checkApiHealth();
      const loggedInUser =
        await login(email, password);

      setUser(loggedInUser);
    } catch (error) {
      Alert.alert(
        "Login Failed",
        error instanceof Error ? error.message : "Invalid email or password."
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

  function startScan(type: "TIME_IN" | "TIME_OUT") {
    if (!user?.employeeId) {
      Alert.alert("Missing Employee Profile", "This account is not linked to an employee.");
      return;
    }
    setScanType(type);
  }

  async function handleScanComplete(location: Location.LocationObject, faceBase64?: string) {
    if (!scanType || !user) return;
    
    setIsLoading(true);
    const currentScanType = scanType;
    setScanType(null);

    try {
      const result = await apiRequest<{
        approved: boolean;
        verificationStatus: string;
        geoResult: { reason?: string };
        faceResult: { reason?: string };
      }>("/attendance/submit", {
        method: "POST",
        body: JSON.stringify({
          employeeId: user.employeeId,
          logType: currentScanType,
          latitude: location.coords.latitude,
          longitude: location.coords.longitude,
          accuracyMeters: location.coords.accuracy ?? 999,
          livenessScore: 100,
          similarityScore: 100,
          faceImageBase64: faceBase64 ?? "",
          deviceId: "expo-demo-device",
        }),
      });

      Alert.alert(
        result.approved ? "✅ Attendance Approved" : "❌ Verification Failed",
        result.geoResult.reason ?? result.faceResult.reason ?? result.verificationStatus
      );
    } catch (error) {
      Alert.alert("Submission Error", error instanceof Error ? error.message : "Failed to connect to the server.");
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

  if (scanType) {
    return (
      <CameraScanner
        logType={scanType}
        onComplete={handleScanComplete}
        onCancel={() => setScanType(null)}
      />
    );
  }

  return (
    <MainScreen
      user={user}
      isLoading={isLoading}
      onLogout={handleLogout}
      onTimeIn={() => startScan("TIME_IN")}
      onTimeOut={() => startScan("TIME_OUT")}
    />
  );
}
