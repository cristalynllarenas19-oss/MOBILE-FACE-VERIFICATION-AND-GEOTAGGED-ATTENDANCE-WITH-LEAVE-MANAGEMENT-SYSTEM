import {
  ArrowLeftRight,
  BarChart3,
  Bell,
  CalendarClock,
  CheckSquare,
  ChevronDown,
  ClipboardList,
  LayoutDashboard,
  LogOut,
  MapPin,
  Users,
  UserSquare2,
  ScanFace,
  Menu,
  Settings2,
  Settings,
} from "lucide-react";
import { ReactNode, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { PermissionCode, permissions } from "../../types/rbac";
import logo from "../../assets/unileaf-logo.png"; // ← add this
import {
  AppNotification,
  fetchNotifications,
  fetchUnreadCount,
  markAllNotificationsRead,
  markNotificationRead,
} from "../../lib/notifications";
import { NotificationPanel } from "./NotificationPanel";
import "./AppLayout.css";
import "./NotificationPanel.css";

const NOTIFICATION_POLL_MS = 30000;

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

type User = {
  displayName: string;
  role: string;
  roles: string[];
  permissions: PermissionCode[];
  adminPermissions?: PermissionCode[];
};

export const navItems = [
  { id: "dashboard",  label: "Dashboard",            icon: LayoutDashboard, permission: permissions.dashboardView },
  { id: "users",      label: "User Management",       icon: Users,           permission: permissions.usersRead },
  { id: "face-registration", label: "Face Registration", icon: ScanFace,      permission: permissions.usersWrite },
  { id: "employees",  label: "Employee Management",   icon: UserSquare2,     permission: permissions.employeesRead },
  { id: "attendance", label: "Attendance Management", icon: CheckSquare,     permission: permissions.attendanceRead },
  { id: "geotagging", label: "Geotagged Areas",       icon: MapPin,          permission: permissions.attendanceRead },
  { id: "leave",      label: "Leave Management",      icon: ClipboardList,   permission: permissions.leaveRead },
  { id: "schedules",  label: "Schedule Management",   icon: CalendarClock,   permission: permissions.schedulesRead },
  { id: "reports",    label: "Reports",               icon: BarChart3,       permission: permissions.reportsRead },
  { id: "utilities",    label: "Utilities",               icon: Settings,       permission: permissions.reportsRead },

  // Employee self-service nav items (mirrors employee-mobile bottom tabs)
  { id: "employee-attendance", label: "Attendance", icon: CheckSquare,   permission: permissions.employeeAttendanceView },
  { id: "employee-leave",      label: "Leave",       icon: ClipboardList, permission: permissions.employeeLeaveView },
  { id: "employee-dtr",        label: "DTR",         icon: CalendarClock, permission: permissions.employeeDtrView },
  { id: "employee-work-area",  label: "Work Area",   icon: MapPin,        permission: permissions.employeeWorkAreaView },
  { id: "employee-settings",   label: "Settings",    icon: Settings2,     permission: permissions.employeeSettingsView },
];

// Which nav items are visible depends on which portal is active, not just
// on the account's roles — a multi-role account (e.g. SUPERVISOR + EMPLOYEE)
// sees the employee-only set while it has switched into the employee view,
// even though its primary role isn't EMPLOYEE.
export function getVisibleNavItems(activeView: "admin" | "employee", userPermissions: PermissionCode[]) {
  return activeView === "employee"
    ? navItems.filter((item) => item.id.startsWith("employee-"))
    : navItems.filter((item) => userPermissions.includes(item.permission));
}

export function AppLayout({
  children,
  activePage,
  activeView,
  onNavigate,
  onSwitchView,
  onLogout,
  user,
}: {
  children: ReactNode;
  activePage: string;
  activeView: "admin" | "employee";
  onNavigate: (page: string) => void;
  onSwitchView: (view: "admin" | "employee") => void;
  onLogout: () => void;
  user: User;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifLoading, setNotifLoading] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);
  const switcherRef = useRef<HTMLDivElement>(null);

  // Scoped to ADMIN/SUPERVISOR permissions only in the admin view, so a
  // Supervisor's implicit EMPLOYEE-role permissions (granted for their own
  // attendance/leave self-service) never leak extra modules into their nav.
  const visibleItems = getVisibleNavItems(activeView, user.adminPermissions ?? user.permissions);
  const canSwitchView = user.roles.length > 1;
  const adminViewLabel = user.roles.includes("ADMIN")
    ? "Admin Dashboard"
    : user.roles.includes("SUPERVISOR")
      ? "Supervisor Dashboard"
      : "Admin Dashboard";
  // The badge under the name reflects whichever portal is CURRENTLY active,
  // not just the account's first-assigned role — a Supervisor who is also an
  // EMPLOYEE should read "SUPERVISOR" while on the admin side and "EMPLOYEE"
  // after switching to My Attendance.
  const profileRoleLabel =
    activeView === "employee"
      ? "EMPLOYEE"
      : user.roles.includes("ADMIN")
        ? "ADMIN"
        : user.roles.includes("SUPERVISOR")
          ? "SUPERVISOR"
          : user.role;

  useEffect(() => {
    const refreshUnreadCount = () => {
      fetchUnreadCount()
        .then((data) => setUnreadCount(data.count))
        .catch(() => undefined);
    };
    refreshUnreadCount();
    const interval = window.setInterval(refreshUnreadCount, NOTIFICATION_POLL_MS);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!notifOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(event.target as Node)) {
        setNotifOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [notifOpen]);

  useEffect(() => {
    if (!switcherOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (switcherRef.current && !switcherRef.current.contains(event.target as Node)) {
        setSwitcherOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [switcherOpen]);

  const toggleNotifications = () => {
    const next = !notifOpen;
    setNotifOpen(next);
    if (next) {
      setNotifLoading(true);
      fetchNotifications()
        .then(setNotifications)
        .catch(() => undefined)
        .finally(() => setNotifLoading(false));
    }
  };

  const handleMarkRead = (id: string) => {
    setNotifications((items) => items.map((item) => (item.id === id ? { ...item, readAt: new Date().toISOString() } : item)));
    setUnreadCount((count) => Math.max(0, count - 1));
    markNotificationRead(id).catch(() => undefined);
  };

  const handleMarkAllRead = () => {
    setNotifications((items) => items.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })));
    setUnreadCount(0);
    markAllNotificationsRead().catch(() => undefined);
  };

  const handleSelectNotification = (notification: AppNotification) => {
    if (notification.type?.startsWith("LEAVE") && user.permissions.includes(permissions.leaveRead)) {
      onNavigate("leave");
    }
    setNotifOpen(false);
  };

  return (
    <div className="app-shell">
      {menuOpen && (
        <div
          className="sidebar-overlay"
          onClick={() => setMenuOpen(false)}
          aria-hidden="true"
        />
      )}
      <aside className={`sidebar ${menuOpen ? "open" : ""}`}>

        {/* Profile */}
        <div className="profile">
          <div className="profile-avatar">{getInitials(user.displayName)}</div>
          <div>
            <p className="profile-name">{user.displayName}</p>
            <p className="profile-role">{profileRoleLabel}</p>
          </div>
          {canSwitchView && (
            <div className="view-switcher" ref={switcherRef}>
              <button
                className="view-switcher-trigger"
                onClick={() => setSwitcherOpen((v) => !v)}
                aria-label="Switch view"
              >
                <ChevronDown size={16} />
              </button>
              {switcherOpen && (
                <div className="view-switcher-menu">
                  <p className="view-switcher-caption">Switch view</p>
                  <button
                    className={`view-switcher-option ${activeView === "admin" ? "active" : ""}`}
                    onClick={() => { onSwitchView("admin"); setSwitcherOpen(false); }}
                  >
                    <LayoutDashboard size={15} />
                    <span>{adminViewLabel}</span>
                  </button>
                  <button
                    className={`view-switcher-option ${activeView === "employee" ? "active" : ""}`}
                    onClick={() => { onSwitchView("employee"); setSwitcherOpen(false); }}
                  >
                    <ArrowLeftRight size={15} />
                    <span>My attendance</span>
                  </button>
                </div>
              )}
            </div>
          )}
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
              setShowLogoutConfirm(true);
            }}
          >
            <LogOut size={17} />
            <span>Logout</span>
          </button>
        </div>
      </aside>

      {showLogoutConfirm && (
        <ConfirmDialog
          config={{
            title: "Log Out",
            description: "Are you sure you want to log out?",
            confirmLabel: "Log Out",
            tone: "danger",
            onConfirm: onLogout,
          }}
          onCancel={() => setShowLogoutConfirm(false)}
        />
      )}

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

          <div className="topbar-actions" ref={notifRef}>
            <div className="notification-anchor">
              <button
                className="bell-button"
                aria-label="Notifications"
                onClick={toggleNotifications}
              >
                <Bell size={18} />
                {unreadCount > 0 && (
                  <span className="notification-badge">{unreadCount > 9 ? "9+" : unreadCount}</span>
                )}
              </button>
              {notifOpen && (
                <NotificationPanel
                  notifications={notifications}
                  isLoading={notifLoading}
                  onMarkRead={handleMarkRead}
                  onMarkAllRead={handleMarkAllRead}
                  onSelect={handleSelectNotification}
                />
              )}
            </div>
          </div>
        </header>

        <section className="page-content">{children}</section>
      </main>
    </div>
  );
}
