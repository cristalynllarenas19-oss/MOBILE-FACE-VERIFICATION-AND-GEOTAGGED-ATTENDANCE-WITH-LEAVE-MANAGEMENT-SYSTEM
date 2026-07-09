import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Modal,
  SafeAreaView,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import ResultModal, { ResultModalStatus } from "../../components/ResultModal";
import EmptyState from "../../components/EmptyState";
import Avatar from "../../components/Avatar";
import StatusPill from "../../components/StatusPill";
import {
  TeamLeaveRequest,
  getTeamLeaveRequests,
  approveLeaveRequest,
  rejectLeaveRequest,
} from "../../api";

type Props = {
  currentEmployeeId?: string;
};

export default function SupervisorLeaveScreen({ currentEmployeeId }: Props) {
  const [requests, setRequests] = useState<TeamLeaveRequest[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [filter, setFilter] = useState<"PENDING" | "ALL">("PENDING");

  const [reviewRequest, setReviewRequest] = useState<TeamLeaveRequest | null>(null);
  const [remarks, setRemarks] = useState("");
  const [requiresAdditionalRequirements, setRequiresAdditionalRequirements] = useState(false);
  const [requirementDetails, setRequirementDetails] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const [resultModal, setResultModal] = useState<{ status: ResultModalStatus; title: string; message: string } | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    isRefresh ? setIsRefreshing(true) : setIsLoading(true);
    try {
      const data = await getTeamLeaveRequests();
      setRequests(data);
    } catch (error) {
      console.error("Failed to load leave requests", error);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const visibleRequests = requests.filter((r) => (filter === "PENDING" ? r.status === "PENDING" : true));

  function openReview(request: TeamLeaveRequest) {
    setReviewRequest(request);
    setRemarks("");
    setRequiresAdditionalRequirements(false);
    setRequirementDetails("");
  }

  const isOwnRequest = reviewRequest?.employee.id === currentEmployeeId;
  // A Supervisor's "Approve" only pre-approves — mirrors LeavePage.tsx's
  // canReviewRequest, which only lets a non-admin act on PENDING requests.
  const canReview = reviewRequest?.status === "PENDING" && !isOwnRequest;

  async function handleReview(action: "approve" | "reject") {
    if (!reviewRequest) return;

    if (action === "reject" && requiresAdditionalRequirements && !requirementDetails.trim()) {
      setResultModal({ status: "info", title: "Details Required", message: "Please describe what's needed from the employee before sending." });
      return;
    }

    setIsSaving(true);
    try {
      if (action === "approve") {
        await approveLeaveRequest(reviewRequest.id, remarks.trim());
      } else {
        await rejectLeaveRequest(reviewRequest.id, {
          remarks: remarks.trim(),
          requiresAdditionalRequirements,
          requirementDetails: requirementDetails.trim(),
        });
      }
      setReviewRequest(null);
      await load();
      setResultModal({
        status: "approved",
        title: action === "approve" ? "Pre-Approved" : requiresAdditionalRequirements ? "Sent Back to Employee" : "Rejected",
        message:
          action === "approve"
            ? "Request moved to Supervisor Approved — HR/Admin will give the final approval."
            : requiresAdditionalRequirements
              ? "The employee has been asked for additional requirements."
              : "Leave request was rejected.",
      });
    } catch (error) {
      setResultModal({ status: "error", title: "Action Failed", message: error instanceof Error ? error.message : "Unable to review leave." });
    } finally {
      setIsSaving(false);
    }
  }

  function closeReview() {
    setReviewRequest(null);
    setRequiresAdditionalRequirements(false);
    setRequirementDetails("");
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.tabSwitcher}>
        <Pressable style={[styles.tabButton, filter === "PENDING" && styles.tabButtonActive]} onPress={() => setFilter("PENDING")}>
          <Text style={[styles.tabButtonText, filter === "PENDING" && styles.tabButtonTextActive]}>Pending</Text>
        </Pressable>
        <Pressable style={[styles.tabButton, filter === "ALL" && styles.tabButtonActive]} onPress={() => setFilter("ALL")}>
          <Text style={[styles.tabButtonText, filter === "ALL" && styles.tabButtonTextActive]}>All</Text>
        </Pressable>
      </View>

      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator color="#062B59" size="large" />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={() => load(true)} tintColor="#062B59" />}
        >
          {visibleRequests.length === 0 ? (
            <EmptyState
              icon="calendar-outline"
              title={filter === "PENDING" ? "No pending requests" : "No leave requests"}
              message={filter === "PENDING" ? "You're all caught up." : "Requests from your team will show up here."}
            />
          ) : (
            visibleRequests.map((request) => (
              <Pressable key={request.id} style={({ pressed }) => [styles.card, pressed && styles.cardPressed]} onPress={() => openReview(request)}>
                <Avatar firstName={request.employee.firstName} lastName={request.employee.lastName} size={38} />
                <View style={{ flex: 1 }}>
                  <View style={styles.cardHeader}>
                    <Text style={styles.employeeName} numberOfLines={1}>
                      {request.employee.firstName} {request.employee.lastName}
                    </Text>
                    <StatusPill status={request.status} />
                  </View>
                  <Text style={styles.leaveType}>{request.leaveType.name}</Text>
                  <Text style={styles.dateRange}>
                    {new Date(request.startDate).toLocaleDateString()} - {new Date(request.endDate).toLocaleDateString()} · {request.totalDays} day
                    {Number(request.totalDays) === 1 ? "" : "s"}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color="#CBD5E1" />
              </Pressable>
            ))
          )}
        </ScrollView>
      )}

      <Modal visible={!!reviewRequest} transparent animationType="fade" onRequestClose={closeReview}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Pressable style={styles.modalCloseButton} onPress={closeReview} hitSlop={10}>
              <Ionicons name="close" size={20} color="#64748B" />
            </Pressable>

            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              {reviewRequest && (
                <>
                  <View style={styles.modalHeaderRow}>
                    <Avatar firstName={reviewRequest.employee.firstName} lastName={reviewRequest.employee.lastName} size={46} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.modalTitle}>
                        {reviewRequest.employee.firstName} {reviewRequest.employee.lastName}
                      </Text>
                      <Text style={styles.modalSubtitle}>{reviewRequest.leaveType.name}</Text>
                    </View>
                  </View>
                  <View style={styles.modalStatusRow}>
                    <StatusPill status={reviewRequest.status} />
                  </View>
                  <Text style={styles.modalMeta}>
                    {new Date(reviewRequest.startDate).toLocaleDateString()} - {new Date(reviewRequest.endDate).toLocaleDateString()}
                  </Text>
                  <Text style={styles.reasonText}>{reviewRequest.reason}</Text>

                  {isOwnRequest && (
                    <Text style={styles.warningText}>This is your own leave request — you cannot approve or reject it.</Text>
                  )}
                  {!isOwnRequest && reviewRequest.status !== "PENDING" && (
                    <Text style={styles.warningText}>This request has already been reviewed.</Text>
                  )}

                  {canReview && (
                    <>
                      <Text style={styles.label}>Remarks</Text>
                      <TextInput
                        style={styles.textArea}
                        multiline
                        placeholder="Optional remarks"
                        value={remarks}
                        onChangeText={setRemarks}
                        editable={!requiresAdditionalRequirements}
                      />

                      <Pressable
                        style={styles.checkboxRow}
                        onPress={() => setRequiresAdditionalRequirements((v) => !v)}
                      >
                        <Ionicons
                          name={requiresAdditionalRequirements ? "checkbox" : "square-outline"}
                          size={20}
                          color="#062B59"
                        />
                        <Text style={styles.checkboxLabel}>Return for additional requirements (on reject)</Text>
                      </Pressable>

                      {requiresAdditionalRequirements && (
                        <TextInput
                          style={styles.textArea}
                          multiline
                          placeholder="What's needed from the employee?"
                          value={requirementDetails}
                          onChangeText={setRequirementDetails}
                          autoFocus
                        />
                      )}

                      {requiresAdditionalRequirements ? (
                        <View style={styles.modalActions}>
                          <Pressable
                            style={[styles.cancelButton, isSaving && styles.buttonDisabled]}
                            onPress={() => {
                              setRequiresAdditionalRequirements(false);
                              setRequirementDetails("");
                            }}
                            disabled={isSaving}
                          >
                            <Text style={styles.cancelText}>Cancel</Text>
                          </Pressable>
                          <Pressable
                            style={[styles.sendButton, isSaving && styles.buttonDisabled]}
                            onPress={() => handleReview("reject")}
                            disabled={isSaving}
                          >
                            {isSaving ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.sendText}>Send</Text>}
                          </Pressable>
                        </View>
                      ) : (
                        <View style={styles.modalActions}>
                          <Pressable
                            style={[styles.rejectButton, isSaving && styles.buttonDisabled]}
                            onPress={() => handleReview("reject")}
                            disabled={isSaving}
                          >
                            <Text style={styles.rejectText}>Reject</Text>
                          </Pressable>
                          <Pressable
                            style={[styles.approveButton, isSaving && styles.buttonDisabled]}
                            onPress={() => handleReview("approve")}
                            disabled={isSaving}
                          >
                            {isSaving ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.approveText}>Approve</Text>}
                          </Pressable>
                        </View>
                      )}
                    </>
                  )}
                </>
              )}
            </ScrollView>
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

