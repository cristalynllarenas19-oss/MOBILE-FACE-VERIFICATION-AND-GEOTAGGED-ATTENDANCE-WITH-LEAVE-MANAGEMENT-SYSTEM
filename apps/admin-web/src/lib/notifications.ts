import { apiRequest } from "./api";

export type AppNotification = {
  id: string;
  title: string;
  message: string;
  type: string | null;
  entityId: string | null;
  readAt: string | null;
  createdAt: string;
};

// Which half of the inbox a portal shows: "reviewer" is the team's requests
// a Supervisor/Admin has to act on (admin portal), "personal" is what is
// about the signed-in person themselves (employee portal). Announcements
// show in both. No view = the whole inbox, for an account with a single
// role (and so a single portal). Mirrors employee-mobile's api.ts.
export type NotificationView = "reviewer" | "personal";

export function notificationViewFor(activeView: "admin" | "employee", roles: string[]): NotificationView | undefined {
  if (roles.length <= 1) return undefined;
  return activeView === "employee" ? "personal" : "reviewer";
}

const viewQuery = (view?: NotificationView) => (view ? `?view=${view}` : "");

export function fetchNotifications(view?: NotificationView) {
  return apiRequest<AppNotification[]>(`/notifications/me${viewQuery(view)}`);
}

export function fetchUnreadCount(view?: NotificationView) {
  return apiRequest<{ count: number }>(`/notifications/me/unread-count${viewQuery(view)}`);
}

export function markNotificationRead(id: string) {
  return apiRequest(`/notifications/${id}/read`, { method: "PATCH" });
}

export function markAllNotificationsRead(view?: NotificationView) {
  return apiRequest(`/notifications/read-all${viewQuery(view)}`, { method: "PATCH" });
}
