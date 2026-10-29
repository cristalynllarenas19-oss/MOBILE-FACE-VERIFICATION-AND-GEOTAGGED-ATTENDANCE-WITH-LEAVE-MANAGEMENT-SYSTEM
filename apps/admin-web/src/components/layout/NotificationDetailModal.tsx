import { AppNotification } from "../../lib/notifications";
import { NotificationIcon, notificationCategory } from "./NotificationPanel";
import { ModalCloseButton } from "../ui/ModalCloseButton";
import { renderFormattedText } from "../../lib/richText";
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

// The backend appends a reviewer's note to the end of a notification as
// " Remarks: …", " Reason: …" or " Requirement needed: …" — split those off
// so each shows in its own box below the message. Mirrors employee-mobile's
// NotificationsScreen.
const NOTE_MARKER = /\s(Remarks|Reason|Requirement needed):\s/g;

function splitNotificationNotes(message: string): { body: string; notes: Array<{ label: string; text: string }> } {
  const matches = Array.from(message.matchAll(NOTE_MARKER));
  if (matches.length === 0) return { body: message, notes: [] };
  return {
    body: message.slice(0, matches[0].index).trim(),
    notes: matches.map((match, i) => ({
      label: match[1],
      text: message.slice(match.index! + match[0].length, matches[i + 1]?.index ?? message.length).trim(),
    })),
  };
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
  const category = notificationCategory(notification.type);
  return (
    <div className="notif-detail-backdrop" role="presentation" onClick={onClose}>
      <section
        className={`notif-detail-card ${category === "critical" ? "critical" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="notif-detail-title"
        onClick={(e) => e.stopPropagation()}
      >
        <ModalCloseButton onClose={onClose} />
        <div className="notif-detail-header">
          <span className={`notif-detail-icon ${category}`}>
            <NotificationIcon type={notification.type} />
          </span>
          <div className="notif-detail-header-text">
            <h2 id="notif-detail-title" className="notif-detail-title">{notification.title}</h2>
            <p className="notif-detail-time">{formatFullDate(notification.createdAt)}</p>
          </div>
        </div>
        <div className="notif-detail-divider" />
        {notification.type === "ANNOUNCEMENT" ? (
          <div className="notif-detail-message">{renderFormattedText(notification.message)}</div>
        ) : (
          (() => {
            const { body, notes } = splitNotificationNotes(notification.message);
            return (
              <>
                <p className="notif-detail-message">{body}</p>
                {notes.map((note, i) => (
                  <div key={i} className="notif-detail-note">
                    <span className="notif-detail-note-label">{note.label}</span>
                    <p className="notif-detail-note-text">{note.text}</p>
                  </div>
                ))}
              </>
            );
          })()
        )}

        {onViewLeaveRequest && (
          <div className="notif-detail-actions">
            <button type="button" className="notif-detail-secondary" onClick={onViewLeaveRequest}>
              View Leave Request
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