const cardShadow = {
  shadowColor: "#0F172A",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.06,
  shadowRadius: 8,
  elevation: 2,
};

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  tabSwitcher: {
    flexDirection: "row",
    backgroundColor: "#F1F5F9",
    borderRadius: 14,
    padding: 4,
    marginBottom: 12,
  },
  tabButton: { flex: 1, paddingVertical: 10, borderRadius: 11, alignItems: "center" },
  tabButtonActive: { backgroundColor: "#062B59" },
  tabButtonText: { fontSize: 14, fontWeight: "700", color: "#64748B" },
  tabButtonTextActive: { color: "#FFFFFF" },
  list: { paddingBottom: 24, gap: 10 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    padding: 14,
    ...cardShadow,
  },
  cardPressed: { opacity: 0.85 },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  employeeName: { fontSize: 14, fontWeight: "700", color: "#062B59", flexShrink: 1 },
  leaveType: { fontSize: 13, color: "#334155", marginTop: 4, fontWeight: "600" },
  dateRange: { fontSize: 12, color: "#64748B", marginTop: 2 },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center", padding: 24 },
  modalCard: { width: "100%", maxWidth: 420, maxHeight: "85%", backgroundColor: "#FFFFFF", borderRadius: 22, padding: 20 },
  modalCloseButton: {
    position: "absolute",
    top: 14,
    right: 14,
    zIndex: 1,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#F1F5F9",
    alignItems: "center",
    justifyContent: "center",
  },
  modalHeaderRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingRight: 34 },
  modalStatusRow: { alignItems: "flex-start", marginTop: 10 },
  modalTitle: { fontSize: 17, fontWeight: "700", color: "#062B59" },
  modalSubtitle: { fontSize: 13, color: "#334155", marginTop: 2, fontWeight: "600" },
  modalMeta: { fontSize: 12, color: "#64748B", marginTop: 12 },
  reasonText: { fontSize: 13, color: "#334155", marginTop: 6, lineHeight: 18 },
  warningText: { fontSize: 12, color: "#B45309", backgroundColor: "#FEF3C7", padding: 10, borderRadius: 10, marginTop: 12 },
  label: { fontWeight: "600", color: "#475569", marginTop: 14, marginBottom: 4 },
  textArea: { minHeight: 70, borderWidth: 1, borderColor: "#E2E8F0", borderRadius: 12, padding: 12, textAlignVertical: "top", marginBottom: 10 },
  checkboxRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4, marginBottom: 10 },
  checkboxLabel: { fontSize: 12, color: "#334155", flex: 1 },
  modalActions: { flexDirection: "row", gap: 10, marginTop: 6 },
  rejectButton: { flex: 1, height: 48, borderRadius: 12, borderWidth: 1, borderColor: "#DC2626", alignItems: "center", justifyContent: "center" },
  rejectText: { color: "#DC2626", fontWeight: "700" },
  approveButton: { flex: 1, height: 48, borderRadius: 12, backgroundColor: "#062B59", alignItems: "center", justifyContent: "center" },
  approveText: { color: "#FFFFFF", fontWeight: "700" },
  cancelButton: { flex: 1, height: 48, borderRadius: 12, borderWidth: 1, borderColor: "#E2E8F0", alignItems: "center", justifyContent: "center" },
  cancelText: { color: "#475569", fontWeight: "700" },
  sendButton: { flex: 1, height: 48, borderRadius: 12, backgroundColor: "#B45309", alignItems: "center", justifyContent: "center" },
  sendText: { color: "#FFFFFF", fontWeight: "700" },
  buttonDisabled: { opacity: 0.7 },
});
