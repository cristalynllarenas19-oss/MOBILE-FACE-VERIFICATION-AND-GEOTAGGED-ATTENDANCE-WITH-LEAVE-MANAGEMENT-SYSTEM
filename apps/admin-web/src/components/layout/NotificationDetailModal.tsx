import { X } from "lucide-react";
import { AppNotification } from "../../lib/notifications";
import { NotificationIcon } from "./NotificationPanel";
import "./NotificationDetailModal.css";

function formatFullDate(value: string) {
  return new Date(value).toLocaleString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Employee-portal-only notification detail — shown in place of navigating
// away, so clicking a notification never loses the employee's current page.
// Mirrors employee-mobile's NotificationsScreen detail sheet (icon, title,
// full timestamp, full message). Read/unread state is already updated by
// NotificationPanel before this ever opens (see its onClick), so this
// component only ever displays — it never touches read state itself.
export function NotificationDetailModal({
  notification,
  onClose,
  onViewLeaveRequest,
}: {
  notification: AppNotification;
  onClose: () => void;
  // Only offered for LEAVE-type notifications with a linked request — keeps
  // the existing "jump straight to this request" capability available
  // instead of silently removing it now that the click itself opens this
  // modal rather than navigating directly.
  onViewLeaveRequest?: () => void;
}) {
  return (
    <div className="notif-detail-backdrop" role="presentation" onClick={onClose}>
      <section
        className="notif-detail-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="notif-detail-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="notif-detail-close" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>

        <span className={`notif-detail-icon ${notification.type?.toLowerCase() ?? ""}`}>
          <NotificationIcon type={notification.type} />
        </span>

        <h2 id="notif-detail-title" className="notif-detail-title">{notification.title}</h2>
        <p className="notif-detail-time">{formatFullDate(notification.createdAt)}</p>
        <p className="notif-detail-message">{notification.message}</p>

        <div className="notif-detail-actions">
          {onViewLeaveRequest && (
            <button type="button" className="notif-detail-secondary" onClick={onViewLeaveRequest}>
              View Leave Request
            </button>
          )}
          <button type="button" className="notif-detail-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </section>
    </div>
  );
}
