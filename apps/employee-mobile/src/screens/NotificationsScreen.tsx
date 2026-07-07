import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Modal,
  SafeAreaView,
  View,
  Text,
  TextInput,
  Pressable,
  FlatList,
  RefreshControl,
  ActivityIndicator,
  StyleSheet,
  Animated,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import {
  AppNotification,
  LeaveRequest,
  getNotifications,
  getLeaveRequests,
  markAllNotificationsRead,
  markNotificationRead,
  resubmitLeaveRequest,
} from "../api";

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

type Props = {
  visible: boolean;
  onClose: () => void;
  onUnreadCountChange: (count: number) => void;
  employeeId?: string;
};

type PickedAttachment = {
  name: string;
  mimeType: string;
  sizeBytes: number;
  base64: string;
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
  if (type === "LEAVE_NEEDS_REQUIREMENTS") return { name: "document-attach-outline" as const, color: "#B45309" };
  if (type === "LEAVE_SUBMITTED") return { name: "document-text-outline" as const, color: "#1680D8" };
  return { name: "notifications-outline" as const, color: "#244c7a" };
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FadeInView({
  children,
  delay = 0,
  style,
}: {
  children: React.ReactNode;
  delay?: number;
  style?: any;
}) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(progress, {
      toValue: 1,
      duration: 260,
      delay,
      useNativeDriver: true,
    }).start();
  }, []);

  return (
    <Animated.View
      style={[
        style,
        {
          opacity: progress,
          transform: [
            {
              translateY: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [10, 0],
              }),
            },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

function PulsingDot() {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 0, useNativeDriver: true }),
        Animated.delay(600),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);

  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.2] });
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.7, 0] });

  return (
    <View style={styles.unreadDotWrap}>
      <Animated.View style={[styles.unreadDotPulse, { opacity, transform: [{ scale }] }]} />
      <View style={styles.unreadDot} />
    </View>
  );
}

