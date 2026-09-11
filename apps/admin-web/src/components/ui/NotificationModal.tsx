import { Check, X as XIcon } from "lucide-react";
import "./NotificationModal.css";

export type NotificationConfig = {
  type: "success" | "error";
  title: string;
  message: string;
  buttonLabel?: string;
} | null;

export function NotificationModal({
  notification,
  onClose,
}: {
  notification: NotificationConfig;
  onClose: () => void;
}) {
  if (!notification) return null;

  return (
    <div className="notification-modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className={`notification-modal ${notification.type}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="notification-modal-title"
        aria-describedby="notification-modal-message"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="notification-modal-icon-wrap">
          {notification.type === "success" ? <Check size={30} strokeWidth={2.4} /> : <XIcon size={30} strokeWidth={2.4} />}
        </div>
        <h2 id="notification-modal-title" className="notification-modal-title">
          {notification.title}
        </h2>
        <p id="notification-modal-message" className="notification-modal-message">
          {notification.message}
        </p>
        <button type="button" className="notification-modal-button" onClick={onClose}>
          {notification.buttonLabel ?? (notification.type === "success" ? "Done" : "Try Again")}
        </button>
      </section>
    </div>
  );
}
