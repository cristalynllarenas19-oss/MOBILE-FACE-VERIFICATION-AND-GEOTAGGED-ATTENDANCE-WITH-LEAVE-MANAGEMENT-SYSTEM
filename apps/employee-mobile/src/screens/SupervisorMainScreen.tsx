import React, { useEffect, useState } from "react";
import { AppState, SafeAreaView, View } from "react-native";

import SupervisorDashboardScreen from "./supervisor/SupervisorDashboardScreen";
import TeamScreen from "./supervisor/TeamScreen";
import SupervisorLeaveScreen from "./supervisor/SupervisorLeaveScreen";
import SupervisorAttendanceScreen from "./supervisor/SupervisorAttendanceScreen";
import MoreScreen from "./supervisor/MoreScreen";
import NotificationsScreen from "./NotificationsScreen";

import Header from "../components/Header";
import BottomTab, { SUPERVISOR_TABS } from "../components/BottomTab";

import { SupervisorTab } from "../types";
import { EmployeeProfile, MobileUser, getMyProfile, getUnreadNotificationCount, getTeamLeaveRequests } from "../api";
import { CACHE_KEYS, cacheGet, cacheSet, revalidateCached, useCachedData } from "../utils/dataCache";

const NOTIFICATION_POLL_MS = 15000;

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
  const { data: profile } = useCachedData<EmployeeProfile>(CACHE_KEYS.myProfile, getMyProfile);

  useEffect(() => {
    let lastKnownCount: number | null = cacheGet<{ count: number }>(CACHE_KEYS.notificationsUnreadCount)?.count ?? null;
    const refreshUnreadCount = () => {
      const cached = cacheGet<{ count: number }>(CACHE_KEYS.notificationsUnreadCount);
      if (cached) setUnreadCount(cached.count);
      getUnreadNotificationCount()
        .then((data) => {
          setUnreadCount(data.count);
          cacheSet(CACHE_KEYS.notificationsUnreadCount, data);
          // A new notification (e.g. "leave cancellation requested") is
          // exactly when the team's leave list most needs to be fresh —
          // nudge it to refetch right away instead of waiting for the Leave
          // tab's own poll.
          if (lastKnownCount !== null && data.count > lastKnownCount) {
            revalidateCached(CACHE_KEYS.teamLeaveRequests, getTeamLeaveRequests).catch(() => undefined);
          }
          lastKnownCount = data.count;
        })
        .catch(() => undefined);
    };
    refreshUnreadCount();
    const interval = setInterval(refreshUnreadCount, NOTIFICATION_POLL_MS);
    const appStateSub = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      refreshUnreadCount();
      revalidateCached(CACHE_KEYS.teamLeaveRequests, getTeamLeaveRequests).catch(() => undefined);
    });
    return () => {
      clearInterval(interval);
      appStateSub.remove();
    };
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
