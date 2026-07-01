import { useEffect, useMemo, useState } from "react";
import { AttendancePage } from "../features/attendance/AttendancePage";
import { DashboardPage } from "../features/dashboard/DashboardPage";
import { EmployeesPage } from "../features/employees/EmployeesPage";
import { LeavePage } from "../features/leave/LeavePage";
import { LoginPage } from "../features/login/LoginPage";
import { ReportsPage } from "../features/reports/ReportsPage";
import { SchedulesPage } from "../features/schedules/SchedulesPage";
import { UsersPage } from "../features/users/UsersPage";
import { UtilitiesPage } from "../features/utilities/UtilitiesPage";
import { FaceRegistrationPage } from "../features/face-registration/FaceRegistrationPage";
import { GeotaggingPage } from "../features/geotagging/GeotaggingPage";
// Employee self-service pages (mirrors employee-mobile)
import { AttendancePage as EmployeeAttendancePage } from "../features/employee/AttendancePage";
import { LeavePage as EmployeeLeavePage } from "../features/employee/LeavePage";
import { DtrPage } from "../features/employee/DtrPage";
import { WorkAreaPage } from "../features/employee/WorkAreaPage";
import { SettingsPage } from "../features/employee/SettingsPage";
import { AppLayout, navItems } from "../components/layout/AppLayout";
import { PermissionCode } from "../types/rbac";
import { AuthUser, getStoredUser, logout, setOnSessionExpired } from "../lib/api";
import { useInactivityLogout } from "../hooks/useInactivityLogout";

export default function App() {
  const [authUser, setAuthUser] = useState<AuthUser | null>(() => getStoredUser());
  const [page, setPage] = useState(() =>
    getStoredUser()?.role === "EMPLOYEE" ? "employee-attendance" : "dashboard"
  );
  useEffect(() => {
    setOnSessionExpired(() => {
      logout();
      setAuthUser(null);
    });
  }, []);

  useInactivityLogout(() => {
    logout();
    setAuthUser(null);
  }, authUser !== null);

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

  // Defends against `page` pointing at a page the user can't access.
  // EMPLOYEE role: only employee-* pages are accessible, regardless of backend permissions.
  // Others: permission-based access check as usual.
  const isEmployee = authUser?.role === "EMPLOYEE";
  const activeNavItem = navItems.find((item) => item.id === page);
  const hasAccess = isEmployee
    ? page.startsWith("employee-")
    : !activeNavItem || user.permissions.includes(activeNavItem.permission);
  const visibleItems = isEmployee
    ? navItems.filter((item) => item.id.startsWith("employee-"))
    : navItems.filter((item) => user.permissions.includes(item.permission));
  const renderPage = hasAccess ? page : (visibleItems[0]?.id ?? "employee-attendance");

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
      {renderPage === "users" && <UsersPage />}
      {renderPage === "face-registration" && <FaceRegistrationPage />}
      {renderPage === "employees" && <EmployeesPage user={user} />}
      {renderPage === "attendance" && <AttendancePage user={user} />}
      {renderPage === "geotagging" && <GeotaggingPage user={user} />}
      {renderPage === "leave" && <LeavePage />}
      {renderPage === "schedules" && <SchedulesPage user={user} />}
      {renderPage === "reports" && <ReportsPage />}
      {renderPage === "utilities" && <UtilitiesPage user={user} />}
      {/* Employee self-service pages (mirrors employee-mobile) */}
      {renderPage === "employee-attendance" && <EmployeeAttendancePage user={authUser!} />}
      {renderPage === "employee-leave"      && <EmployeeLeavePage user={authUser!} />}
      {renderPage === "employee-dtr"        && <DtrPage user={authUser!} />}
      {renderPage === "employee-work-area"  && <WorkAreaPage user={authUser!} />}
      {renderPage === "employee-settings"   && <SettingsPage user={authUser!} />}
    </AppLayout>
  );
}
