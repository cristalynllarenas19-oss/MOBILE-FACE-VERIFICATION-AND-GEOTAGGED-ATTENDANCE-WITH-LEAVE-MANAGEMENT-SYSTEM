import { useCallback, useEffect, useState } from "react";
import { Alert } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as Location from "expo-location";

import LoginScreen from "./src/screens/LoginScreen";
import MainScreen from "./src/screens/MainScreen";
import {
  getEligibilityMessage,
  getGeofenceMessage,
  getApplicableAction,
  getUnauthorizedAttemptMessage,
} from "./src/screens/AttendanceScreen";
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
  getAttendanceHistory,
  getLeaveTypes,
  getLeaveBalances,
  getLeaveRequests,
  getUndertimeEligibility,
  getUndertimeFilings,
  getNotifications,
  getUnreadNotificationCount,
  getDashboardSummary,
  getTeamEmployees,
  getTeamAttendance,
  getGeotaggedLocations,
  getTeamLeaveRequests,
  getSchedules,
  getReportsSummary,
  forgotPassword,
  setUnauthorizedHandler,
} from "./src/api";
import { CACHE_KEYS, cacheGet, cacheSet, prefetchCached, revalidateCached } from "./src/utils/dataCache";
import { getFriendlyReason, getFlaggedAttemptMessage } from "./src/utils/attendanceMessages";
import { distanceInMeters } from "./src/utils/geofence";
import { Portal, GeofenceStatus } from "./src/types";

// How often to re-check the employee's live GPS position against their
// assigned work location(s) while signed in — frequent enough that walking
// into range flips the button on without needing to reopen the app.
const GEOFENCE_POLL_MS = 15000;

type ResultModalState = {
  status: ResultModalStatus;
  title: string;
  message: string;
};

// Human-readable label for a given scan action, used wherever the employee
// needs to be told which specific attendance action is affected (approved,
// rejected, out-of-range, or gated behind the unauthorized-attempt warning).
function getActionLabel(type: "TIME_IN" | "TIME_OUT" | "LUNCH_OUT" | "LUNCH_IN", isFieldMode: boolean) {
  if (isFieldMode) {
    return type === "TIME_IN" ? "Visit Start" : "Visit End";
  }
  switch (type) {
    case "TIME_IN":
      return "Time In";
    case "TIME_OUT":
      return "Time Out";
    case "LUNCH_OUT":
      return "Lunch Break Start";
    case "LUNCH_IN":
      return "Lunch Break End";
  }
}

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

function attendanceCacheKey(employeeId: string) {
  return CACHE_KEYS.todayAttendance(employeeId);
}

