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

export function fetchNotifications() {
  return apiRequest<AppNotification[]>("/notifications/me");
}

export function fetchUnreadCount() {
  return apiRequest<{ count: number }>("/notifications/me/unread-count");
}

export function markNotificationRead(id: string) {
  return apiRequest(`/notifications/${id}/read`, { method: "PATCH" });
}

export function markAllNotificationsRead() {
  return apiRequest("/notifications/read-all", { method: "PATCH" });
}
