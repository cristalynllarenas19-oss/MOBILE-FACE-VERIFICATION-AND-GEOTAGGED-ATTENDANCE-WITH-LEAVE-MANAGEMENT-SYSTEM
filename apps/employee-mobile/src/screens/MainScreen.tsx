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

import { Tab } from "../types";
import { AttendanceEligibility, EmployeeProfile, TodayAttendance, getMyProfile, getUnreadNotificationCount } from "../api";

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
}: Props) {
  const [tab, setTab] =
    useState<Tab>("attendance");

  const [unreadCount, setUnreadCount] = useState(0);
  const [notificationsVisible, setNotificationsVisible] = useState(false);
  const [profile, setProfile] = useState<EmployeeProfile | null>(null);

  const loadProfile = useCallback(() => {
    getMyProfile().then(setProfile).catch(() => undefined);
  }, []);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  useEffect(() => {
    const refreshUnreadCount = () => {
      getUnreadNotificationCount()
        .then((data) => setUnreadCount(data.count))
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