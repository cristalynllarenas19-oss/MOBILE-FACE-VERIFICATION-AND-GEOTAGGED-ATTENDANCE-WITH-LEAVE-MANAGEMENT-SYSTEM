import { useCallback, useEffect, useState } from "react";
import { Alert } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as Location from "expo-location";

import LoginScreen from "./src/screens/LoginScreen";
import MainScreen from "./src/screens/MainScreen";
import SupervisorMainScreen from "./src/screens/SupervisorMainScreen";
import CameraScanner from "./src/components/CameraScanner";
import ResultModal, { ResultModalStatus } from "./src/components/ResultModal";
import VerifyOtpScreen from "./src/screens/VerifyOtpScreen";
import NewPasswordScreen from "./src/screens/NewPasswordScreen";
import SetInitialPasswordScreen from "./src/screens/SetInitialPasswordScreen";
import SplashScreen from "./src/screens/SplashScreen";

import {
  MobileUser,
  TodayAttendance,
  WorkLocation,
  AttendanceEligibility,
  login,
  logout,
  restoreSession,
  checkApiHealth,
  getTodayAttendance,
  submitAttendance,
  getMyWorkLocation,
  getMyWorkLocations,
  getMyProfile,
  forgotPassword,
} from "./src/api";
import { getFriendlyReason } from "./src/utils/attendanceMessages";
import { distanceInMeters } from "./src/utils/geofence";
import { Portal } from "./src/types";

type ResultModalState = {
  status: ResultModalStatus;
  title: string;
  message: string;
};

type AuthView = "login" | "forgot-otp" | "forgot-new-password";

// Mirrors admin-web's getLandingPage (apps/admin-web/src/app/App.tsx:31-37):
// single-role accounts always land on their one portal; multi-role accounts
// honor the saved defaultView, falling back to the supervisor/admin portal
// when unset.
function getLandingPortal(user: MobileUser | null): Portal {
  if (!user) return "employee";
  const roles = user.roles ?? [user.role];
  if (roles.length <= 1) {
    return user.role === "EMPLOYEE" ? "employee" : "supervisor";
  }
  return user.defaultView === "EMPLOYEE" ? "employee" : "supervisor";
}

