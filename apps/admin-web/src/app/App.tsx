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
import { FaceRegistrationPage, FaceRegistrationEmployee } from "../features/face-registration/FaceRegistrationPage";
import { GeotaggingPage } from "../features/geotagging/GeotaggingPage";
// Employee self-service pages (mirrors employee-mobile)
import { AttendancePage as EmployeeAttendancePage } from "../features/employee-portal/AttendancePage";
import { LeavePage as EmployeeLeavePage } from "../features/employee-portal/LeavePage";
import { DtrPage } from "../features/employee-portal/DtrPage";
import { WorkAreaPage } from "../features/employee-portal/WorkAreaPage";
import { SettingsPage } from "../features/employee-portal/SettingsPage";
import { FaceConsentPage } from "../features/employee-portal/FaceConsentPage";
import { AppLayout, getVisibleNavItems, isNavItemVisible, navItems } from "../components/layout/AppLayout";
import { PermissionCode } from "../types/rbac";
import { apiRequest, AuthUser, getStoredUser, logout, setOnSessionExpired } from "../lib/api";
import { CACHE_KEYS, prefetchCached } from "../lib/dataCache";
import { fetchNotifications, fetchUnreadCount } from "../lib/notifications";
import {
  getMyProfile, getTodayAttendance, getAttendanceHistory, getMyWorkLocations, getMyWorkLocation,
  getLeaveTypes, getLeaveBalances, getLeaveRequests, getUndertimeEligibility, getUndertimeFilings,
} from "../features/employee-portal/api";
// import { useInactivityLogout } from "../hooks/useInactivityLogout"; // session timeout disabled for now

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
  // Same idea for a clicked flagged-attendance notification — jumps straight
  // into that flagged log's review modal instead of landing on the plain
  // Attendance list.
  const [attendanceFocusLogId, setAttendanceFocusLogId] = useState<string | undefined>(undefined);
  // Same idea for a clicked probation-regularization notification — jumps
  // straight into that employee's View Employee modal instead of landing on
  // the plain Employee Management list.
  const [employeeFocusId, setEmployeeFocusId] = useState<string | undefined>(undefined);
  // Set when a new employee is created so Face Registration opens with them
  // already selected; cleared on any normal navigation so a later visit to
  // Face Registration starts from a blank picker.
  const [faceRegistrationEmployee, setFaceRegistrationEmployee] = useState<FaceRegistrationEmployee | undefined>(undefined);

  const navigateToAttendance = (filter: AttendanceNavigateFilter) => {
    setAttendanceFilter(filter);
    setPage("attendance");
  };

  const handleNavigate = (id: string, entityId?: string) => {
    if (id === "attendance") setAttendanceFilter(undefined);
    setLeaveFocusRequestId(id === "leave" ? entityId : undefined);
    setEmployeeLeaveFocusRequestId(id === "employee-leave" ? entityId : undefined);
    setAttendanceFocusLogId(id === "attendance" ? entityId : undefined);
    setEmployeeFocusId(id === "employees" ? entityId : undefined);
    setFaceRegistrationEmployee(undefined);
    setPage(id);
  };

  const switchView = (view: "admin" | "employee") => {
    setAttendanceFilter(undefined);
    setLeaveFocusRequestId(undefined);
    setEmployeeLeaveFocusRequestId(undefined);
    setAttendanceFocusLogId(undefined);
    setEmployeeFocusId(undefined);
    setFaceRegistrationEmployee(undefined);
    setPage(view === "employee" ? "employee-attendance" : "dashboard");
  };

  useEffect(() => {
    setOnSessionExpired(() => {
      logout();
      setAuthUser(null);
    });
  }, []);

  // Warm every read-only page's cache right after sign-in/reload — mirrors
  // employee-mobile's App.tsx. Split into two waves so the landing page
  // doesn't have to fight its own prefetch for the browser's limited
  // per-origin connection pool: whatever the landing page itself needs is
  // requested first (wave 1), everything else follows a beat later (wave 2)
  // so it can't delay the page the user is actually looking at.
  useEffect(() => {
    if (!authUser) return;
    const employeeId = authUser.employeeId;
    const isField = authUser.attendanceMode === "FIELD";
    const roles = authUser.roles?.length ? authUser.roles : [authUser.role];
    const isAdminOrSupervisor = roles.some((role) => role !== "EMPLOYEE");
    const landingIsEmployeePortal = getLandingPage(authUser) === "employee-attendance";
    const now = new Date();
    const dashboardKey = `dashboard-summary:${now.getMonth() + 1}-${now.getFullYear()}`;
    const fetchDashboard = () => apiRequest(`/dashboard/summary?month=${now.getMonth() + 1}&year=${now.getFullYear()}`);

    // Every logged-in user has a notification bell, regardless of role or
    // landing page — prefetch immediately so opening it is never a cold,
    // spinner-first fetch.
    prefetchCached(CACHE_KEYS.notifications, fetchNotifications);
    prefetchCached(CACHE_KEYS.notificationsUnreadCount, fetchUnreadCount);

    // Wave 1 — fires immediately, same tick as the landing page's own mount.
    if (landingIsEmployeePortal && employeeId) {
      prefetchCached(CACHE_KEYS.myProfile, getMyProfile);
      prefetchCached(CACHE_KEYS.todayAttendance(employeeId), () => getTodayAttendance(employeeId));
    } else if (!landingIsEmployeePortal && isAdminOrSupervisor) {
      prefetchCached(dashboardKey, fetchDashboard);
    }

    // Wave 2 — everything else, deferred just long enough for wave 1's
    // requests to claim their connection slots first. Skips whatever wave 1
    // already requested so nothing fetches twice.
    const timer = setTimeout(() => {
      if (employeeId) {
        if (!landingIsEmployeePortal) {
          prefetchCached(CACHE_KEYS.myProfile, getMyProfile);
          prefetchCached(CACHE_KEYS.todayAttendance(employeeId), () => getTodayAttendance(employeeId));
        }
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
      }

      if (isAdminOrSupervisor) {
        if (landingIsEmployeePortal) {
          prefetchCached(dashboardKey, fetchDashboard);
        }
        prefetchCached("departments", () => apiRequest("/departments"));
        prefetchCached("attendanceModes", () => apiRequest("/departments/attendance-modes"));
        prefetchCached("employees", () => apiRequest("/employees"));
        prefetchCached("supervisors", () => apiRequest("/employees/supervisors"));
        prefetchCached(CACHE_KEYS.leaveTypes, getLeaveTypes);
        prefetchCached("admin-leave-requests", () => apiRequest("/leave-requests"));
        prefetchCached("undertime-filings", () => apiRequest("/undertime-filings"));
      }
    }, 150);

    return () => clearTimeout(timer);
  }, [authUser?.id, authUser?.employeeId, authUser?.attendanceMode, authUser?.role, authUser?.roles]);

  // Session timeout (auto-logout on inactivity) disabled for now.
  // useInactivityLogout(() => {
  //   logout();
  //   setAuthUser(null);
  // }, authUser !== null);

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

  // Mirrors employee-mobile's App.tsx gate — the field lives on the shared
  // Employee record, so accepting on mobile also clears this on web, and
  // vice versa. Scoped to the employee-portal view only, so a multi-role
  // account isn't blocked out of its admin view by this.
  const needsFaceConsent =
    activeView === "employee" && !!authUser.employeeId && !!authUser.requiresFaceConsent && !authUser.faceConsentAcceptedAt;

  // The post-create redirect into Face Registration, and the Employee
  // Details modal's "Register Face" action, only happen when the account can
  // actually see that page; otherwise both behave as before (stay on
  // Employee Management).
  const faceRegistrationNavItem = navItems.find((item) => item.id === "face-registration");
  const canOpenFaceRegistration =
    !!faceRegistrationNavItem && isNavItemVisible(faceRegistrationNavItem, adminScopedPermissions, user.roles);

  // Hands the given employee to Face Registration pre-selected, so the admin
  // never has to search for/re-select them — used both right after Add
  // Employee and from the Employee Details modal's Register Face button.
  function goToFaceRegistration(employee: FaceRegistrationEmployee) {
    setFaceRegistrationEmployee(employee);
    setPage("face-registration");
  }

  function handleLogout() {
    logout();
    setAuthUser(null);
  }

  return (
    <AppLayout
      activePage={renderPage}
      activeView={activeView}
      onSwitchView={switchView}
      onLogout={handleLogout}
      onNavigate={handleNavigate}
      user={user}
    >
      {renderPage === "dashboard" && <DashboardPage user={user} onNavigateToAttendance={navigateToAttendance} />}
      {renderPage === "users" && <UsersPage />}
      {renderPage === "face-registration" && <FaceRegistrationPage initialEmployee={faceRegistrationEmployee} />}
      {renderPage === "employees" && (
        <EmployeesPage
          user={user}
          onEmployeeCreated={canOpenFaceRegistration ? goToFaceRegistration : undefined}
          onRegisterFace={canOpenFaceRegistration ? goToFaceRegistration : undefined}
          initialFocusEmployeeId={employeeFocusId}
          onFocusHandled={() => setEmployeeFocusId(undefined)}
        />
      )}
      {renderPage === "attendance" && (
        <AttendancePage
          user={user}
          initialFilter={attendanceFilter}
          initialFocusLogId={attendanceFocusLogId}
          onFocusHandled={() => setAttendanceFocusLogId(undefined)}
        />
      )}
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
      {needsFaceConsent ? (
        <FaceConsentPage
          onAccepted={(faceConsentAcceptedAt) => {
            setAuthUser((u) => {
              if (!u) return u;
              const next = { ...u, faceConsentAcceptedAt };
              localStorage.setItem("authUser", JSON.stringify(next));
              return next;
            });
          }}
          onLogout={handleLogout}
        />
      ) : (
        <>
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
        </>
      )}
    </AppLayout>
  );
}
