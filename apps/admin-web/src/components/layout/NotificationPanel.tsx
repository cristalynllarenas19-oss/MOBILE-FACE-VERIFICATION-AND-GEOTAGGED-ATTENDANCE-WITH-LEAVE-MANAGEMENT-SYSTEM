import {
  Ban,
  CalendarCheck,
  CalendarX,
  ClipboardList,
  FileText,
  FileWarning,
  Hourglass,
  Inbox,
  Lock,
  Megaphone,
  ScanFace,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  UserCheck,
  Bell as BellIcon,
} from "lucide-react";
import { AppNotification } from "../../lib/notifications";
import { stripFormattingTokens } from "../../lib/richText";

// Category carries the color (scannable at a glance); the glyph disambiguates
// the specific type within it. See the "Notification Icon System" audit —
// this table is the single source of truth mirrored in employee-mobile's
// NotificationsScreen.tsx (lucide-react here vs Ionicons there, same mapping).
const NOTIFICATION_ICON_MAP: Record<string, { Icon: typeof BellIcon; category: string }> = {
  LEAVE_SUBMITTED: { Icon: FileText, category: "info" },
  LEAVE_RESUBMITTED: { Icon: FileText, category: "info" },
  LEAVE_NEEDS_REQUIREMENTS: { Icon: FileWarning, category: "pending" },
  LEAVE_APPROVED: { Icon: CalendarCheck, category: "success" },
  LEAVE_REJECTED: { Icon: CalendarX, category: "rejected" },
  LEAVE_CANCELLATION_REQUESTED: { Icon: Hourglass, category: "pending" },
  LEAVE_CANCELLED: { Icon: Ban, category: "neutral" },
  ANNOUNCEMENT: { Icon: Megaphone, category: "announce" },
  PROBATION_REGULARIZATION_DUE: { Icon: UserCheck, category: "pending" },
  SUPERVISOR_EVALUATION_REQUIRED: { Icon: ClipboardList, category: "pending" },
  EVALUATION_CONVERSION_OUTCOME: { Icon: UserCheck, category: "info" },
  EMPLOYEE_REGULARIZED: { Icon: UserCheck, category: "success" },
  ATTENDANCE_FLAGGED: { Icon: TriangleAlert, category: "pending" },
  ATTENDANCE_VALIDATED: { Icon: ShieldCheck, category: "success" },
  ATTENDANCE_FAKE_ATTEMPT: { Icon: ShieldAlert, category: "critical" },
  ATTENDANCE_LOCKED: { Icon: Lock, category: "critical" },
  FACE_MISMATCH_STREAK: { Icon: ScanFace, category: "critical" },
};

// Lowercased type -> category class name, applied by callers as
// `notification-item-icon ${notificationCategory(type)}`.
export function notificationCategory(type: string | null) {
  return type ? (NOTIFICATION_ICON_MAP[type]?.category ?? "info") : "info";
}

function timeAgo(value: string) {
  const diffMs = Date.now() - new Date(value).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(value).toLocaleDateString();
}

export function NotificationIcon({ type }: { type: string | null }) {
  const Icon = (type ? NOTIFICATION_ICON_MAP[type]?.Icon : undefined) ?? BellIcon;
  return <Icon size={16} />;
}

export function NotificationPanel({
  notifications,
  isLoading,
  onMarkRead,
  onMarkAllRead,
  onSelect,
}: {
  notifications: AppNotification[];
  isLoading: boolean;
  onMarkRead: (id: string) => void;
  onMarkAllRead: () => void;
  onSelect: (notification: AppNotification) => void;
}) {
  const hasUnread = notifications.some((n) => !n.readAt);
  const unreadCount = notifications.filter((n) => !n.readAt).length;

  return (
    <div className="notification-panel" role="dialog" aria-label="Notifications">
      <div className="notification-panel-header">
        <div className="notification-panel-title">
          <h3>Notifications</h3>
          {unreadCount > 0 && (
            <span className="notification-panel-count">{unreadCount > 99 ? "99+" : unreadCount}</span>
          )}
        </div>
        <button
          className="notification-mark-all"
          onClick={onMarkAllRead}
          disabled={!hasUnread}
        >
          Mark all as read
        </button>
      </div>

      <div className="notification-panel-list">
        {isLoading ? (
          <div className="notification-empty">Loading…</div>
        ) : notifications.length === 0 ? (
          <div className="notification-empty">
            <span className="notification-empty-icon">
              <Inbox size={24} />
            </span>
            <strong>You're all caught up</strong>
            <span className="notification-empty-subtext">New notifications will show up here.</span>
          </div>
        ) : (
          notifications.map((notification) => {
            const category = notificationCategory(notification.type);
            return (
            <button
              key={notification.id}
              className={`notification-item ${category} ${notification.readAt ? "" : "unread"} ${category === "critical" ? "critical" : ""}`}
              onClick={() => {
                if (!notification.readAt) onMarkRead(notification.id);
                onSelect(notification);
              }}
            >
              <span className={`notification-item-icon ${category}`}>
                <NotificationIcon type={notification.type} />
              </span>
              <span className="notification-item-body">
                <span className="notification-item-title-row">
                  <strong>{notification.title}</strong>
                  {!notification.readAt && <span className="notification-item-dot" aria-hidden="true" />}
                </span>
                <p>{notification.type === "ANNOUNCEMENT" ? stripFormattingTokens(notification.message) : notification.message}</p>
                <time>{timeAgo(notification.createdAt)}</time>
              </span>
            </button>
            );
          })
        )}
      </div>
    </div>
  );
}
