import {
  BarChart3,
  Bell,
  CalendarClock,
  CheckSquare,
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

type User = {
  displayName: string;
  role: string;
  permissions: PermissionCode[];
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
  const [notifOpen, setNotifOpen] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifLoading, setNotifLoading] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);

  // EMPLOYEE role always sees only the 5 self-service tabs, never admin pages,
  // regardless of what permissions the backend happens to send.
  const visibleItems = user.role === "EMPLOYEE"
    ? navItems.filter((item) => item.id.startsWith("employee-"))
    : navItems.filter((item) => user.permissions.includes(item.permission));

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
