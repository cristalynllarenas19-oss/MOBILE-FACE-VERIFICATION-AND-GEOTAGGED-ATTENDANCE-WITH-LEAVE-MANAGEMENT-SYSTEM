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
  Menu,
} from "lucide-react";
import { ReactNode, useState } from "react";
import { PermissionCode, permissions } from "../../types/rbac";
import logo from "../../assets/unileaf-logo.png"; // ← add this
import "./AppLayout.css";

type User = {
  displayName: string;
  role: string;
  permissions: PermissionCode[];
};

const navItems = [
  { id: "dashboard",  label: "Dashboard",            icon: LayoutDashboard, permission: permissions.dashboardView },
  { id: "users",      label: "User Management",       icon: Users,           permission: permissions.usersRead },
  { id: "employees",  label: "Employee Management",   icon: UserSquare2,     permission: permissions.employeesRead },
  { id: "attendance", label: "Attendance Management", icon: CheckSquare,     permission: permissions.attendanceRead },
  { id: "leave",      label: "Leave Management",      icon: ClipboardList,   permission: permissions.leaveRead },
  { id: "schedules",  label: "Schedule Management",   icon: CalendarClock,   permission: permissions.schedulesRead },
  { id: "reports",    label: "Reports",               icon: BarChart3,       permission: permissions.reportsRead },
];

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

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
  const [menuOpen, setMenuOpen] = useState(false);

  const visibleItems = navItems.filter((item) =>
    user.permissions.includes(item.permission)
  );

  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? "open" : ""}`}>

        {/* Profile */}
        <div className="profile">
          <div className="profile-avatar">{getInitials(user.displayName)}</div>
          <div>
            <p className="profile-name">{user.displayName}</p>
            <p className="profile-role">{user.role}</p>
          </div>
        </div>

        {/* Nav */}
        <nav className="nav-list">
          {visibleItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={`nav-link ${activePage === item.id ? "active" : ""}`}
                onClick={() => {
                  onNavigate(item.id);
                  setMenuOpen(false);
                }}
              >
                <Icon size={17} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Logout pinned at bottom */}
        <div className="sidebar-footer">
          <button
            className="nav-link logout-link"
            onClick={() => {
              setMenuOpen(false);
              onLogout();
            }}
          >
            <LogOut size={17} />
            <span>Logout</span>
          </button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="menu-toggle"
              onClick={() => setMenuOpen(!menuOpen)}
              aria-label="Toggle menu"
            >
              <Menu size={20} />
            </button>

            <div className="brand">
              <img
                src={logo} 
                alt="Universal Leaf Philippines Logo"
                className="brand-logo-img"
              />
              <div>
                <h1>
                  Mobile Face Verification with Geotagged Attendance &amp; Leave Management System
                </h1>
                <p>Universal Leaf Philippines, Inc. — Agoo, La Union</p>
              </div>
            </div>
          </div>

          <div className="topbar-actions">
            {activePage === "users" && (
              <button className="header-button">Add User</button>
            )}
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