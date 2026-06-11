import {
  BarChart3,
  Bell,
  CalendarClock,
  CheckSquare,
  ClipboardList,
  LayoutDashboard,
  LogOut,
  Users,
  UserSquare2,
} from "lucide-react";
import { ReactNode } from "react";
import { PermissionCode, permissions } from "../../types/rbac";

type User = {
  displayName: string;
  role: string;
  permissions: PermissionCode[];
};

const navItems = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, permission: permissions.dashboardView },
  { id: "users", label: "User Management", icon: Users, permission: permissions.usersRead },
  { id: "employees", label: "Employee Management", icon: UserSquare2, permission: permissions.employeesRead },
  { id: "attendance", label: "Attendance Management", icon: CheckSquare, permission: permissions.attendanceRead },
  { id: "leave", label: "Leave Management", icon: ClipboardList, permission: permissions.leaveRead },
  { id: "schedules", label: "Schedule Management", icon: CalendarClock, permission: permissions.schedulesRead },
  { id: "reports", label: "Reports", icon: BarChart3, permission: permissions.reportsRead },
];

const pageTitles: Record<string, string> = {
  dashboard: "Admin Dashboard",
  users: "User Management",
  employees: "Employee Management",
  attendance: "Attendance Management",
  leave: "Leave Management",
  schedules: "Schedule Management",
  reports: "Reports and Analytics",
};

export function AppLayout({
  children,
  activePage,
  onNavigate,
  onLogout,
  user,
}: {
  children: ReactNode;
  activePage: string;
  onNavigate: (page: string) => void;
  onLogout: () => void;
  user: User;
}) {
  const visibleItems = navItems.filter((item) => user.permissions.includes(item.permission));

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">UL</div>
          <div>
            <h1>Universal Leaf</h1>
            <p>Attendance & Leave System</p>
          </div>
        </div>

        <nav className="nav-list">
          {visibleItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={`nav-link ${activePage === item.id ? "active" : ""}`}
                key={item.id}
                onClick={() => onNavigate(item.id)}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
          <button className="nav-link logout-link" onClick={onLogout}>
            <LogOut size={18} />
            <span>Logout</span>
          </button>
        </nav>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div>
            <h2>{pageTitles[activePage]}</h2>
            <p>Mobile Face Verification and Geotagged Attendance with Leave Management System</p>
          </div>
          <div className="topbar-actions">
            {activePage === "users" && <button className="header-button">Add User</button>}
            <div className="user-chip">{user.displayName}</div>
            <button className="bell-button" aria-label="Notifications">
              <Bell size={18} />
            </button>
          </div>
        </header>
        <section className="page-content">{children}</section>
      </main>
    </div>
  );
}
