import {
  ArrowLeftRight, BarChart3,
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
import { EvaluationModal } from "../../features/evaluations/EvaluationModal";
import { PermissionCode, permissions } from "../../types/rbac";
import { apiRequest } from "../../lib/api";
import logo from "../../assets/unileaf-logo.png";
import {
  AppNotification,
  fetchNotifications,
  fetchUnreadCount,
  markAllNotificationsRead,
  markNotificationRead,
} from "../../lib/notifications";
import { CACHE_KEYS, revalidateCached, useCachedData } from "../../lib/dataCache";
import { getLeaveRequests, getLeaveBalances } from "../../features/employee-portal/api";
import { NotificationPanel } from "./NotificationPanel";
import { NotificationDetailModal } from "./NotificationDetailModal";
import "./AppLayout.css";
import "./NotificationPanel.css";

const NOTIFICATION_POLL_MS = 5000;
// Stable fallback so downstream filters don't recompute on every render
// while the cache/network is still empty.
const EMPTY_NOTIFICATIONS: AppNotification[] = [];

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
  employeeId?: string;
};

export const navItems = [
  { id: "dashboard",  label: "Dashboard",            icon: LayoutDashboard, permission: permissions.dashboardView },
  { id: "employees",  label: "Employee Management",   icon: UserSquare2,     permission: permissions.employeesRead },
  { id: "face-registration", label: "Face Registration", icon: ScanFace,      permission: permissions.usersWrite },
  { id: "geotagging", label: "Geotagged Areas",       icon: MapPin,          permission: permissions.attendanceRead },
  { id: "schedules",  label: "Schedule Management",   icon: CalendarClock,   permission: permissions.schedulesRead },
  { id: "attendance", label: "Attendance Management", icon: CheckSquare,     permission: permissions.attendanceRead },
  { id: "leave",      label: "Leave Management",      icon: ClipboardList,   permission: permissions.leaveRead },
  { id: "reports",    label: "Reports",               icon: BarChart3,       permission: permissions.reportsRead },
  { id: "users",      label: "User Management",       icon: Users,           permission: permissions.usersRead },
  { id: "utilities",    label: "Utilities",               icon: Settings,       permission: permissions.auditRead },

  // Employee self-service nav items (mirrors employee-mobile bottom tabs)
  { id: "employee-attendance", label: "Attendance", icon: CheckSquare,   permission: permissions.employeeAttendanceView },
  { id: "employee-leave",      label: "Leave",       icon: ClipboardList, permission: permissions.employeeLeaveView },
  { id: "employee-dtr",        label: "DTR",         icon: CalendarClock, permission: permissions.employeeDtrView },
  { id: "employee-work-area",  label: "Work Area",   icon: MapPin,        permission: permissions.employeeWorkAreaView },
  { id: "employee-settings",   label: "Settings",    icon: Settings2,     permission: permissions.employeeSettingsView },
];


export function isNavItemVisible(item: { permission: PermissionCode; supervisorOnly?: boolean }, userPermissions: PermissionCode[], roles: string[]) {
  if (!userPermissions.includes(item.permission)) return false;
  if (item.supervisorOnly && roles.includes("ADMIN")) return false;
  return true;
}


