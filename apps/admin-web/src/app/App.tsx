import { useEffect, useMemo, useState } from "react";
import { AttendanceInitialFilter, AttendancePage } from "../features/attendance/AttendancePage";
import { DashboardPage } from "../features/dashboard/DashboardPage";
import { AttendanceNavigateFilter } from "../components/ui/BarChart";
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
import { AppLayout, getVisibleNavItems, isNavItemVisible, navItems } from "../components/layout/AppLayout";
import { PermissionCode } from "../types/rbac";
import { AuthUser, getStoredUser, logout, setOnSessionExpired } from "../lib/api";
import { useInactivityLogout } from "../hooks/useInactivityLogout";

// Single check point for where a user lands: single-role accounts always go
// to their one view; multi-role accounts honor the saved `defaultView`
// (falling back to today's behavior — non-EMPLOYEE lands on the dashboard —
// when unset). Used both for a page reload (reading localStorage) and right
// after a fresh login (the user object isn't in localStorage yet at that
// instant), so `page` is never left stale pointing at the wrong portal.
function getLandingPage(user: AuthUser | null): string {
  if (!user) return "dashboard";
  if ((user.roles?.length ?? 0) <= 1) {
    return user.role === "EMPLOYEE" ? "employee-attendance" : "dashboard";
  }
  return user.defaultView === "EMPLOYEE" ? "employee-attendance" : "dashboard";
}

export default function App() {
  const [authUser, setAuthUser] = useState<AuthUser | null>(() => getStoredUser());
  const [page, setPage] = useState(() => getLandingPage(getStoredUser()));
  // Lets the dashboard's day-detail modal jump straight into a pre-filtered
  // Attendance view (department + status + date), cleared on any normal
  // sidebar navigation to Attendance so a stale filter doesn't linger.
  const [attendanceFilter, setAttendanceFilter] = useState<AttendanceInitialFilter | undefined>(undefined);
  // Lets a clicked Leave notification jump straight into that request's
  // review modal instead of just landing on the Leave Management list.
  const [leaveFocusRequestId, setLeaveFocusRequestId] = useState<string | undefined>(undefined);
  const [employeeLeaveFocusRequestId, setEmployeeLeaveFocusRequestId] = useState<string | undefined>(undefined);

  const navigateToAttendance = (filter: AttendanceNavigateFilter) => {
    setAttendanceFilter(filter);
    setPage("attendance");
  };

  const handleNavigate = (id: string, entityId?: string) => {
    if (id === "attendance") setAttendanceFilter(undefined);
    setLeaveFocusRequestId(id === "leave" ? entityId : undefined);
    setEmployeeLeaveFocusRequestId(id === "employee-leave" ? entityId : undefined);
    setPage(id);
  };

  const switchView = (view: "admin" | "employee") => {
    setAttendanceFilter(undefined);
    setLeaveFocusRequestId(undefined);
    setEmployeeLeaveFocusRequestId(undefined);
    setPage(view === "employee" ? "employee-attendance" : "dashboard");
  };

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
      roles: authUser?.roles ?? [],
      permissions: (authUser?.permissions ?? []) as PermissionCode[],
      adminPermissions: authUser?.adminPermissions as PermissionCode[] | undefined,
      departmentId: authUser?.departmentId,
      department: authUser?.department,
    }),
    [authUser],
  );

  if (!authUser) {
    return (
      <LoginPage
        onLogin={(loggedInUser) => {
          setAuthUser(loggedInUser);
          setPage(getLandingPage(loggedInUser));
        }}
      />
    );
  }

  // Defends against `page` pointing at a page the user can't access.
  // Which nav set is active is driven by the currently active VIEW, not the
  // account's primary role — a multi-role account switched into the
  // employee view must only see employee-* pages regardless of permissions.
  const activeView: "admin" | "employee" = page.startsWith("employee-") ? "employee" : "admin";
  const activeNavItem = navItems.find((item) => item.id === page);
  const adminScopedPermissions = user.adminPermissions ?? user.permissions;
  const visibleItems = getVisibleNavItems(activeView, adminScopedPermissions, user.roles);
  const hasAccess = activeView === "employee"
    ? page.startsWith("employee-")
    : !activeNavItem || isNavItemVisible(activeNavItem, adminScopedPermissions, user.roles);
  const renderPage = hasAccess ? page : (visibleItems[0]?.id ?? "employee-attendance");

  return (
    <AppLayout
      activePage={renderPage}
      activeView={activeView}
      onSwitchView={switchView}
      onLogout={() => {
        logout();
        setAuthUser(null);
      }}
      onNavigate={handleNavigate}
      user={user}
    >
      {renderPage === "dashboard" && <DashboardPage user={user} onNavigateToAttendance={navigateToAttendance} />}
      {renderPage === "users" && <UsersPage />}
      {renderPage === "face-registration" && <FaceRegistrationPage />}
      {renderPage === "employees" && <EmployeesPage user={user} />}
      {renderPage === "attendance" && <AttendancePage user={user} initialFilter={attendanceFilter} />}
      {renderPage === "geotagging" && <GeotaggingPage user={user} />}
      {renderPage === "leave" && (
        <LeavePage
          user={user}
          initialFocusRequestId={leaveFocusRequestId}
          onFocusRequestHandled={() => setLeaveFocusRequestId(undefined)}
        />
      )}
      {renderPage === "schedules" && <SchedulesPage user={user} />}
      {renderPage === "reports" && <ReportsPage user={user} />}
      {renderPage === "utilities" && <UtilitiesPage user={user} />}
      {/* Employee self-service pages (mirrors employee-mobile) */}
      {renderPage === "employee-attendance" && <EmployeeAttendancePage user={authUser!} />}
      {renderPage === "employee-leave"      && (
        <EmployeeLeavePage
          user={authUser!}
          initialFocusRequestId={employeeLeaveFocusRequestId}
          onFocusRequestHandled={() => setEmployeeLeaveFocusRequestId(undefined)}
        />
      )}
      {renderPage === "employee-dtr"        && <DtrPage user={authUser!} />}
      {renderPage === "employee-work-area"  && <WorkAreaPage user={authUser!} />}
      {renderPage === "employee-settings"   && (
        <SettingsPage
          user={authUser!}
          onDefaultViewChange={(defaultView) => {
            setAuthUser((u) => {
              if (!u) return u;
              const next = { ...u, defaultView };
              localStorage.setItem("authUser", JSON.stringify(next));
              return next;
            });
          }}
        />
      )}
    </AppLayout>
  );
}
