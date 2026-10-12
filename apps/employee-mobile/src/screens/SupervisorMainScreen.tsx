import React, { useEffect, useState } from "react";
import { AppState, SafeAreaView, View } from "react-native";

import SupervisorDashboardScreen from "./supervisor/SupervisorDashboardScreen";
import TeamScreen from "./supervisor/TeamScreen";
import SupervisorLeaveScreen from "./supervisor/SupervisorLeaveScreen";
import SupervisorAttendanceScreen from "./supervisor/SupervisorAttendanceScreen";
import RegularizationReviewScreen from "./supervisor/RegularizationReviewScreen";
import MoreScreen from "./supervisor/MoreScreen";
import NotificationsScreen from "./NotificationsScreen";

import Header from "../components/Header";
import BottomTab, { SUPERVISOR_TABS } from "../components/BottomTab";

import { SupervisorTab } from "../types";
import { EmployeeProfile, MobileUser, getMyProfile, getUnreadNotificationCount, getTeamLeaveRequests } from "../api";
import { managementRoleLabel } from "../utils/roles";
import { CACHE_KEYS, cacheGet, cacheSet, revalidateCached, useCachedData } from "../utils/dataCache";

const NOTIFICATION_POLL_MS = 5000;

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
  // Set when "Review Employee" is tapped on a probation notification.
  const [reviewEmployeeId, setReviewEmployeeId] = useState<string | null>(null);
  // Set when "View Leave Request" is tapped on a leave notification — tells
  // SupervisorLeaveScreen which request to open its review modal for.
  const [focusedLeaveRequestId, setFocusedLeaveRequestId] = useState<string | null>(null);
  const { data: profile } = useCachedData<EmployeeProfile>(CACHE_KEYS.myProfile, getMyProfile);

  useEffect(() => {
    let lastKnownCount: number | null = cacheGet<{ count: number }>(CACHE_KEYS.notificationsUnreadCount("reviewer"))?.count ?? null;
    const refreshUnreadCount = () => {
      const cached = cacheGet<{ count: number }>(CACHE_KEYS.notificationsUnreadCount("reviewer"));
      if (cached) setUnreadCount(cached.count);
      getUnreadNotificationCount("reviewer")
        .then((data) => {
          setUnreadCount(data.count);
          cacheSet(CACHE_KEYS.notificationsUnreadCount("reviewer"), data);
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
        subtitle={managementRoleLabel(user)}
      />

      <NotificationsScreen
        visible={notificationsVisible}
        onClose={() => setNotificationsVisible(false)}
        onUnreadCountChange={setUnreadCount}
        view="reviewer"
        employeeId={user?.employeeId}
        canReviewTeamRequests
        onViewLeaveRequest={(requestId) => {
          setNotificationsVisible(false);
          setTab("leave");
          setFocusedLeaveRequestId(requestId);
        }}
        onReviewRegularization={setReviewEmployeeId}
      />

      {reviewEmployeeId && (
        <RegularizationReviewScreen
          visible={!!reviewEmployeeId}
          employeeId={reviewEmployeeId}
          onClose={() => setReviewEmployeeId(null)}
        />
      )}

      <View style={{ flex: 1, padding: 16 }}>
        {tab === "dashboard" && <SupervisorDashboardScreen departmentName={user?.department} />}

        {tab === "team" && <TeamScreen
            departmentName={user?.department}
            currentEmployeeId={user?.employeeId}
          />}

        {tab === "leave" && (
          <SupervisorLeaveScreen
            currentEmployeeId={user?.employeeId}
            initialFocusRequestId={focusedLeaveRequestId}
            onFocusRequestHandled={() => setFocusedLeaveRequestId(null)}
          />
        )}

        {/* Same gate admin-web's Attendance page applies: the flagged
            review queue needs attendance:write, which a Supervisor role
            only has when an admin granted it. */}
        {tab === "attendance" && (
          <SupervisorAttendanceScreen canReviewFlagged={user?.permissions?.includes("attendance:write") ?? false} />
        )}

        {tab === "more" && (
          <MoreScreen
            roleLabel={managementRoleLabel(user)}
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
