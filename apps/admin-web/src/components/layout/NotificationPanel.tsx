import { CalendarCheck, CalendarX, Inbox, Bell as BellIcon } from "lucide-react";
import { AppNotification } from "../../lib/notifications";

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

function NotificationIcon({ type }: { type: string | null }) {
  if (type === "LEAVE_APPROVED") return <CalendarCheck size={16} />;
  if (type === "LEAVE_REJECTED") return <CalendarX size={16} />;
  return <BellIcon size={16} />;
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
          notifications.map((notification) => (
            <button
              key={notification.id}
              className={`notification-item ${notification.readAt ? "" : "unread"}`}
              onClick={() => {
                if (!notification.readAt) onMarkRead(notification.id);
                onSelect(notification);
              }}
            >
              <span className={`notification-item-icon ${notification.type?.toLowerCase() ?? ""}`}>
                <NotificationIcon type={notification.type} />
              </span>
              <span className="notification-item-body">
                <strong>{notification.title}</strong>
                <p>{notification.message}</p>
                <time>{timeAgo(notification.createdAt)}</time>
              </span>
              {!notification.readAt && <span className="notification-item-dot" aria-hidden="true" />}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
