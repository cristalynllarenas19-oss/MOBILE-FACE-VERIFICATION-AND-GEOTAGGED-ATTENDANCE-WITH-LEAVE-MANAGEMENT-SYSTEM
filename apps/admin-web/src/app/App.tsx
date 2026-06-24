import { useMemo, useState } from "react";
import { AttendancePage } from "../features/attendance/AttendancePage";
import { DashboardPage } from "../features/dashboard/DashboardPage";
import { EmployeesPage } from "../features/employees/EmployeesPage";
import { LeavePage } from "../features/leave/LeavePage";
import { LoginPage } from "../features/login/LoginPage";
import { ProfilePage } from "../features/profile/ProfilePage";
import { ReportsPage } from "../features/reports/ReportsPage";
import { SchedulesPage } from "../features/schedules/SchedulesPage";
import { UsersPage } from "../features/users/UsersPage";
import { FaceRegistrationPage } from "../features/face-registration/FaceRegistrationPage";
import { GeotaggingPage } from "../features/geotagging/GeotaggingPage";
import { AppLayout, navItems } from "../components/layout/AppLayout";
import { PermissionCode } from "../types/rbac";
import { AuthUser, getStoredUser, logout } from "../lib/api";

export default function App() {
  const [authUser, setAuthUser] = useState<AuthUser | null>(() => getStoredUser());
  const [page, setPage] = useState("dashboard");

  const user = useMemo(
    () => ({
      displayName: authUser?.displayName ?? "",
      role: authUser?.role ?? "",
      permissions: (authUser?.permissions ?? []) as PermissionCode[],
    }),
    [authUser],
  );

  if (!authUser) {
    return <LoginPage onLogin={setAuthUser} />;
  }

  // Defends against `page` ever pointing at a page the user's permissions don't
  // cover (e.g. a stale notification deep-link) — falls back to the dashboard.
  const activeNavItem = navItems.find((item) => item.id === page);
  const hasAccess =
    !activeNavItem || activeNavItem.permission === null || user.permissions.includes(activeNavItem.permission);
  const renderPage = hasAccess ? page : "dashboard";

  return (
    <AppLayout
      activePage={renderPage}
      onLogout={() => {
        logout();
        setAuthUser(null);
      }}
      onNavigate={setPage}
      user={user}
    >
      {renderPage === "dashboard" && <DashboardPage />}
      {renderPage === "profile" && <ProfilePage />}
      {renderPage === "users" && <UsersPage />}
      {renderPage === "face-registration" && <FaceRegistrationPage />}
      {renderPage === "employees" && <EmployeesPage user={user} />}
      {renderPage === "attendance" && <AttendancePage user={user} />}
      {renderPage === "geotagging" && <GeotaggingPage user={user} />}
      {renderPage === "leave" && <LeavePage />}
      {renderPage === "schedules" && <SchedulesPage user={user} />}
      {renderPage === "reports" && <ReportsPage />}
    </AppLayout>
  );
}
