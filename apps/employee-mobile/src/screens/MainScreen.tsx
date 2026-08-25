import React, { useCallback, useEffect, useState } from "react";
import {
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
import { AttendanceEligibility, EmployeeProfile, TodayAttendance, getMyProfile, getUnreadNotificationCount } from "../api";
import { CACHE_KEYS, cacheGet, cacheSet, useCachedData } from "../utils/dataCache";

const NOTIFICATION_POLL_MS = 30000;

type Props = {
  user: any;
  onLogout: () => void;
  onTimeIn: () => void;
  onTimeOut: () => void;
  onLunchOut: () => void;
  onLunchIn: () => void;
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
    const refreshUnreadCount = () => {
      const cached = cacheGet<{ count: number }>(CACHE_KEYS.notificationsUnreadCount);
      if (cached) setUnreadCount(cached.count);
      getUnreadNotificationCount()
        .then((data) => {
          setUnreadCount(data.count);
          cacheSet(CACHE_KEYS.notificationsUnreadCount, data);
        })
        .catch(() => undefined);
    };
    refreshUnreadCount();
    const interval = setInterval(refreshUnreadCount, NOTIFICATION_POLL_MS);
    return () => clearInterval(interval);
  }, []);

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