export default function NotificationsScreen({ visible, onClose, onUnreadCountChange, employeeId }: Props) {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [leaveRequests, setLeaveRequests] = useState<LeaveRequest[]>([]);

  // Only one notification's inline resubmit form is open at a time.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [attachment, setAttachment] = useState<PickedAttachment | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isPickingFile, setIsPickingFile] = useState(false);
  const [note, setNote] = useState("");
  const [isResubmitting, setIsResubmitting] = useState(false);
  const [justResubmittedId, setJustResubmittedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await getNotifications();
      setNotifications(data);
    } catch (error) {
      console.error("Failed to load notifications", error);
    }
    if (employeeId) {
      try {
        setLeaveRequests(await getLeaveRequests(employeeId));
      } catch (error) {
        console.error("Failed to load leave requests", error);
      }
    }
  }, [employeeId]);

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

  function collapseResubmitForm() {
    setExpandedId(null);
    setAttachment(null);
    setAttachmentError(null);
    setNote("");
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

    if (notification.type === "LEAVE_NEEDS_REQUIREMENTS") {
      if (expandedId === notification.id) {
        collapseResubmitForm();
      } else {
        setExpandedId(notification.id);
        setAttachment(null);
        setAttachmentError(null);
        setNote("");
        setJustResubmittedId(null);
      }
    }
  }

  async function handleMarkAllRead() {
    const updated = notifications.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() }));
    setNotifications(updated);
    onUnreadCountChange(0);
    markAllNotificationsRead().catch(() => undefined);
  }

  async function pickAttachment() {
    setAttachmentError(null);
    setIsPickingFile(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ["image/*", "application/pdf"],
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];

      if (asset.size && asset.size > MAX_ATTACHMENT_BYTES) {
        setAttachmentError("File is too large. Please attach a file under 5MB.");
        return;
      }

      const base64 = asset.base64 ?? (await new File(asset.uri).base64());
      const sizeBytes = asset.size ?? Math.ceil((base64.length * 3) / 4);

      if (sizeBytes > MAX_ATTACHMENT_BYTES) {
        setAttachmentError("File is too large. Please attach a file under 5MB.");
        return;
      }

      setAttachment({
        name: asset.name,
        mimeType: asset.mimeType ?? "application/octet-stream",
        sizeBytes,
        base64,
      });
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "Failed to attach file.");
    } finally {
      setIsPickingFile(false);
    }
  }

  async function handleResubmit(leaveRequestId: string) {
    if (!attachment) {
      setAttachmentError("Please attach the requested requirement before resubmitting.");
      return;
    }
    setIsResubmitting(true);
    try {
      await resubmitLeaveRequest(leaveRequestId, {
        note: note.trim() || undefined,
        attachmentName: attachment.name,
        attachmentMimeType: attachment.mimeType,
        attachmentData: attachment.base64,
      });
      const resubmittedNotificationId = expandedId;
      collapseResubmitForm();
      setJustResubmittedId(resubmittedNotificationId);
      await load();
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "Failed to resubmit leave request.");
    } finally {
      setIsResubmitting(false);
    }
  }

  const hasUnread = notifications.some((item) => !item.readAt);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.header}>
          <Pressable
            onPress={onClose}
            style={({ pressed }) => [styles.headerButton, pressed && styles.headerButtonPressed]}
          >
            <Ionicons name="chevron-back" size={24} color="#062B59" />
          </Pressable>
          <Text style={styles.headerTitle}>Notifications</Text>
          <Pressable
            onPress={handleMarkAllRead}
            disabled={!hasUnread}
            style={({ pressed }) => [styles.headerButton, pressed && styles.headerButtonPressed]}
          >
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
          renderItem={({ item, index }) => {
            const icon = notificationIcon(item.type);
            const isUnread = !item.readAt;
            const isExpanded = expandedId === item.id;
            const leaveRequest = item.entityId ? leaveRequests.find((r) => r.id === item.entityId) : undefined;
            const lastRejection = leaveRequest
              ? [...(leaveRequest.notes ?? [])].reverse().find((n) => n.type === "REJECTED")
              : undefined;
            const stillNeedsRevision = leaveRequest?.status === "NEEDS_REVISION";

            return (
              <FadeInView delay={Math.min(index * 40, 240)}>
                <Pressable
                  style={({ pressed }) => [
                    styles.notificationRow,
                    isUnread && styles.notificationRowUnread,
                    pressed && styles.notificationRowPressed,
                  ]}
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
                  {isUnread && <PulsingDot />}
                </Pressable>

                {item.type === "LEAVE_NEEDS_REQUIREMENTS" && justResubmittedId === item.id && (
                  <FadeInView style={styles.resubmitConfirmation}>
                    <Ionicons name="checkmark-circle" size={16} color="#15803D" />
                    <Text style={styles.resubmitConfirmationText}>Resubmitted — your reviewer has been notified.</Text>
                  </FadeInView>
                )}

                {isExpanded && (
                  <FadeInView style={styles.resubmitPanel}>
                    {!leaveRequest ? (
                      <ActivityIndicator size="small" color="#1680D8" />
                    ) : !stillNeedsRevision ? (
                      <Text style={styles.resubmitInfoText}>
                        This request has already moved on — check the Leave tab for its current status.
                      </Text>
                    ) : (
                      <>
                        {lastRejection?.requirementDetails && (
                          <Text style={styles.resubmitRequirementText}>
                            Requirement needed: {lastRejection.requirementDetails}
                          </Text>
                        )}

                        {attachment ? (
                          <View style={styles.attachmentChip}>
                            <Ionicons
                              name={attachment.mimeType.startsWith("image/") ? "image-outline" : "document-outline"}
                              size={18}
                              color="#1680D8"
                            />
                            <View style={{ flex: 1 }}>
                              <Text style={styles.attachmentName} numberOfLines={1}>{attachment.name}</Text>
                              <Text style={styles.attachmentSize}>{formatBytes(attachment.sizeBytes)}</Text>
                            </View>
                            <Pressable onPress={() => setAttachment(null)} style={styles.attachmentRemove}>
                              <Ionicons name="close" size={16} color="#64748B" />
                            </Pressable>
                          </View>
                        ) : (
                          <Pressable
                            style={({ pressed }) => [styles.attachmentPicker, pressed && styles.attachmentPickerPressed]}
                            onPress={pickAttachment}
                            disabled={isPickingFile}
                          >
                            {isPickingFile ? (
                              <ActivityIndicator size="small" color="#1680D8" />
                            ) : (
                              <Ionicons name="attach-outline" size={20} color="#1680D8" />
                            )}
                            <Text style={styles.attachmentPickerText}>
                              {isPickingFile ? "Opening…" : "Tap to attach the requirement"}
                            </Text>
                          </Pressable>
                        )}
                        {attachmentError && <Text style={styles.attachmentErrorText}>{attachmentError}</Text>}

                        <TextInput
                          placeholder="Optional note to the reviewer"
                          multiline
                          value={note}
                          onChangeText={setNote}
                          style={styles.noteInput}
                        />

                        <Pressable
                          style={({ pressed }) => [
                            styles.resubmitButton,
                            isResubmitting && styles.resubmitButtonDisabled,
                            pressed && !isResubmitting && styles.resubmitButtonPressed,
                          ]}
                          onPress={() => handleResubmit(leaveRequest.id)}
                          disabled={isResubmitting}
                        >
                          {isResubmitting ? (
                            <ActivityIndicator color="#FFFFFF" />
                          ) : (
                            <Text style={styles.resubmitButtonText}>Resubmit Request</Text>
                          )}
                        </Pressable>
                      </>
                    )}
                  </FadeInView>
                )}
              </FadeInView>
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
  headerButtonPressed: {
    opacity: 0.6,
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
  notificationRowPressed: {
    opacity: 0.7,
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
  unreadDotWrap: {
    width: 8,
    height: 8,
    marginTop: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  unreadDotPulse: {
    position: "absolute",
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#1680D8",
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#1680D8",
  },
  resubmitPanel: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: "#F8FAFC",
    borderBottomWidth: 1,
    borderBottomColor: "#F1F5F9",
    gap: 8,
  },
  resubmitInfoText: {
    fontSize: 12.5,
    color: "#64748B",
  },
  resubmitRequirementText: {
    fontSize: 12.5,
    fontWeight: "700",
    color: "#92400E",
    backgroundColor: "#FEF3C7",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  attachmentPicker: {
    height: 46,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: "#BFDBFE",
    borderRadius: 12,
    backgroundColor: "#F8FAFF",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  attachmentPickerPressed: {
    backgroundColor: "#EFF6FF",
  },
  attachmentPickerText: {
    color: "#1680D8",
    fontSize: 12.5,
    fontWeight: "600",
  },
  attachmentChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    height: 50,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 12,
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 12,
  },
  attachmentName: {
    fontSize: 12.5,
    fontWeight: "600",
    color: "#062B59",
  },
  attachmentSize: {
    fontSize: 11,
    color: "#94A3B8",
    marginTop: 1,
  },
  attachmentRemove: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "#F1F5F9",
    alignItems: "center",
    justifyContent: "center",
  },
  attachmentErrorText: {
    fontSize: 11.5,
    color: "#DC2626",
    fontWeight: "600",
  },
  noteInput: {
    minHeight: 54,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 12,
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 12,
    paddingTop: 8,
    fontSize: 12.5,
    textAlignVertical: "top",
  },
  resubmitButton: {
    height: 42,
    borderRadius: 12,
    backgroundColor: "#062B59",
    justifyContent: "center",
    alignItems: "center",
  },
  resubmitButtonDisabled: {
    opacity: 0.7,
  },
  resubmitButtonPressed: {
    opacity: 0.85,
  },
  resubmitButtonText: {
    color: "#FFFFFF",
    fontWeight: "700",
    fontSize: 13,
  },
  resubmitConfirmation: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  resubmitConfirmationText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#15803D",
  },
});
