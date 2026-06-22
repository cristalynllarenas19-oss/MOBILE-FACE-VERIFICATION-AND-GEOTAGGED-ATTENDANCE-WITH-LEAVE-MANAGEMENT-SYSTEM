import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Modal,
  SafeAreaView,
  Dimensions,
  ActivityIndicator,
  ScrollView,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import DateTimePickerModal from "react-native-modal-datetime-picker";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import ResultModal, { ResultModalStatus } from "../components/ResultModal";
import {
  LeaveType,
  LeaveBalance,
  LeaveRequest,
  getLeaveTypes,
  getLeaveBalances,
  getLeaveRequests,
  createLeaveRequest,
} from "../api";

const { height: SCREEN_HEIGHT } = Dimensions.get("window");
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

type PickedAttachment = {
  name: string;
  mimeType: string;
  sizeBytes: number;
  base64: string;
};

type Props = {
  employeeId?: string;
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statusTone(status: string) {
  if (status === "APPROVED" || status === "SUPERVISOR_APPROVED") return { color: "#15803D", bg: "#DCFCE7" };
  if (status === "REJECTED" || status === "CANCELLED") return { color: "#B91C1C", bg: "#FEE2E2" };
  return { color: "#B45309", bg: "#FEF3C7" };
}

export default function LeaveScreen({ employeeId }: Props) {
  const [leaveTypes, setLeaveTypes] = useState<LeaveType[]>([]);
  const [balances, setBalances] = useState<LeaveBalance[]>([]);
  const [requests, setRequests] = useState<LeaveRequest[]>([]);
  const [isLoadingData, setIsLoadingData] = useState(true);

  const [leaveTypeId, setLeaveTypeId] = useState("");
  const [searchLeave, setSearchLeave] = useState("");
  const [reason, setReason] = useState("");

  const [startDate, setStartDate] = useState(new Date());
  const [endDate, setEndDate] = useState(new Date());
  const [startDateSelected, setStartDateSelected] = useState(false);
  const [endDateSelected, setEndDateSelected] = useState(false);

  const [isStartPickerVisible, setStartPickerVisibility] = useState(false);
  const [isEndPickerVisible, setEndPickerVisibility] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  const [attachment, setAttachment] = useState<PickedAttachment | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isPickingFile, setIsPickingFile] = useState(false);

  const [showBalance, setShowBalance] = useState(false);
  const [showPending, setShowPending] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [resultModal, setResultModal] = useState<{ status: ResultModalStatus; title: string; message: string } | null>(null);

  const selectedLeaveType = leaveTypes.find((t) => t.id === leaveTypeId);
  const filteredLeaveTypes = leaveTypes.filter((item) =>
    item.name.toLowerCase().includes(searchLeave.toLowerCase())
  );

  const pendingRequests = useMemo(() => requests.filter((r) => r.status === "PENDING"), [requests]);
  const totalRemainingDays = useMemo(
    () => balances.reduce((sum, balance) => sum + balance.remainingDays, 0),
    [balances]
  );

  useEffect(() => {
    loadData();
  }, [employeeId]);

  async function loadData() {
    setIsLoadingData(true);
    try {
      const types = await getLeaveTypes();
      setLeaveTypes(types);

      if (employeeId) {
        const [balanceData, requestData] = await Promise.all([
          getLeaveBalances(employeeId),
          getLeaveRequests(employeeId),
        ]);
        setBalances(balanceData);
        setRequests(requestData);
      }
    } catch (error) {
      console.error("Failed to load leave data", error);
    } finally {
      setIsLoadingData(false);
    }
  }

  const handleStartDateConfirm = (selectedDate = new Date()) => {
    setStartPickerVisibility(false);
    setStartDate(selectedDate);
    setStartDateSelected(true);
    if (endDateSelected && selectedDate > endDate) {
      setEndDate(selectedDate);
    }
  };

  const handleEndDateConfirm = (selectedDate = new Date()) => {
    setEndPickerVisibility(false);
    setEndDate(selectedDate);
    setEndDateSelected(true);
  };

  const formatDate = (displayDate = new Date()) => {
    return `${displayDate.getMonth() + 1}/${displayDate.getDate()}/${displayDate.getFullYear()}`;
  };

  const totalDays = useMemo(() => {
    if (!startDateSelected || !endDateSelected) return 0;
    const diff = Math.round((endDate.getTime() - startDate.getTime()) / 86400000) + 1;
    return Math.max(1, diff);
  }, [startDate, endDate, startDateSelected, endDateSelected]);

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

  function resetForm() {
    setLeaveTypeId("");
    setReason("");
    setStartDateSelected(false);
    setEndDateSelected(false);
    setStartDate(new Date());
    setEndDate(new Date());
    setAttachment(null);
    setAttachmentError(null);
  }

  async function handleSubmit() {
    if (!employeeId) {
      setResultModal({ status: "error", title: "Missing Employee Profile", message: "This account isn't linked to an employee record." });
      return;
    }
    if (!leaveTypeId) {
      setResultModal({ status: "info", title: "Select Leave Type", message: "Please choose a leave type before submitting." });
      return;
    }
    if (!startDateSelected || !endDateSelected) {
      setResultModal({ status: "info", title: "Select Dates", message: "Please choose both a start and end date." });
      return;
    }
    if (!reason.trim()) {
      setResultModal({ status: "info", title: "Reason Required", message: "Please tell us the reason for your leave." });
      return;
    }
    if (selectedLeaveType?.requiresDocument && !attachment) {
      setResultModal({
        status: "info",
        title: "Document Required",
        message: `${selectedLeaveType.name} requires a supporting document. Please attach one before submitting.`,
      });
      return;
    }

    setIsSubmitting(true);
    try {
      await createLeaveRequest({
        employeeId,
        leaveTypeId,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        totalDays,
        reason: reason.trim(),
        attachmentName: attachment?.name,
        attachmentMimeType: attachment?.mimeType,
        attachmentData: attachment?.base64,
      });

      resetForm();
      await loadData();
      setResultModal({
        status: "approved",
        title: "Leave Request Submitted",
        message: "Your HR/Admin and supervisor have been notified. You'll be notified once it's reviewed.",
      });
    } catch (error) {
      setResultModal({
        status: "error",
        title: "Submission Failed",
        message: error instanceof Error ? error.message : "Failed to submit leave request.",
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.mainContainer} keyboardShouldPersistTaps="handled">

        <View style={styles.summaryRow}>
          <Pressable style={styles.summaryCard} onPress={() => setShowBalance(true)}>
            <Ionicons name="wallet-outline" size={20} color="#1680D8" />
            <Text style={styles.summaryLabel}>Leave Balance</Text>
            <Text style={styles.summaryValue}>{isLoadingData ? "…" : totalRemainingDays}</Text>
            <Text style={styles.tapText}>Tap to view</Text>
          </Pressable>

          <Pressable style={styles.summaryCard} onPress={() => setShowPending(true)}>
            <Ionicons name="time-outline" size={20} color="#F59E0B" />
            <Text style={styles.summaryLabel}>Pending Leave</Text>
            <Text style={styles.summaryValue}>{isLoadingData ? "…" : pendingRequests.length}</Text>
            <Text style={styles.tapText}>Tap to view</Text>
          </Pressable>
        </View>

        <View style={styles.card}>
          <View style={styles.formHeader}>
            <Ionicons color="#DC2777" name="document-text-outline" size={32} />
            <Text style={styles.cardTitle}>Leave Request</Text>
          </View>

          <Text style={styles.label}>Leave Type</Text>
          <View style={styles.dropdownWrapper}>
            <Pressable
              style={[styles.dropdownButton, isDropdownOpen && { borderColor: "#062B59" }]}
              onPress={() => {
                setIsDropdownOpen(!isDropdownOpen);
                setSearchLeave("");
              }}
            >
              <Text style={[styles.dropdownText, !leaveTypeId && { color: "#94A3B8" }]}>
                {selectedLeaveType?.name || (isLoadingData ? "Loading leave types…" : "Select Leave Type")}
              </Text>
              <Ionicons name={isDropdownOpen ? "chevron-up" : "chevron-down"} size={20} color="#64748B" />
            </Pressable>

            {isDropdownOpen && (
              <View style={styles.inlineDropdownContainer}>
                <View style={styles.searchBarWrapper}>
                  <Ionicons name="search-outline" size={16} color="#94A3B8" style={styles.searchIcon} />
                  <TextInput
                    placeholder="Search leave type..."
                    value={searchLeave}
                    onChangeText={setSearchLeave}
                    style={styles.inlineSearchInput}
                    autoFocus={true}
                  />
                </View>

                <ScrollView style={{ maxHeight: 160 }}>
                  {filteredLeaveTypes.length > 0 ? (
                    filteredLeaveTypes.map((item) => (
                      <Pressable
                        key={item.id}
                        style={styles.inlineItem}
                        onPress={() => {
                          setLeaveTypeId(item.id);
                          setIsDropdownOpen(false);
                          setSearchLeave("");
                        }}
                      >
                        <Text style={[styles.inlineItemText, leaveTypeId === item.id && styles.selectedItemText]}>
                          {item.name}
                          {item.requiresDocument ? " (document required)" : ""}
                        </Text>
                      </Pressable>
                    ))
                  ) : (
                    <View style={styles.noResultsBox}>
                      <Text style={styles.noResultsText}>No leave types found</Text>
                    </View>
                  )}
                </ScrollView>
              </View>
            )}
          </View>

          <Text style={styles.label}>Leave Duration</Text>
          <View style={styles.dateRow}>
            <Pressable style={styles.dateBox} onPress={() => setStartPickerVisibility(true)}>
              <Text style={[styles.dateText, !startDateSelected && { color: "#94A3B8" }]}>
                {startDateSelected ? formatDate(startDate) : "Start Date"}
              </Text>
              <Ionicons name="calendar-outline" size={20} color="#64748B" />
            </Pressable>

            <Pressable style={styles.dateBox} onPress={() => setEndPickerVisibility(true)}>
              <Text style={[styles.dateText, !endDateSelected && { color: "#94A3B8" }]}>
                {endDateSelected ? formatDate(endDate) : "End Date"}
              </Text>
              <Ionicons name="calendar-outline" size={20} color="#64748B" />
            </Pressable>
          </View>
          {startDateSelected && endDateSelected && (
            <Text style={styles.totalDaysText}>{totalDays} day{totalDays === 1 ? "" : "s"} total</Text>
          )}

          <DateTimePickerModal
            isVisible={isStartPickerVisible}
            mode="date"
            onConfirm={handleStartDateConfirm}
            onCancel={() => setStartPickerVisibility(false)}
          />

          <DateTimePickerModal
            isVisible={isEndPickerVisible}
            mode="date"
            minimumDate={startDateSelected ? startDate : undefined}
            onConfirm={handleEndDateConfirm}
            onCancel={() => setEndPickerVisibility(false)}
          />

          <Text style={styles.label}>
            Supporting Document{selectedLeaveType?.requiresDocument ? " (required)" : " (optional)"}
          </Text>
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
            <Pressable style={styles.attachmentPicker} onPress={pickAttachment} disabled={isPickingFile}>
              {isPickingFile ? (
                <ActivityIndicator size="small" color="#1680D8" />
              ) : (
                <Ionicons name="attach-outline" size={20} color="#1680D8" />
              )}
              <Text style={styles.attachmentPickerText}>
                {isPickingFile ? "Opening…" : "Tap to attach a photo or PDF"}
              </Text>
            </Pressable>
          )}
          {attachmentError && <Text style={styles.attachmentErrorText}>{attachmentError}</Text>}

          <Text style={styles.label}>Reason</Text>
          <View style={styles.textAreaContainer}>
            <TextInput
              placeholder="Enter reason"
              multiline
              value={reason}
              onChangeText={setReason}
              style={styles.textAreaInput}
            />
          </View>

          <Pressable style={[styles.button, isSubmitting && styles.buttonDisabled]} onPress={handleSubmit} disabled={isSubmitting}>
            {isSubmitting ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.buttonText}>Submit Leave Request</Text>
            )}
          </Pressable>
        </View>
      </ScrollView>

      <Modal visible={showBalance} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Leave Balance ({new Date().getFullYear()})</Text>
            {balances.length === 0 ? (
              <Text style={styles.modalEmptyText}>No balance data yet.</Text>
            ) : (
              balances.map((balance) => (
                <View key={balance.leaveTypeId} style={styles.balanceRow}>
                  <Text>{balance.leaveTypeName}</Text>
                  <Text style={{ fontWeight: "700", color: "#062B59" }}>
                    {balance.remainingDays} / {balance.earnedDays} days
                  </Text>
                </View>
              ))
            )}
            <Pressable style={styles.closeButton} onPress={() => setShowBalance(false)}>
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={showPending} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Pending Leave Requests</Text>
            <ScrollView style={{ maxHeight: 320 }}>
              {pendingRequests.length === 0 ? (
                <Text style={styles.modalEmptyText}>No pending leave requests.</Text>
              ) : (
                pendingRequests.map((request) => {
                  const tone = statusTone(request.status);
                  return (
                    <View key={request.id} style={styles.requestCard}>
                      <Text style={styles.requestTitle}>{request.leaveType.name}</Text>
                      <Text>
                        {new Date(request.startDate).toLocaleDateString()} - {new Date(request.endDate).toLocaleDateString()}
                      </Text>
                      {request.attachmentName && (
                        <View style={styles.requestAttachmentRow}>
                          <Ionicons name="attach-outline" size={13} color="#64748B" />
                          <Text style={styles.requestAttachmentText}>{request.attachmentName}</Text>
                        </View>
                      )}
                      <Text style={[styles.pendingText, { color: tone.color, backgroundColor: tone.bg }]}>
                        {request.status.replace("_", " ")}
                      </Text>
                    </View>
                  );
                })
              )}
            </ScrollView>
            <Pressable style={styles.closeButton} onPress={() => setShowPending(false)}>
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <ResultModal
        visible={!!resultModal}
        status={resultModal?.status ?? "info"}
        title={resultModal?.title ?? ""}
        message={resultModal?.message ?? ""}
        onClose={() => setResultModal(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#FFFFFF"
  },
  mainContainer: {
    flexGrow: 1,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: SCREEN_HEIGHT < 700 ? 16 : 24,
  },
  summaryRow: {
    flexDirection: "row",
    gap: 12,
    marginBottom: SCREEN_HEIGHT < 700 ? 10 : 16,
  },
  summaryCard: {
    flex: 1,
    backgroundColor: "#FFFFFF",
    borderRadius: 18,
    paddingVertical: SCREEN_HEIGHT < 700 ? 8 : 12,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    alignItems: "center"
  },
  summaryLabel: {
    color: "#64748B",
    fontSize: 12,
    marginTop: 4,
  },
  summaryValue: {
    fontSize: 20,
    fontWeight: "700",
    color: "#062B59",
    marginTop: 2,
  },
  tapText: {
    marginTop: 2,
    color: "#1680D8",
    fontSize: 11,
    fontWeight: "600"
  },
  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 18,
    paddingHorizontal: 20,
    paddingTop: SCREEN_HEIGHT < 700 ? 14 : 20,
    paddingBottom: SCREEN_HEIGHT < 700 ? 16 : 24,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    zIndex: 1,
  },
  formHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  cardTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#062B59",
  },
  label: {
    fontWeight: "600",
    color: "#475569",
    marginTop: SCREEN_HEIGHT < 700 ? 6 : 12,
    marginBottom: SCREEN_HEIGHT < 700 ? 2 : 4,
  },

  dropdownWrapper: {
    position: "relative",
    zIndex: 10,
  },
  dropdownButton: {
    height: SCREEN_HEIGHT < 700 ? 44 : 50,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 12,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#FFFFFF",
  },
  dropdownText: {
    fontSize: 14
  },
  inlineDropdownContainer: {
    position: "absolute",
    top: SCREEN_HEIGHT < 700 ? 46 : 52,
    left: 0,
    right: 0,
    backgroundColor: "#FFFFFF",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    maxHeight: 200,
    zIndex: 50,
    elevation: 5,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.15,
    shadowRadius: 5,
    overflow: "hidden",
  },
  searchBarWrapper: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: "#E2E8F0",
    paddingHorizontal: 10,
    backgroundColor: "#F8FAFC",
    borderTopLeftRadius: 11,
    borderTopRightRadius: 11,
  },
  searchIcon: {
    marginRight: 6,
  },
  inlineSearchInput: {
    flex: 1,
    height: 40,
    fontSize: 14,
    color: "#000000",
  },
  inlineItem: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#F1F5F9",
  },
  inlineItemText: {
    fontSize: 14,
    color: "#334155",
  },
  selectedItemText: {
    color: "#062B59",
    fontWeight: "700",
  },
  noResultsBox: {
    padding: 16,
    alignItems: "center",
  },
  noResultsText: {
    color: "#94A3B8",
    fontSize: 14,
  },

  dateRow: { flexDirection: "row", gap: 10 },
  dateBox: { flex: 1, height: SCREEN_HEIGHT < 700 ? 44 : 50, borderWidth: 1, borderColor: "#E2E8F0", borderRadius: 12, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: "#FFFFFF" },
  dateText: { fontSize: 14 },
  totalDaysText: {
    marginTop: 6,
    fontSize: 12,
    fontWeight: "600",
    color: "#1680D8",
  },

  attachmentPicker: {
    height: 50,
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
  attachmentPickerText: {
    color: "#1680D8",
    fontSize: 13,
    fontWeight: "600",
  },
  attachmentChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    height: 54,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 12,
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 12,
  },
  attachmentName: {
    fontSize: 13,
    fontWeight: "600",
    color: "#062B59",
  },
  attachmentSize: {
    fontSize: 11,
    color: "#94A3B8",
    marginTop: 1,
  },
  attachmentRemove: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: "#F1F5F9",
    alignItems: "center",
    justifyContent: "center",
  },
  attachmentErrorText: {
    marginTop: 6,
    fontSize: 12,
    color: "#DC2626",
    fontWeight: "600",
  },

  textAreaContainer: {
    height: SCREEN_HEIGHT < 700 ? 80 : 110,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 12,
    backgroundColor: "#FFFFFF",
    overflow: "hidden",
    marginVertical: SCREEN_HEIGHT < 700 ? 4 : 6,
  },
  textAreaInput: {
    flex: 1,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
    textAlignVertical: "top",
  },
  button: {
    height: SCREEN_HEIGHT < 700 ? 46 : 52,
    borderRadius: 14,
    backgroundColor: "#062B59",
    justifyContent: "center",
    alignItems: "center",
    marginTop: SCREEN_HEIGHT < 700 ? 10 : 16,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: {
    color: "#FFFFFF",
    fontWeight: "700"
  },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "center", alignItems: "center" },
  modalCard: { width: "88%", maxHeight: "80%", backgroundColor: "#FFFFFF", borderRadius: 18, padding: 20 },
  modalTitle: { fontSize: 18, fontWeight: "700", marginBottom: 16, color: "#062B59" },
  modalEmptyText: { color: "#94A3B8", fontSize: 13, textAlign: "center", paddingVertical: 12 },
  balanceRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 12 },
  requestCard: { backgroundColor: "#F8FAFC", borderRadius: 12, padding: 14, marginBottom: 12 },
  requestTitle: { fontWeight: "700", marginBottom: 4 },
  requestAttachmentRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  requestAttachmentText: { fontSize: 12, color: "#64748B" },
  pendingText: { fontWeight: "700", marginTop: 8, alignSelf: "flex-start", fontSize: 11, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, overflow: "hidden" },
  closeButton: { backgroundColor: "#062B59", borderRadius: 12, padding: 12, marginTop: 12 },
  closeText: { color: "#FFFFFF", textAlign: "center", fontWeight: "700" },
});
