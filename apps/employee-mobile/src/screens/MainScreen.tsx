import React, { useCallback, useEffect, useState } from "react";
import {
  AppState,
  SafeAreaView,
  View,
} from "react-native";

import AttendanceScreen from "./AttendanceScreen";
import LeaveScreen from "./LeaveScreen";
import DTRScreen from "./DTRScreen";
import WorkAreaScreen from "./WorkAreaScreen";
import SettingsScreen from "./SettingsScreen";
import NotificationsScreen from "./NotificationsScreen";

import Header from "../components/Header";
import BottomTab from "../components/BottomTab";

import { Tab, GeofenceStatus } from "../types";
import { AttendanceEligibility, EmployeeProfile, TodayAttendance, getMyProfile, getUnreadNotificationCount, getLeaveRequests, getLeaveBalances } from "../api";
import { CACHE_KEYS, cacheGet, cacheSet, revalidateCached, useCachedData } from "../utils/dataCache";

const NOTIFICATION_POLL_MS = 15000;

type Props = {
  user: any;
  onLogout: () => void;
  onTimeIn: () => void;
  onTimeOut: () => void;
  onLunchOut: () => void;
  onLunchIn: () => void;
  // Backs the "Log Attendance Now" button on an ATTENDANCE_LOCKED
  // notification — deliberately bypasses the same lock that disables the
  // Attendance screen's own buttons, since reading and acting on this
  // specific notification is exactly how an employee is meant to clear it
  // (a genuine scan of themselves), unlike an unprompted retap.
  onLogRealAttendance: () => void;
  isLoading: boolean;
  todayAttendance: TodayAttendance | null;
  eligibility: AttendanceEligibility | null;
  geofenceStatus: GeofenceStatus;
  canSwitchToSupervisorPortal?: boolean;
  onSwitchToSupervisorPortal?: () => void;
};

export default function MainScreen({
  user,
  onLogout,
  onTimeIn,
  onTimeOut,
  onLunchOut,
  onLunchIn,
  onLogRealAttendance,
  isLoading,
  todayAttendance,
  eligibility,
  geofenceStatus,
  canSwitchToSupervisorPortal,
  onSwitchToSupervisorPortal,
}: Props) {
  const [tab, setTab] =
    useState<Tab>("attendance");

  const [unreadCount, setUnreadCount] = useState(0);
  const [notificationsVisible, setNotificationsVisible] = useState(false);

  // Same cache key as ViewProfileScreen, so a photo change there is
  // reflected here instantly on the next mount without a refetch.
  const { data: profile, refresh: refreshProfile } = useCachedData<EmployeeProfile>(
    CACHE_KEYS.myProfile,
    getMyProfile,
  );

  const loadProfile = useCallback(() => {
    refreshProfile().catch(() => undefined);
  }, [refreshProfile]);

  useEffect(() => {
    let lastKnownCount: number | null = cacheGet<{ count: number }>(CACHE_KEYS.notificationsUnreadCount)?.count ?? null;
    const refreshUnreadCount = () => {
      const cached = cacheGet<{ count: number }>(CACHE_KEYS.notificationsUnreadCount);
      if (cached) setUnreadCount(cached.count);
      getUnreadNotificationCount()
        .then((data) => {
          setUnreadCount(data.count);
          cacheSet(CACHE_KEYS.notificationsUnreadCount, data);
          // A new notification (e.g. "your leave was approved") is exactly
          // when leave data most needs to be fresh — nudge it to refetch
          // right away instead of waiting for LeaveScreen's own poll. Only
          // fires on a genuine increase, not every 30s tick, and this is a
          // no-op if LeaveScreen isn't mounted (revalidateCached still
          // updates the shared cache for whenever it next opens).
          if (lastKnownCount !== null && data.count > lastKnownCount && user?.employeeId) {
            revalidateCached(CACHE_KEYS.leaveRequests(user.employeeId), () => getLeaveRequests(user.employeeId)).catch(() => undefined);
            revalidateCached(CACHE_KEYS.leaveBalances(user.employeeId), () => getLeaveBalances(user.employeeId)).catch(() => undefined);
          }
          lastKnownCount = data.count;
        })
        .catch(() => undefined);
    };
    refreshUnreadCount();
    const interval = setInterval(refreshUnreadCount, NOTIFICATION_POLL_MS);
    // A poll's setInterval doesn't reliably keep firing while the app is
    // backgrounded (the OS suspends JS timers), so re-checking on the app
    // coming back to the foreground — e.g. the employee glanced away while
    // waiting for a supervisor's decision, then reopened the app — is the
    // difference between "instant" and "waits out the rest of a suspended
    // interval" for the exact moment a status change is most likely.
    const appStateSub = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      refreshUnreadCount();
      // Don't gate this on the unread-count comparison above — that count
      // can miss edge cases (e.g. the notification was already read
      // elsewhere). Foregrounding is cheap and rare enough to always
      // refetch leave data directly instead of trusting a proxy signal.
      if (user?.employeeId) {
        revalidateCached(CACHE_KEYS.leaveRequests(user.employeeId), () => getLeaveRequests(user.employeeId)).catch(() => undefined);
        revalidateCached(CACHE_KEYS.leaveBalances(user.employeeId), () => getLeaveBalances(user.employeeId)).catch(() => undefined);
      }
    });
    return () => {
      clearInterval(interval);
      appStateSub.remove();
    };
  }, [user?.employeeId]);

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Header
        user={user}
        profile={profile}
        unreadCount={unreadCount}
        onPressNotifications={() => setNotificationsVisible(true)}
      />

      <NotificationsScreen
        visible={notificationsVisible}
        onClose={() => setNotificationsVisible(false)}
        onUnreadCountChange={setUnreadCount}
        employeeId={user?.employeeId}
        onLogRealAttendance={() => {
          setNotificationsVisible(false);
          setTab("attendance");
          onLogRealAttendance();
        }}
      />

      <View
        style={{
          flex: 1,
          padding: 16,
        }}
      >
        {tab === "attendance" && (
      <AttendanceScreen
          user={user}
          isLoading={isLoading}
          todayAttendance={todayAttendance}
          eligibility={eligibility}
          geofenceStatus={geofenceStatus}
          onTimeIn={onTimeIn}
          onTimeOut={onTimeOut}
          onLunchOut={onLunchOut}
          onLunchIn={onLunchIn}
      />
        )}

        {tab === "leave" && (
          <LeaveScreen employeeId={user?.employeeId} />
        )}

        {tab === "dtr" && (
          // Every employee gets the same Office/Field tabbed DTR screen,
          // regardless of attendance mode — a Fixed employee's Field tab
          // (and a Field employee's Office tab) will just be empty.
          <DTRScreen employeeId={user?.employeeId} />
        )}

        {tab === "workarea" && (
          <WorkAreaScreen employeeId={user?.employeeId} attendanceMode={user?.attendanceMode} />
        )}

        {tab === "settings" && (
          <SettingsScreen
            onLogout={onLogout}
            onProfileChanged={loadProfile}
            canSwitchToSupervisorPortal={canSwitchToSupervisorPortal}
            onSwitchToSupervisorPortal={onSwitchToSupervisorPortal}
          />
        )}
      </View>

      <BottomTab
        tab={tab}
        setTab={setTab}
      />
    </SafeAreaView>
  );
}
