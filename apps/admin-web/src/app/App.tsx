import { useMemo, useState } from "react";
import { AttendancePage } from "../features/attendance/AttendancePage";
import { DashboardPage } from "../features/dashboard/DashboardPage";
import { EmployeesPage } from "../features/employees/EmployeesPage";
import { LeavePage } from "../features/leave/LeavePage";
import { LoginPage } from "../features/login/LoginPage";
import { ReportsPage } from "../features/reports/ReportsPage";
import { SchedulesPage } from "../features/schedules/SchedulesPage";
import { UsersPage } from "../features/users/UsersPage";
import { FaceRegistrationPage } from "../features/face-registration/FaceRegistrationPage";
import { AppLayout } from "../components/layout/AppLayout";
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

  return (
    <AppLayout
      activePage={page}
      onLogout={() => {
        logout();
        setAuthUser(null);
      }}
      onNavigate={setPage}
      user={user}
    >
      {page === "dashboard" && <DashboardPage />}
      {page === "users" && <UsersPage />}
      {page === "face-registration" && <FaceRegistrationPage />}
      {page === "employees" && <EmployeesPage />}
      {page === "attendance" && <AttendancePage />}
      {page === "leave" && <LeavePage />}
      {page === "schedules" && <SchedulesPage />}
      {page === "reports" && <ReportsPage />}
    </AppLayout>
  );
}
