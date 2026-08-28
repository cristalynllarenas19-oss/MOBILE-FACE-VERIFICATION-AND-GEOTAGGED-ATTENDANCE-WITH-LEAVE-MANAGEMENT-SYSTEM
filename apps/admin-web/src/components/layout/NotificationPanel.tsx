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

  return (
    <div className="notification-panel" role="dialog" aria-label="Notifications">
      <div className="notification-panel-header">
        <h3>Notifications</h3>
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
            <Inbox size={22} />
            <span>You're all caught up.</span>
          </div>
        ) : (
          notifications.map((notification) => {
            const category = notificationCategory(notification.type);
            return (
            <button
              key={notification.id}
              className={`notification-item ${notification.readAt ? "" : "unread"} ${category === "critical" ? "critical" : ""}`}
              onClick={() => {
                if (!notification.readAt) onMarkRead(notification.id);
                onSelect(notification);
              }}
            >
              <span className={`notification-item-icon ${category}`}>
                <NotificationIcon type={notification.type} />
              </span>
              <span className="notification-item-body">
                <strong>{notification.title}</strong>
                <p>{notification.message}</p>
                <time>{timeAgo(notification.createdAt)}</time>
              </span>
              {!notification.readAt && <span className="notification-item-dot" aria-hidden="true" />}
            </button>
            );
          })
        )}
      </div>
    </div>
  );
}
