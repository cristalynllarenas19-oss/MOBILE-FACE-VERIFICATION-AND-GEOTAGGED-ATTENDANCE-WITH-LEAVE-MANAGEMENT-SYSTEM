import React, { useCallback, useEffect, useState } from "react";
import {
  Modal,
  SafeAreaView,
  View,
  Text,
  Pressable,
  FlatList,
  RefreshControl,
  StyleSheet,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  AppNotification,
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "../api";

type Props = {
  visible: boolean;
  onClose: () => void;
  onUnreadCountChange: (count: number) => void;
};

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

function notificationIcon(type: string | null) {
  if (type === "LEAVE_APPROVED") return { name: "checkmark-circle-outline" as const, color: "#15803D" };
  if (type === "LEAVE_REJECTED") return { name: "close-circle-outline" as const, color: "#B91C1C" };
  if (type === "LEAVE_SUBMITTED") return { name: "document-text-outline" as const, color: "#1680D8" };
  return { name: "notifications-outline" as const, color: "#244c7a" };
}

export default function NotificationsScreen({ visible, onClose, onUnreadCountChange }: Props) {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await getNotifications();
      setNotifications(data);
    } catch (error) {
      console.error("Failed to load notifications", error);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    setIsLoading(true);
    load().finally(() => setIsLoading(false));
  }, [visible, load]);

  async function handleRefresh() {
    setIsRefreshing(true);
    await load();
    setIsRefreshing(false);
  }

  async function handlePressItem(notification: AppNotification) {
    if (!notification.readAt) {
      const updated = notifications.map((item) =>
        item.id === notification.id ? { ...item, readAt: new Date().toISOString() } : item
      );
      setNotifications(updated);
      onUnreadCountChange(updated.filter((item) => !item.readAt).length);
      markNotificationRead(notification.id).catch(() => undefined);
    }
  }

  async function handleMarkAllRead() {
    const updated = notifications.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() }));
    setNotifications(updated);
    onUnreadCountChange(0);
    markAllNotificationsRead().catch(() => undefined);
  }

  const hasUnread = notifications.some((item) => !item.readAt);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.header}>
          <Pressable onPress={onClose} style={styles.headerButton}>
            <Ionicons name="chevron-back" size={24} color="#062B59" />
          </Pressable>
          <Text style={styles.headerTitle}>Notifications</Text>
          <Pressable onPress={handleMarkAllRead} disabled={!hasUnread} style={styles.headerButton}>
            <Text style={[styles.markAllText, !hasUnread && styles.markAllTextDisabled]}>Mark all read</Text>
          </Pressable>
        </View>

        <FlatList
          data={notifications}
          keyExtractor={(item) => item.id}
          contentContainerStyle={notifications.length === 0 ? styles.emptyContainer : styles.listContainer}
          refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} colors={["#1680D8"]} />}
          ListEmptyComponent={
            !isLoading ? (
              <View style={styles.emptyState}>
                <Ionicons name="mail-open-outline" size={36} color="#CBD5E1" />
                <Text style={styles.emptyText}>You're all caught up.</Text>
              </View>
            ) : null
          }
          renderItem={({ item }) => {
            const icon = notificationIcon(item.type);
            const isUnread = !item.readAt;
            return (
              <Pressable
                style={[styles.notificationRow, isUnread && styles.notificationRowUnread]}
                onPress={() => handlePressItem(item)}
              >
                <View style={[styles.iconCircle, { backgroundColor: `${icon.color}1A` }]}>
                  <Ionicons name={icon.name} size={20} color={icon.color} />
                </View>
                <View style={styles.notificationBody}>
                  <Text style={styles.notificationTitle}>{item.title}</Text>
                  <Text style={styles.notificationMessage}>{item.message}</Text>
                  <Text style={styles.notificationTime}>{timeAgo(item.createdAt)}</Text>
                </View>
                {isUnread && <View style={styles.unreadDot} />}
              </Pressable>
            );
          }}
        />
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#FFFFFF",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#E2E8F0",
  },
  headerButton: {
    minWidth: 40,
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: "#062B59",
  },
  markAllText: {
    fontSize: 12.5,
    fontWeight: "700",
    color: "#1680D8",
    textAlign: "right",
  },
  markAllTextDisabled: {
    color: "#CBD5E1",
  },
  listContainer: {
    paddingVertical: 4,
  },
  emptyContainer: {
    flexGrow: 1,
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingTop: 80,
  },
  emptyText: {
    color: "#94A3B8",
    fontSize: 14,
    fontWeight: "600",
  },
  notificationRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#F1F5F9",
  },
  notificationRowUnread: {
    backgroundColor: "#F0F7FF",
  },
  iconCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  notificationBody: {
    flex: 1,
  },
  notificationTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#062B59",
  },
  notificationMessage: {
    fontSize: 13,
    color: "#475569",
    marginTop: 2,
    lineHeight: 18,
  },
  notificationTime: {
    fontSize: 11,
    color: "#94A3B8",
    fontWeight: "600",
    marginTop: 6,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#1680D8",
    marginTop: 4,
  },
});
