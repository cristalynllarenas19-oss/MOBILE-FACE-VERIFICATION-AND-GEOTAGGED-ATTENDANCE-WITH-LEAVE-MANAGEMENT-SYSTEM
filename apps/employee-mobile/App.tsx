import { useEffect, useState } from "react";
import { Alert } from "react-native";
import * as Location from "expo-location";

import LoginScreen from "./src/screens/LoginScreen";
import MainScreen from "./src/screens/MainScreen";
import CameraScanner from "./src/components/CameraScanner";
import ResultModal, { ResultModalStatus } from "./src/components/ResultModal";

import {
  MobileUser,
  TodayAttendance,
  login,
  logout,
  checkApiHealth,
  getTodayAttendance,
  submitAttendance,
} from "./src/api";
import { getFriendlyReason } from "./src/utils/attendanceMessages";

type ResultModalState = {
  status: ResultModalStatus;
  title: string;
  message: string;
};

export default function App() {
  // Empty by default
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [user, setUser] =
    useState<MobileUser | null>(null);

  const [todayAttendance, setTodayAttendance] =
    useState<TodayAttendance | null>(null);

  const [isLoading, setIsLoading] =
    useState(false);

  const [scanType, setScanType] = useState<"TIME_IN" | "TIME_OUT" | null>(null);
  const [resultModal, setResultModal] = useState<ResultModalState | null>(null);

  useEffect(() => {
    if (user?.employeeId) {
      refreshTodayAttendance(user.employeeId);
    }
  }, [user?.employeeId]);

  async function refreshTodayAttendance(employeeId: string) {
    try {
      const attendance = await getTodayAttendance(employeeId);
      setTodayAttendance(attendance);
    } catch (error) {
      console.error("Failed to load today's attendance", error);
    }
  }

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
    setTodayAttendance(null);

    // Clear fields after logout
    setEmail("");
    setPassword("");
  }

  function startScan(type: "TIME_IN" | "TIME_OUT") {
    if (!user?.employeeId) {
      setResultModal({
        status: "error",
        title: "Missing Employee Profile",
        message: "This account isn't linked to an employee record. Contact HR for assistance.",
      });
      return;
    }

    if (type === "TIME_IN" && todayAttendance?.timeInAt) {
      setResultModal({
        status: "info",
        title: "Already Timed In",
        message: "You've already timed in today. Tap Time Out when your shift ends.",
      });
      return;
    }

    if (type === "TIME_OUT" && !todayAttendance?.timeInAt) {
      setResultModal({
        status: "info",
        title: "Time In Required",
        message: "You need to time in before you can time out.",
      });
      return;
    }

    if (type === "TIME_OUT" && todayAttendance?.timeOutAt) {
      setResultModal({
        status: "info",
        title: "Already Timed Out",
        message: "You've already timed out today. See you next shift!",
      });
      return;
    }

    setScanType(type);
  }

  async function handleScanComplete(location: Location.LocationObject, faceBase64?: string) {
    if (!scanType || !user?.employeeId) return;

    setIsLoading(true);
    const currentScanType = scanType;
    setScanType(null);
    const actionLabel = currentScanType === "TIME_IN" ? "Time In" : "Time Out";

    try {
      const result = await submitAttendance({
        employeeId: user.employeeId,
        logType: currentScanType,
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
        accuracyMeters: location.coords.accuracy ?? 999,
        livenessScore: 100,
        similarityScore: 100,
        faceImageBase64: faceBase64 ?? "",
        deviceId: "expo-demo-device",
      });

      const reason = result.faceResult.reason ?? result.geoResult.reason;
      const friendlyMessage = getFriendlyReason(reason, result.verificationStatus);
      const timestamp = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

      if (result.verificationStatus === "APPROVED") {
        setResultModal({
          status: "approved",
          title: `${actionLabel} Recorded`,
          message: `Verified at ${timestamp}. ${friendlyMessage}`,
        });
      } else if (result.verificationStatus === "PENDING_REVIEW") {
        setResultModal({
          status: "pending",
          title: `${actionLabel} Pending Review`,
          message: friendlyMessage,
        });
      } else {
        setResultModal({
          status: "rejected",
          title: `${actionLabel} Not Recorded`,
          message: friendlyMessage,
        });
      }

      await refreshTodayAttendance(user.employeeId);
    } catch (error) {
      setResultModal({
        status: "error",
        title: "Submission Error",
        message:
          error instanceof Error
            ? error.message
            : "Failed to connect to the server. Check your connection and try again.",
      });
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <>
      {!user ? (
        <LoginScreen
          email={email}
          password={password}
          setEmail={setEmail}
          setPassword={setPassword}
          isLoading={isLoading}
          onLogin={handleLogin}
        />
      ) : scanType ? (
        <CameraScanner
          logType={scanType}
          onComplete={handleScanComplete}
          onCancel={() => setScanType(null)}
        />
      ) : (
        <MainScreen
          user={user}
          isLoading={isLoading}
          todayAttendance={todayAttendance}
          onLogout={handleLogout}
          onTimeIn={() => startScan("TIME_IN")}
          onTimeOut={() => startScan("TIME_OUT")}
        />
      )}

      <ResultModal
        visible={!!resultModal}
        status={resultModal?.status ?? "info"}
        title={resultModal?.title ?? ""}
        message={resultModal?.message ?? ""}
        onClose={() => setResultModal(null)}
      />
    </>
  );
}
