import { useEffect, useState } from "react";
import { Alert } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as Location from "expo-location";

import LoginScreen from "./src/screens/LoginScreen";
import MainScreen from "./src/screens/MainScreen";
import CameraScanner from "./src/components/CameraScanner";
import ResultModal, { ResultModalStatus } from "./src/components/ResultModal";
import VerifyOtpScreen from "./src/screens/VerifyOtpScreen";
import NewPasswordScreen from "./src/screens/NewPasswordScreen";

import {
  MobileUser,
  TodayAttendance,
  login,
  logout,
  checkApiHealth,
  getTodayAttendance,
  submitAttendance,
  getMyWorkLocation,
  forgotPassword,
} from "./src/api";
import { getFriendlyReason } from "./src/utils/attendanceMessages";
import { distanceInMeters } from "./src/utils/geofence";

type ResultModalState = {
  status: ResultModalStatus;
  title: string;
  message: string;
};

type AuthView = "login" | "forgot-otp" | "forgot-new-password";

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

  const [authView, setAuthView] = useState<AuthView>("login");
  const [resetEmail, setResetEmail] = useState("");
  const [resetToken, setResetToken] = useState("");

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

  async function handleForgotPassword() {
    if (!email.trim()) {
      Alert.alert("Email Required", "Please enter your email address above first.");
      return;
    }

    setIsLoading(true);
    try {
      await forgotPassword(email.trim());
      setResetEmail(email.trim());
      setAuthView("forgot-otp");
    } catch (error) {
      Alert.alert("Something Went Wrong", error instanceof Error ? error.message : "Please try again.");
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

  async function startScan(type: "TIME_IN" | "TIME_OUT") {
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

    const isOutsideWorkArea = await checkOutsideWorkArea();
    if (isOutsideWorkArea) {
      Alert.alert(
        "Outside Work Area",
        "You appear to be outside your designated work area. You can still continue, but your attendance may be flagged for review.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Continue Anyway", onPress: () => setScanType(type) },
        ],
      );
      return;
    }

    setScanType(type);
  }

  async function checkOutsideWorkArea() {
    try {
      const [workLocation, position] = await Promise.all([
        getMyWorkLocation(),
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      ]);

      if (!workLocation) return false;

      const distance = distanceInMeters(
        position.coords.latitude,
        position.coords.longitude,
        Number(workLocation.latitude),
        Number(workLocation.longitude),
      );

      return distance > Number(workLocation.radiusMeters);
    } catch (error) {
      console.error("Failed to check work area before scan", error);
      return false;
    }
  }

  async function handleScanComplete(location: Location.LocationObject, faceBase64?: string) {
    if (!scanType || !user?.employeeId) return;

    setIsLoading(true);
    setScanType(null);

    try {
      const result = await submitAttendance({
        employeeId: user.employeeId,
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
        accuracyMeters: location.coords.accuracy ?? 999,
        livenessScore: 100,
        similarityScore: 100,
        faceImageBase64: faceBase64 ?? "",
        deviceId: "expo-demo-device",
      });

      // The server is the authority on whether this was a Time In or Time Out.
      const actionLabel = result.logType === "TIME_IN" ? "Time In" : "Time Out";
      const reason = result.faceResult.reason ?? result.geoResult.reason;
      const friendlyMessage = getFriendlyReason(reason, result.verificationStatus);
      const timestamp = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

      if (result.verificationStatus === "APPROVED") {
        setResultModal({
          status: "approved",
          title: `${actionLabel} Recorded`,
          message: `Verified at ${timestamp}. Your Daily Time Record has been updated. ${friendlyMessage}`,
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

  function backToLogin() {
    setAuthView("login");
    setResetEmail("");
    setResetToken("");
  }

  return (
    <SafeAreaProvider>
      {!user && authView === "forgot-otp" ? (
        <VerifyOtpScreen
          email={resetEmail}
          onVerified={(token) => {
            setResetToken(token);
            setAuthView("forgot-new-password");
          }}
          onBack={backToLogin}
        />
      ) : !user && authView === "forgot-new-password" ? (
        <NewPasswordScreen resetToken={resetToken} onDone={backToLogin} />
      ) : !user ? (
        <LoginScreen
          email={email}
          password={password}
          setEmail={setEmail}
          setPassword={setPassword}
          isLoading={isLoading}
          onLogin={handleLogin}
          onForgotPassword={handleForgotPassword}
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
    </SafeAreaProvider>
  );
}