export default function App() {
  // Empty by default
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [user, setUser] =
    useState<MobileUser | null>(null);

  const [portal, setPortal] = useState<Portal>("employee");

  const [todayAttendance, setTodayAttendance] =
    useState<TodayAttendance | null>(null);

  // Null while still loading — treated the same as "not eligible" so the
  // buttons never flash enabled before this resolves.
  const [eligibility, setEligibility] = useState<AttendanceEligibility | null>(null);

  const [isLoading, setIsLoading] =
    useState(false);

  const [scanType, setScanType] = useState<"TIME_IN" | "TIME_OUT" | "LUNCH_OUT" | "LUNCH_IN" | null>(null);
  const [resultModal, setResultModal] = useState<ResultModalState | null>(null);

  // FIELD-employee site visit state: which site they're about to start a
  // visit at (auto-detected from GPS, carried through to the camera capture
  // and the submission).
  const [selectedWorkLocation, setSelectedWorkLocation] = useState<WorkLocation | null>(null);

  const [authView, setAuthView] = useState<AuthView>("login");
  const [resetEmail, setResetEmail] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [hasSplashAnimationFinished, setHasSplashAnimationFinished] = useState(false);
  const [hasSessionCheckFinished, setHasSessionCheckFinished] = useState(false);

  const handleSplashAnimationComplete = useCallback(() => {
    setHasSplashAnimationFinished(true);
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function restoreSavedSession() {
      try {
        const restoredUser = await restoreSession();
        if (isMounted && restoredUser) {
          setUser(restoredUser);
          setPortal(getLandingPortal(restoredUser));
        }
      } catch (error) {
        console.error("Failed to restore saved session", error);
      } finally {
        if (isMounted) {
          setHasSessionCheckFinished(true);
        }
      }
    }

    restoreSavedSession();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (user?.employeeId) {
      refreshTodayAttendance(user.employeeId);
      refreshEligibility(user.employeeId, user.attendanceMode);
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

  async function refreshEligibility(employeeId: string, attendanceMode?: "FIXED" | "FIELD") {
    try {
      const [profile, hasWorkLocation] = await Promise.all([
        getMyProfile(),
        attendanceMode === "FIELD"
          ? getMyWorkLocations().then((sites) => sites.length > 0)
          : getMyWorkLocation().then((location) => location !== null),
      ]);
      setEligibility({ faceEnrolled: Boolean(profile.hasActiveFaceEnrollment), hasWorkLocation });
    } catch (error) {
      console.error("Failed to load attendance eligibility", error);
      setEligibility({ faceEnrolled: false, hasWorkLocation: false });
    }
  }

  async function handleLogin() {
    if (!email.trim()) {
      Alert.alert(
        "Missing Information",
        "Please enter your email address."
      );
      return;
    }

    setIsLoading(true);

    try {
      await checkApiHealth();
      const loggedInUser =
        await login(email.trim(), password.trim() || undefined);

      setUser(loggedInUser);
      setPortal(getLandingPortal(loggedInUser));
    } catch (error) {
      Alert.alert(
        "Login Failed",
        error instanceof Error ? error.message : "Invalid email or password."
      );
    } finally {
      setIsLoading(false);
    }
  }

  // Called once a first-time employee finishes setting their password — they
  // must log back in with it, so this just reuses the normal logout path.
  async function handlePasswordSetupComplete() {
    await handleLogout();
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
    setPortal("employee");
    setTodayAttendance(null);
    setEligibility(null);

    // Clear fields after logout
    setEmail("");
    setPassword("");
  }

  async function startScan(type: "TIME_IN" | "TIME_OUT" | "LUNCH_OUT" | "LUNCH_IN") {
    if (!user?.employeeId) {
      setResultModal({
        status: "error",
        title: "Missing Employee Profile",
        message: "This account isn't linked to an employee record. Contact HR for assistance.",
      });
      return;
    }

    const isEligible = Boolean(eligibility?.faceEnrolled && eligibility?.hasWorkLocation);
    if (!isEligible) {
      const missingBoth = !eligibility?.faceEnrolled && !eligibility?.hasWorkLocation;
      setResultModal({
        status: "error",
        title: "Attendance Not Available",
        message: missingBoth
          ? "Your face is not yet registered and you haven't been assigned a work location. Contact HR to get set up before recording attendance."
          : !eligibility?.faceEnrolled
            ? "Your face is not yet registered for attendance verification. Contact HR to complete your face enrollment."
            : "You haven't been assigned a work location yet. Contact HR or your supervisor.",
      });
      return;
    }

    if (user.attendanceMode === "FIELD") {
      // Lunch break is OFFICE-only — AttendanceScreen never wires these
      // buttons up for a FIELD employee, so this cast is safe.
      await startFieldScan(type as "TIME_IN" | "TIME_OUT");
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

    if (type === "LUNCH_OUT" || type === "LUNCH_IN") {
      if (!todayAttendance?.timeInAt) {
        setResultModal({
          status: "info",
          title: "Time In Required",
          message: "You need to time in before logging your lunch break.",
        });
        return;
      }

      if (todayAttendance?.timeOutAt) {
        setResultModal({
          status: "info",
          title: "Already Timed Out",
          message: "You've already timed out today.",
        });
        return;
      }

      if (type === "LUNCH_OUT" && todayAttendance?.lunchOutAt) {
        setResultModal({
          status: "info",
          title: "Lunch Break Already Started",
          message: "You've already logged the start of your lunch break.",
        });
        return;
      }

      if (type === "LUNCH_IN" && !todayAttendance?.lunchOutAt) {
        setResultModal({
          status: "info",
          title: "Lunch Break Not Started",
          message: "Log Lunch Out before Lunch In.",
        });
        return;
      }

      if (type === "LUNCH_IN" && todayAttendance?.lunchInAt) {
        setResultModal({
          status: "info",
          title: "Lunch Break Already Ended",
          message: "You've already logged the end of your lunch break.",
        });
        return;
      }
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

  // FIELD employees have no single fixed time-in/out pair — sequencing
  // (can't start a new visit while one's still open) is enforced by the
  // server, not re-derived here. Starting a visit auto-detects which
  // assigned site the technician is at from their current GPS position
  // (closest assigned site wins) rather than asking them to pick one;
  // ending one doesn't need this, since the server resolves the site from
  // whichever visit is currently open.
  async function startFieldScan(type: "TIME_IN" | "TIME_OUT") {
    if (type === "TIME_OUT") {
      setScanType("TIME_OUT");
      return;
    }

    try {
      const sites = await getMyWorkLocations();
      if (sites.length === 0) {
        setResultModal({
          status: "error",
          title: "No Assigned Sites",
          message: "You don't have any assigned work sites yet. Contact your supervisor.",
        });
        return;
      }

      if (sites.length === 1) {
        await handleSiteSelected(sites[0]);
        return;
      }

      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const nearestSite = sites.reduce((closest, site) => {
        const distance = distanceInMeters(
          position.coords.latitude,
          position.coords.longitude,
          Number(site.latitude),
          Number(site.longitude),
        );
        return distance < closest.distance ? { site, distance } : closest;
      }, { site: sites[0], distance: Infinity });

      await handleSiteSelected(nearestSite.site);
    } catch (error) {
      setResultModal({
        status: "error",
        title: "Failed to Detect Location",
        message: error instanceof Error ? error.message : "Please try again.",
      });
    }
  }

  async function handleSiteSelected(site: WorkLocation) {
    setSelectedWorkLocation(site);

    const isOutsideSite = await checkOutsideSite(site);
    if (isOutsideSite) {
      Alert.alert(
        "Outside Work Area",
        "You appear to be outside this site's geotagged area. You can still continue, but your attendance may be flagged for review.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Continue Anyway", onPress: () => setScanType("TIME_IN") },
        ],
      );
      return;
    }

    setScanType("TIME_IN");
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

  async function checkOutsideSite(site: WorkLocation) {
    try {
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const distance = distanceInMeters(
        position.coords.latitude,
        position.coords.longitude,
        Number(site.latitude),
        Number(site.longitude),
      );
      return distance > Number(site.radiusMeters);
    } catch (error) {
      console.error("Failed to check site area before scan", error);
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
        // Only sent when starting a new FIELD visit — ending one and every
        // FIXED-employee submission resolve their site without this.
        workLocationId:
          user.attendanceMode === "FIELD" && scanType === "TIME_IN" ? selectedWorkLocation?.id : undefined,
        // Disambiguates Time Out / Lunch Out / Lunch In, which can all be
        // legal next actions once timed in — omitted for Time In, where the
        // server always infers it from state alone.
        action: scanType !== "TIME_IN" ? scanType : undefined,
      });

      // The server is the authority on whether this was a Time In or Time Out.
      const actionLabel =
        user.attendanceMode === "FIELD"
          ? result.logType === "TIME_IN"
            ? "Visit Start"
            : "Visit End"
          : result.logType === "TIME_IN"
            ? "Time In"
            : result.logType === "TIME_OUT"
              ? "Time Out"
              : result.logType === "LUNCH_OUT"
                ? "Lunch Break Start"
                : "Lunch Break End";
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
      setSelectedWorkLocation(null);
    }
  }

  function backToLogin() {
    setAuthView("login");
    setResetEmail("");
    setResetToken("");
  }

  return (
    <SafeAreaProvider>
      {!hasSplashAnimationFinished || !hasSessionCheckFinished ? (
        <SplashScreen onAnimationComplete={handleSplashAnimationComplete} />
      ) : !user && authView === "forgot-otp" ? (
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
      ) : user.mustChangePassword ? (
        <SetInitialPasswordScreen onDone={handlePasswordSetupComplete} />
      ) : scanType ? (
        <CameraScanner
          logType={scanType}
          onComplete={handleScanComplete}
          onCancel={() => {
            setScanType(null);
            setSelectedWorkLocation(null);
          }}
        />
      ) : portal === "supervisor" ? (
        <SupervisorMainScreen
          user={user}
          onLogout={handleLogout}
          canSwitchToEmployeePortal={(user.roles ?? [user.role]).includes("EMPLOYEE")}
          onSwitchToEmployeePortal={() => setPortal("employee")}
        />
      ) : (
        <MainScreen
          user={user}
          isLoading={isLoading}
          todayAttendance={todayAttendance}
          eligibility={eligibility}
          onLogout={handleLogout}
          onTimeIn={() => startScan("TIME_IN")}
          onTimeOut={() => startScan("TIME_OUT")}
          onLunchOut={() => startScan("LUNCH_OUT")}
          onLunchIn={() => startScan("LUNCH_IN")}
          canSwitchToSupervisorPortal={(user.roles ?? [user.role]).includes("SUPERVISOR")}
          onSwitchToSupervisorPortal={() => setPortal("supervisor")}
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
