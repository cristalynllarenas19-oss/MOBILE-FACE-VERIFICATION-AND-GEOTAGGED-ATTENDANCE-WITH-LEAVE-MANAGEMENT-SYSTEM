import React, { useCallback, useEffect, useState } from "react";
import { SafeAreaView, View } from "react-native";

import SupervisorDashboardScreen from "./supervisor/SupervisorDashboardScreen";
import TeamScreen from "./supervisor/TeamScreen";
import SupervisorLeaveScreen from "./supervisor/SupervisorLeaveScreen";
import SupervisorAttendanceScreen from "./supervisor/SupervisorAttendanceScreen";
import MoreScreen from "./supervisor/MoreScreen";
import NotificationsScreen from "./NotificationsScreen";

import Header from "../components/Header";
import BottomTab, { SUPERVISOR_TABS } from "../components/BottomTab";

import { SupervisorTab } from "../types";
import { EmployeeProfile, MobileUser, getMyProfile, getUnreadNotificationCount } from "../api";

const NOTIFICATION_POLL_MS = 30000;

type Props = {
  user: MobileUser;
  onLogout: () => void;
  canSwitchToEmployeePortal: boolean;
  onSwitchToEmployeePortal: () => void;
};

export default function SupervisorMainScreen({ user, onLogout, canSwitchToEmployeePortal, onSwitchToEmployeePortal }: Props) {
  const [tab, setTab] = useState<SupervisorTab>("dashboard");

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
        subtitle="Supervisor"
      />

      <NotificationsScreen
        visible={notificationsVisible}
        onClose={() => setNotificationsVisible(false)}
        onUnreadCountChange={setUnreadCount}
        employeeId={user?.employeeId}
      />

      <View style={{ flex: 1, padding: 16 }}>
        {tab === "dashboard" && <SupervisorDashboardScreen departmentName={user?.department} />}

        {tab === "team" && <TeamScreen departmentName={user?.department} currentEmployeeId={user?.employeeId} />}

        {tab === "leave" && <SupervisorLeaveScreen currentEmployeeId={user?.employeeId} />}

        {tab === "attendance" && <SupervisorAttendanceScreen />}

        {tab === "more" && (
          <MoreScreen
            onLogout={onLogout}
            canSwitchToEmployeePortal={canSwitchToEmployeePortal}
            onSwitchToEmployeePortal={onSwitchToEmployeePortal}
          />
        )}
      </View>

      <BottomTab tab={tab} setTab={setTab} tabs={SUPERVISOR_TABS} />
    </SafeAreaView>
  );
}