function eligibilityCacheKey(employeeId: string) {
  return CACHE_KEYS.attendanceEligibility(employeeId);
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

  // The employee's assigned work location(s) (single-item for FIXED, one or
  // more for FIELD), kept around so the live GPS position below can be
  // compared against them — separate from `eligibility.hasWorkLocation`,
  // which only tracks whether any are assigned at all.
  const [assignedWorkLocations, setAssignedWorkLocations] = useState<WorkLocation[]>([]);
  const [currentPosition, setCurrentPosition] = useState<Location.LocationObjectCoords | null>(null);
  const [locationPermissionDenied, setLocationPermissionDenied] = useState(false);

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
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const handleSplashAnimationComplete = useCallback(() => {
    setHasSplashAnimationFinished(true);
  }, []);

  useEffect(() => {
    let isMounted = true;

    setUnauthorizedHandler(() => {
      if (!isMounted || isLoggingOut) return;
      void handleLogout(true);
    });

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
      setUnauthorizedHandler(null);
    };
  }, [isLoggingOut]);

  useEffect(() => {
    if (user?.employeeId) {
      refreshTodayAttendance(user.employeeId);
      refreshEligibility(user.employeeId, user.attendanceMode);
    }
  }, [user?.employeeId]);

  // Live geofence tracking: while signed in, periodically re-fetch the
  // device's GPS position so the Time In/Out buttons can require the
  // employee to actually be standing inside their assigned work area,
  // enabling/disabling as they walk in or out of range without needing to
  // reopen the app. Mirrors WorkAreaScreen's permission/position handling.
  useEffect(() => {
    if (!user?.employeeId) {
      setCurrentPosition(null);
      setLocationPermissionDenied(false);
      return;
    }

    let isMounted = true;

    async function pollPosition() {
      try {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (!isMounted) return;
        if (!permission.granted) {
          setLocationPermissionDenied(true);
          setCurrentPosition(null);
          return;
        }
        setLocationPermissionDenied(false);
        const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (isMounted) setCurrentPosition(position.coords);
      } catch {
        if (isMounted) setCurrentPosition(null);
      }
    }

    pollPosition();
    const interval = setInterval(pollPosition, GEOFENCE_POLL_MS);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [user?.employeeId]);

  // "checking" until a fix comes back, "unavailable" when permission is
  // denied or nothing is assigned to compare against, otherwise "inside"/
  // "outside" based on distance to the nearest assigned work location.
  const geofenceStatus: GeofenceStatus = locationPermissionDenied || assignedWorkLocations.length === 0
    ? "unavailable"
    : currentPosition == null
      ? "checking"
      : assignedWorkLocations.some(
          (location) =>
            distanceInMeters(
              currentPosition.latitude,
              currentPosition.longitude,
              Number(location.latitude),
              Number(location.longitude),
            ) <= Number(location.radiusMeters),
        )
        ? "inside"
        : "outside";

  // Warm every read-only tab after sign-in/restoration. This is deliberately
  // deferred until the landing screen is visible: the user gets there first,
  // while the remaining tabs populate their persistent cache in background.
  useEffect(() => {
    if (!user?.employeeId) return;

    const employeeId = user.employeeId;
    const isField = user.attendanceMode === "FIELD";
    const today = new Date().toISOString().slice(0, 10);
    const timer = setTimeout(() => {
      prefetchCached(CACHE_KEYS.myProfile, getMyProfile);
      prefetchCached(CACHE_KEYS.todayAttendance(employeeId), () => getTodayAttendance(employeeId));
      prefetchCached(CACHE_KEYS.attendanceHistory(employeeId), () => getAttendanceHistory(employeeId));
      if (isField) {
        prefetchCached(CACHE_KEYS.workArea(employeeId, "field"), getMyWorkLocations);
      } else {
        prefetchCached(CACHE_KEYS.workArea(employeeId, "fixed"), getMyWorkLocation);
      }
      prefetchCached(CACHE_KEYS.leaveTypes, getLeaveTypes);
      prefetchCached(CACHE_KEYS.leaveBalances(employeeId), () => getLeaveBalances(employeeId));
      prefetchCached(CACHE_KEYS.leaveRequests(employeeId), () => getLeaveRequests(employeeId));
      prefetchCached(CACHE_KEYS.undertimeEligibility(employeeId), () => getUndertimeEligibility(employeeId));
      prefetchCached(CACHE_KEYS.undertimeFilings(employeeId), () => getUndertimeFilings(employeeId));
      prefetchCached(CACHE_KEYS.notifications, getNotifications);
      prefetchCached(CACHE_KEYS.notificationsUnreadCount, getUnreadNotificationCount);

      if ((user.roles ?? [user.role]).some((role) => role !== "EMPLOYEE")) {
        prefetchCached(CACHE_KEYS.supervisorDashboard, getDashboardSummary);
        prefetchCached(CACHE_KEYS.teamEmployees, getTeamEmployees);
        prefetchCached(CACHE_KEYS.teamAttendance(today), () => getTeamAttendance({ date: today }));
        prefetchCached(CACHE_KEYS.geotaggedLocations, getGeotaggedLocations);
        prefetchCached(CACHE_KEYS.teamLeaveRequests, getTeamLeaveRequests);
        prefetchCached(CACHE_KEYS.teamSchedules, getSchedules);
        prefetchCached(CACHE_KEYS.teamReportsSummary, getReportsSummary);
      }
    }, 0);

    return () => clearTimeout(timer);
  }, [user?.id, user?.employeeId, user?.attendanceMode, user?.role, user?.roles]);

  async function refreshTodayAttendance(employeeId: string) {
    try {
      const cached = cacheGet<TodayAttendance>(attendanceCacheKey(employeeId));
      if (cached) setTodayAttendance(cached);
      const attendance = await revalidateCached(attendanceCacheKey(employeeId), () => getTodayAttendance(employeeId));
      setTodayAttendance(attendance);
    } catch (error) {
      console.error("Failed to load today's attendance", error);
    }
  }

  async function refreshEligibility(employeeId: string, attendanceMode?: string) {
    try {
      const cached = cacheGet<AttendanceEligibility>(eligibilityCacheKey(employeeId));
      if (cached) setEligibility(cached);
      const [profile, workLocations] = await Promise.all([
        revalidateCached(CACHE_KEYS.myProfile, getMyProfile),
        attendanceMode === "FIELD"
          ? revalidateCached(CACHE_KEYS.workArea(employeeId, "field"), getMyWorkLocations)
          : revalidateCached(CACHE_KEYS.workArea(employeeId, "fixed"), getMyWorkLocation).then((location) => (location ? [location] : [])),
      ]);
      setAssignedWorkLocations(workLocations);
      const nextEligibility = {
        faceEnrolled: Boolean(profile.hasActiveFaceEnrollment),
        hasWorkLocation: workLocations.length > 0,
        hasScheduleToday: Boolean(profile.hasScheduleToday),
      };
      setEligibility(nextEligibility);
      cacheSet(eligibilityCacheKey(employeeId), nextEligibility);
    } catch (error) {
      console.error("Failed to load attendance eligibility", error);
      setAssignedWorkLocations([]);
      setEligibility({ faceEnrolled: false, hasWorkLocation: false, hasScheduleToday: false });
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

  async function handleLogout(fromSessionExpiry = false) {
    if (isLoggingOut) return;
    setIsLoggingOut(true);

    await logout();
    setUser(null);
    setPortal("employee");
    setTodayAttendance(null);
    setEligibility(null);
    setScanType(null);
    setSelectedWorkLocation(null);
    setResultModal(null);
    setHasSplashAnimationFinished(true);
    setHasSessionCheckFinished(true);
    setAuthView("login");
    setResetEmail("");
    setResetToken("");

    // Clear fields after logout
    setEmail("");
    setPassword("");

    if (fromSessionExpiry) {
      Alert.alert("Session Expired", "Your session has expired. Please log in again.");
    }

    setIsLoggingOut(false);
  }

  // bypassFlagLock is only ever passed true from the "Log Attendance Now"
  // button on an ATTENDANCE_LOCKED notification (see handleLogRealAttendance
  // below) — reading and acting on that specific notification is exactly
  // how an employee is meant to clear the lock (a genuine scan of
  // themselves), unlike an unprompted retap of the disabled button on the
  // Attendance screen itself. Every other check (config eligibility,
  // geofence) still applies even when bypassing this one.
  async function startScan(
    type: "TIME_IN" | "TIME_OUT" | "LUNCH_OUT" | "LUNCH_IN",
    options: { bypassFlagLock?: boolean } = {},
  ) {
    if (!user?.employeeId) {
      setResultModal({
        status: "error",
        title: "Missing Employee Profile",
        message: "This account isn't linked to an employee record. Contact HR for assistance.",
      });
      return;
    }

    const isFieldMode = user.attendanceMode === "FIELD";
    const hasTimedIn = Boolean(todayAttendance?.timeInAt);
    const hasTimedOut = Boolean(todayAttendance?.timeOutAt);
    const hasOpenVisit = hasTimedIn && !hasTimedOut;
    const isOnLunch = Boolean(hasOpenVisit && todayAttendance?.lunchOutAt && !todayAttendance?.lunchInAt);
    const applicableAction = getApplicableAction({
      isField: isFieldMode,
      hasTimedIn,
      hasTimedOut,
      hasOpenVisit,
      isOnLunch,
    });
    // Mirrors AttendanceScreen's own isEligible/eligibilityMessage, which is
    // what actually disables the Time In/Out/Lunch buttons — this is just
    // the backstop in case startScan is ever reached some other way. A
    // supervisor-notified unresolved attempt (see hasUnresolvedFlaggedAttempt
    // on the backend) takes priority over the geofence message since it's an
    // admin-side hold, not something moving closer to the work area fixes.
    const eligibilityMessage =
      getEligibilityMessage(eligibility) ??
      (options.bypassFlagLock
        ? null
        : getUnauthorizedAttemptMessage(Boolean(todayAttendance?.hasUnresolvedFlaggedAttempt), applicableAction)) ??
      getGeofenceMessage(geofenceStatus, applicableAction);
    if (eligibilityMessage) {
      setResultModal({
        status: "error",
        title: "Attendance Not Available",
        message: eligibilityMessage,
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

    // The camera opens immediately, with no client-side geofence pre-check —
    // the backend independently re-checks location (and identity) at
    // submission regardless (see attendance.service.ts submit()), so this
    // was purely a redundant round trip on top of that authoritative check.
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
      // Ending a visit resolves its site from whichever one is currently
      // open server-side.
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
    setScanType("TIME_IN");
  }

  // Called the instant CameraScanner has a captured, liveness-verified
  // photo — before the GPS fix has even resolved, let alone identity match
  // or submission. locationPromise is still in flight at this point; this
  // function is what awaits it. scanType/selectedWorkLocation are captured
  // into local consts up front because the very next line clears both —
  // reading the state variables anywhere below this point would see null.
  async function handleScanComplete(locationPromise: Promise<Location.LocationObject>, faceBase64?: string) {
    if (!scanType || !user?.employeeId) return;
    const activeScanType = scanType;
    const activeWorkLocation = selectedWorkLocation;

    setIsLoading(true);
    // Back to the attendance screen right away — everything below (the GPS
    // fix, identity match, geofence check, and submission) now happens
    // invisibly in the background instead of being watched on screen. The
    // result modal (see ResultModal's own auto-dismiss) pops up over
    // whichever screen the employee is on once it's actually ready, instead
    // of making them wait for it before they can do anything else.
    setScanType(null);
    setSelectedWorkLocation(null);

    try {
      const location = await locationPromise;
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
          user.attendanceMode === "FIELD" && activeScanType === "TIME_IN" ? activeWorkLocation?.id : undefined,
        // Disambiguates Time Out / Lunch Out / Lunch In, which can all be
        // legal next actions once timed in — omitted for Time In, where the
        // server always infers it from state alone.
        action: activeScanType !== "TIME_IN" ? activeScanType : undefined,
      });

      // The server is the authority on whether this was a Time In or Time Out.
      const actionLabel = getActionLabel(result.logType, user.attendanceMode === "FIELD");
      const reason = result.faceResult.reason ?? result.geoResult.reason;
      const friendlyMessage = getFriendlyReason(reason, result.verificationStatus);

      if (result.verificationStatus === "APPROVED") {
        // Same instant the server wrote to the AttendanceRecord — falls back
        // to the device clock only if the server somehow omitted it, so the
        // modal and the Attendance screen never disagree with the DTR.
        const recordedAt = result.capturedAt ?? new Date().toISOString();
        setTodayAttendance((current) => {
          if (!current) return current;
          if (result.logType === "LUNCH_OUT") {
            return { ...current, lunchOutAt: current.lunchOutAt ?? recordedAt };
          }
          if (result.logType === "LUNCH_IN") {
            return { ...current, lunchInAt: current.lunchInAt ?? recordedAt };
          }
          if (result.logType === "TIME_IN") {
            return { ...current, timeInAt: current.timeInAt ?? recordedAt };
          }
          if (result.logType === "TIME_OUT") {
            return { ...current, timeOutAt: current.timeOutAt ?? recordedAt };
          }
          return current;
        });
        const timestamp = new Date(recordedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
        setResultModal({
          status: "approved",
          title: `${actionLabel} Recorded`,
          message: `Verified at ${timestamp}. Your Daily Time Record has been updated. ${friendlyMessage}`,
        });
      } else if (result.verificationStatus === "PENDING_REVIEW") {
        const flagged = getFlaggedAttemptMessage(actionLabel, result.flaggedAttemptCount);
        setResultModal({
          status: "pending",
          title: flagged.title,
          message: flagged.message,
        });
      } else {
        setResultModal({
          status: "rejected",
          // A flat face mismatch (as opposed to no-face-detected, liveness
          // failure, or being outside the work area — each keeps the
          // generic title below) gets its own clear title, since this is
          // the "someone else's face" case specifically.
          title: reason === "Face does not match enrolled profile" ? "Face Verification Failed" : `${actionLabel} Not Recorded`,
          message: friendlyMessage,
        });
      }

      // The Time In/Out button should re-enable the moment the verification
      // result is known, not after this background refresh (which only
      // updates the DTR summary and has its own error handling) finishes.
      setIsLoading(false);
      void refreshTodayAttendance(user.employeeId);
    } catch (error) {
      setResultModal({
        status: "error",
        title: "Submission Error",
        message:
          error instanceof Error
            ? error.message
            : "Failed to connect to the server. Check your connection and try again.",
      });
      setIsLoading(false);
    }
  }

  // Backs the "Log Attendance Now" button on an ATTENDANCE_LOCKED
  // notification — figures out which action is currently applicable the
  // same way AttendanceScreen's own buttons do, then opens the camera for
  // it directly, bypassing the account-wide lock this one notification is
  // specifically the sanctioned way around.
  function handleLogRealAttendance() {
    if (!user) return;
    const isFieldMode = user.attendanceMode === "FIELD";
    const hasTimedIn = Boolean(todayAttendance?.timeInAt);
    const hasTimedOut = Boolean(todayAttendance?.timeOutAt);
    const hasOpenVisit = hasTimedIn && !hasTimedOut;
    const isOnLunch = Boolean(hasOpenVisit && todayAttendance?.lunchOutAt && !todayAttendance?.lunchInAt);
    const applicableAction = getApplicableAction({
      isField: isFieldMode,
      hasTimedIn,
      hasTimedOut,
      hasOpenVisit,
      isOnLunch,
    });
    const type =
      applicableAction === "Time In" || applicableAction === "Start Visit"
        ? "TIME_IN"
        : applicableAction === "Time Out" || applicableAction === "End Visit"
          ? "TIME_OUT"
          : applicableAction === "Start Lunch"
            ? "LUNCH_OUT"
            : applicableAction === "End Lunch"
              ? "LUNCH_IN"
              : null;
    if (!type) return;
    void startScan(type, { bypassFlagLock: true });
  }

  // Called by CameraScanner as soon as its fresh high-accuracy GPS fix
  // resolves outside every assigned work location — before liveness/capture
  // even finishes, let alone submission. The Time In/Out button that opened
  // the camera was gated on a periodically-polled, lower-accuracy reading
  // (see geofenceStatus above), so this can legitimately catch someone who
  // was borderline when they tapped but whose precise position disagrees.
  function handleOutOfRange() {
    const actionLabel = scanType ? getActionLabel(scanType, user?.attendanceMode === "FIELD") : "Attendance";

    setScanType(null);
    setSelectedWorkLocation(null);
    setResultModal({
      status: "rejected",
      title: `${actionLabel} Not Recorded`,
      message: getFriendlyReason("Employee is outside the approved work location", "REJECTED"),
    });
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
          workLocations={
            user.attendanceMode === "FIELD" && scanType === "TIME_IN"
              ? selectedWorkLocation
                ? [selectedWorkLocation]
                : assignedWorkLocations
              : assignedWorkLocations
          }
          onOutOfRange={handleOutOfRange}
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
          geofenceStatus={geofenceStatus}
          onLogout={handleLogout}
          onTimeIn={() => startScan("TIME_IN")}
          onTimeOut={() => startScan("TIME_OUT")}
          onLunchOut={() => startScan("LUNCH_OUT")}
          onLunchIn={() => startScan("LUNCH_IN")}
          onLogRealAttendance={handleLogRealAttendance}
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