export function getVisibleNavItems(activeView: "admin" | "employee", userPermissions: PermissionCode[], roles: string[] = []) {
  return activeView === "employee"
    ? navItems.filter((item) => item.id.startsWith("employee-"))
    : navItems.filter((item) => isNavItemVisible(item, userPermissions, roles));
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
  onNavigate: (page: string, entityId?: string) => void;
  onSwitchView: (view: "admin" | "employee") => void;
  onLogout: () => void;
  user: User;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  // Cache-first 
  const notificationsCache = useCachedData<AppNotification[]>(CACHE_KEYS.notifications, fetchNotifications);
  const notifications = notificationsCache.data ?? EMPTY_NOTIFICATIONS;
  const setNotifications = notificationsCache.setData;
  const notifLoading = notificationsCache.isLoading;
  const [unreadCount, setUnreadCount] = useState(0);
  // Employee-portal-only
  const [detailNotification, setDetailNotification] = useState<AppNotification | null>(null);
  // Supervisor-portal only
  const [evaluatingEmployeeId, setEvaluatingEmployeeId] = useState<string | null>(null);
  const notifRef = useRef<HTMLDivElement>(null);
  const switcherRef = useRef<HTMLDivElement>(null);

  
  const visibleItems = getVisibleNavItems(activeView, user.adminPermissions ?? user.permissions, user.roles);
  const canSwitchView = user.roles.length > 1;
  const adminViewLabel = user.roles.includes("ADMIN")
    ? "Admin Dashboard"
    : user.roles.includes("SUPERVISOR")
      ? "Supervisor Dashboard"
      : "Admin Dashboard";
  
  const profileRoleLabel =
    activeView === "employee"
      ? "EMPLOYEE"
      : user.roles.includes("ADMIN")
        ? "ADMIN"
        : user.roles.includes("SUPERVISOR")
          ? "SUPERVISOR"
          : user.role;

  useEffect(() => {
    let lastKnownCount: number | null = null;
    const refreshUnreadCount = () => {
      fetchUnreadCount()
        .then((data) => {
          setUnreadCount(data.count);
          
          if (lastKnownCount !== null && data.count > lastKnownCount) {
            if (user.employeeId) {
              revalidateCached(CACHE_KEYS.leaveRequests(user.employeeId), () => getLeaveRequests(user.employeeId!)).catch(() => undefined);
              revalidateCached(CACHE_KEYS.leaveBalances(user.employeeId), () => getLeaveBalances(user.employeeId!)).catch(() => undefined);
            }
            
            const roles = user.roles?.length ? user.roles : [user.role];
            if (roles.some((role) => role !== "EMPLOYEE")) {
              revalidateCached("admin-leave-requests", () => apiRequest("/leave-requests")).catch(() => undefined);
            }
          }
          lastKnownCount = data.count;
        })
        .catch(() => undefined);
    };
    refreshUnreadCount();
    const interval = window.setInterval(refreshUnreadCount, NOTIFICATION_POLL_MS);
    return () => window.clearInterval(interval);
  }, [user.employeeId]);

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
      notificationsCache.refresh().catch(() => undefined);
    }
  };

  const handleMarkRead = (id: string) => {
    setNotifications(notifications.map((item) => (item.id === id ? { ...item, readAt: new Date().toISOString() } : item)));
    setUnreadCount((count) => Math.max(0, count - 1));
    markNotificationRead(id).catch(() => undefined);
  };

  const handleMarkAllRead = () => {
    setNotifications(notifications.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })));
    setUnreadCount(0);
    markAllNotificationsRead().catch(() => undefined);
  };

  const ATTENDANCE_NOTIFICATION_TYPES = ["ATTENDANCE_FLAGGED", "FACE_MISMATCH_STREAK", "ATTENDANCE_VALIDATED", "ATTENDANCE_FAKE_ATTEMPT"];

 
  const isSupervisorOnly = !user.roles.includes("ADMIN") && user.roles.includes("SUPERVISOR");

  const handleSelectNotification = (notification: AppNotification) => {
  
    if (activeView === "employee") {
      setNotifOpen(false);
      setDetailNotification(notification);
      return;
    }

    
    if (activeView === "admin" && isSupervisorOnly && notification.type === "ANNOUNCEMENT") {
      setNotifOpen(false);
      setDetailNotification(notification);
      return;
    }

    if (notification.type?.startsWith("LEAVE") && activeView === "admin" && (user.adminPermissions ?? user.permissions).includes(permissions.leaveRead)) {
     
      onNavigate("leave", notification.entityId ?? undefined);
    } else if (
      notification.type &&
      ATTENDANCE_NOTIFICATION_TYPES.includes(notification.type) &&
      activeView === "admin" &&
      (user.adminPermissions ?? user.permissions).includes(permissions.attendanceRead)
    ) {
      
      onNavigate("attendance", notification.entityId ?? undefined);
    } else if (
      notification.type === "PROBATION_REGULARIZATION_DUE" &&
      activeView === "admin" &&
      (user.adminPermissions ?? user.permissions).includes(permissions.employeesRead)
    ) {
      
      onNavigate("employees", notification.entityId ?? undefined);
    } else if (
      notification.type === "SUPERVISOR_EVALUATION_REQUIRED" &&
      activeView === "admin" &&
      notification.entityId &&
      (user.adminPermissions ?? user.permissions).includes(permissions.evaluationsWrite)
    ) {
      
      setEvaluatingEmployeeId(notification.entityId);
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

      {evaluatingEmployeeId && (
        <EvaluationModal employeeId={evaluatingEmployeeId} onClose={() => setEvaluatingEmployeeId(null)} />
      )}

      {detailNotification && (
        <NotificationDetailModal
          notification={detailNotification}
          onClose={() => setDetailNotification(null)}
          onViewLeaveRequest={
            detailNotification.type?.startsWith("LEAVE")
              ? () => {
                  onNavigate("employee-leave", detailNotification.entityId ?? undefined);
                  setDetailNotification(null);
                }
              : undefined
          }
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
                  E-TALA: Electronic Tracking of Announcements, Leave, and Attendance
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
