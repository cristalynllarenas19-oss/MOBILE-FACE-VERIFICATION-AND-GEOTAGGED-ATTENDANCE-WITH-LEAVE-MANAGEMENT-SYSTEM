import React, { useCallback, useEffect, useState } from "react";
import {
  AppState,
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Modal,
  SafeAreaView,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import ResultModal, { ResultModalStatus } from "../../components/ResultModal";
import EmptyState from "../../components/EmptyState";
import Avatar from "../../components/Avatar";
import StatusPill from "../../components/StatusPill";
import SegmentedControl from "../../components/SegmentedControl";
import AestheticScrollView from "../../components/AestheticScrollView";
import {
  TeamLeaveRequest,
  getTeamLeaveRequests,
  approveLeaveRequest,
  rejectLeaveRequest,
  approveLeaveCancellation,
  denyLeaveCancellation,
} from "../../api";
import { useCachedData } from "../../utils/dataCache";

// There's no push/WebSocket infra in this app — a newly filed leave request
// only shows up here on the next fetch. Polling this often while the screen
// is mounted (it unmounts when the tab is switched away, since navigation
// swaps tabs via plain state rather than routing) is the pragmatic way to
// make that feel near-instant without adding real-time transport.
const LEAVE_POLL_MS = 3000;

type Props = {
  currentEmployeeId?: string;
};

export default function SupervisorLeaveScreen({ currentEmployeeId }: Props) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [filter, setFilter] = useState<"PENDING" | "ALL">("PENDING");

  const [reviewRequest, setReviewRequest] = useState<TeamLeaveRequest | null>(null);
  const [remarks, setRemarks] = useState("");
  const [reviewMode, setReviewMode] = useState<"reject" | "resubmit">("reject");
  const [requirementDetails, setRequirementDetails] = useState("");

  const [resultModal, setResultModal] = useState<{ status: ResultModalStatus; title: string; message: string } | null>(null);

  const { data, isLoading, refresh, setData } = useCachedData<TeamLeaveRequest[]>(
    "team-leave-requests",
    getTeamLeaveRequests,
  );
  const requests = data ?? [];

  const load = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setIsRefreshing(true);
      try {
        await refresh();
      } catch (error) {
        console.error("Failed to load leave requests", error);
      } finally {
        setIsRefreshing(false);
      }
    },
    [refresh],
  );

  // Keeps newly filed / updated team requests showing up here without the
  // supervisor having to leave and reopen the tab.
  useEffect(() => {
    const interval = setInterval(() => { refresh().catch(() => undefined); }, LEAVE_POLL_MS);
    const appStateSub = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh().catch(() => undefined);
    });
    return () => {
      clearInterval(interval);
      appStateSub.remove();
    };
  }, [refresh]);

  const visibleRequests = requests.filter((r) =>
    filter === "PENDING" ? r.status === "PENDING" || r.status === "CANCELLATION_PENDING" : true,
  );

  function openReview(request: TeamLeaveRequest) {
    setReviewRequest(request);
    setRemarks("");
    setReviewMode("reject");
    setRequirementDetails("");
  }

  const isOwnRequest = reviewRequest?.employee.id === currentEmployeeId;
  // Approval is single-step and final (see leave.controller.ts's /approve) —
  // this only gates *which* requests a Supervisor can act on (PENDING, not
  // already reviewed, and never their own), mirrors LeavePage.tsx's
  // canReviewRequest.
  const canReview = reviewRequest?.status === "PENDING" && !isOwnRequest;
  // An employee's request to cancel their own already-approved leave sits
  // here until a Supervisor/Admin decides on it (mirrors leave.service.ts's
  // approveCancellation/denyCancellation).
  const canDecideCancellation = reviewRequest?.status === "CANCELLATION_PENDING" && !isOwnRequest;
  const isRequestResubmission = reviewMode === "resubmit";

  // Optimistic, same pattern as admin-web's Leave Management page and this
  // app's own LeaveScreen.tsx cancel flow — the outcome is already known
  // (approve-cancellation always finalizes to CANCELLED; deny always reverts
  // to APPROVED, since CANCELLATION_PENDING is only ever entered from an
  // APPROVED request — see leave.service.ts's cancel()), so the modal closes
  // and the result shows immediately instead of the supervisor waiting on
  // the round trip, and only reverts if the background call actually fails.
  function handleCancellationDecision(decision: "approve" | "deny") {
    if (!reviewRequest) return;
    const targetId = reviewRequest.id;
    const newStatus = decision === "approve" ? "CANCELLED" : "APPROVED";
    const remarksTrimmed = remarks.trim();

    setData(requests.map((r) => (r.id === targetId ? { ...r, status: newStatus } : r)));
    setReviewRequest(null);
    setResultModal({
      status: "approved",
      title: decision === "approve" ? "Cancellation Approved" : "Cancellation Denied",
      message:
        decision === "approve"
          ? "The leave request has been cancelled."
          : "The leave remains approved.",
    });

    (decision === "approve" ? approveLeaveCancellation(targetId) : denyLeaveCancellation(targetId, remarksTrimmed))
      .then(() => refresh())
      .catch((error) => {
        refresh().catch(() => undefined);
        setResultModal({ status: "error", title: "Action Failed", message: error instanceof Error ? error.message : "Unable to decide on this cancellation request." });
      });
  }

  function handleReview(action: "approve" | "reject") {
    if (!reviewRequest) return;

    if (action === "reject" && isRequestResubmission && !requirementDetails.trim()) {
      setResultModal({ status: "info", title: "Details Required", message: "Please describe what's needed from the employee before sending." });
      return;
    }

    const targetId = reviewRequest.id;
    // Approval is single-step now (see leave.controller.ts's /approve — a
    // Supervisor's approval is final, same as an Admin's), so this always
    // resolves straight to APPROVED, never a "pending HR" tier.
    const newStatus = action === "approve" ? "APPROVED" : isRequestResubmission ? "NEEDS_REVISION" : "REJECTED";
    const remarksTrimmed = remarks.trim();
    const requirementDetailsTrimmed = requirementDetails.trim();
    const requestedResubmission = isRequestResubmission;

    setData(requests.map((r) => (r.id === targetId ? { ...r, status: newStatus } : r)));
    setReviewRequest(null);
    setResultModal({
      status: "approved",
      title: action === "approve" ? "Approved" : requestedResubmission ? "Sent Back to Employee" : "Rejected",
      message:
        action === "approve"
          ? "This leave request has been approved."
          : requestedResubmission
            ? "The employee has been asked for additional requirements."
            : "Leave request was rejected.",
    });

    (action === "approve"
      ? approveLeaveRequest(targetId, remarksTrimmed)
      : rejectLeaveRequest(targetId, {
          remarks: remarksTrimmed,
          requiresAdditionalRequirements: requestedResubmission,
          requirementDetails: requirementDetailsTrimmed,
        })
    )
      .then(() => refresh())
      .catch((error) => {
        refresh().catch(() => undefined);
        setResultModal({ status: "error", title: "Action Failed", message: error instanceof Error ? error.message : "Unable to review leave." });
      });
  }

  function closeReview() {
    setReviewRequest(null);
    setReviewMode("reject");
    setRequirementDetails("");
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <SegmentedControl
        segments={[
          { key: "PENDING", label: "Pending" },
          { key: "ALL", label: "All" },
        ]}
        value={filter}
        onChange={(key) => setFilter(key as "PENDING" | "ALL")}
        style={styles.tabSwitcher}
      />

      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator color="#062B59" size="large" />
        </View>
      ) : (
        <AestheticScrollView
          contentContainerStyle={styles.list}
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
        </AestheticScrollView>
      )}

      <Modal visible={!!reviewRequest} transparent animationType="fade" onRequestClose={closeReview}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Pressable style={styles.modalCloseButton} onPress={closeReview} hitSlop={10}>
              <Ionicons name="close" size={20} color="#64748B" />
            </Pressable>

            <AestheticScrollView keyboardShouldPersistTaps="handled">
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
                  {!isOwnRequest && reviewRequest.status !== "PENDING" && reviewRequest.status !== "CANCELLATION_PENDING" && (
                    <Text style={styles.warningText}>This request has already been reviewed.</Text>
                  )}

                  {canDecideCancellation && (
                    <View style={styles.modalActions}>
                      <Pressable style={styles.rejectButton} onPress={() => handleCancellationDecision("deny")}>
                        <Text style={styles.rejectText}>Deny Cancellation</Text>
                      </Pressable>
                      <Pressable style={styles.approveButton} onPress={() => handleCancellationDecision("approve")}>
                        <Text style={styles.approveText}>Approve Cancellation</Text>
                      </Pressable>
                    </View>
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
                        editable={!isRequestResubmission}
                      />

                      <Text style={styles.label}>Reject action</Text>
                      <View style={styles.modeRow}>
                        <Pressable
                          style={[styles.modeButton, reviewMode === "reject" && styles.modeButtonActive]}
                          onPress={() => setReviewMode("reject")}
                        >
                          <Text style={[styles.modeButtonText, reviewMode === "reject" && styles.modeButtonTextActive]}>
                            Reject Completely
                          </Text>
                        </Pressable>
                        <Pressable
                          style={[styles.modeButton, reviewMode === "resubmit" && styles.modeButtonActive]}
                          onPress={() => setReviewMode("resubmit")}
                        >
                          <Text style={[styles.modeButtonText, reviewMode === "resubmit" && styles.modeButtonTextActive]}>
                            Request Resubmission
                          </Text>
                        </Pressable>
                      </View>

                      {isRequestResubmission && (
                        <TextInput
                          style={styles.textArea}
                          multiline
                          placeholder="What's needed from the employee?"
                          value={requirementDetails}
                          onChangeText={setRequirementDetails}
                          autoFocus
                        />
                      )}

                      {isRequestResubmission ? (
                        <View style={styles.modalActions}>
                          <Pressable
                            style={styles.cancelButton}
                            onPress={() => {
                              setReviewMode("reject");
                              setRequirementDetails("");
                            }}
                          >
                            <Text style={styles.cancelText}>Cancel</Text>
                          </Pressable>
                          <Pressable style={styles.sendButton} onPress={() => handleReview("reject")}>
                            <Text style={styles.sendText}>Send Back</Text>
                          </Pressable>
                        </View>
                      ) : (
                        <View style={styles.modalActions}>
                          <Pressable style={styles.rejectButton} onPress={() => handleReview("reject")}>
                            <Text style={styles.rejectText}>Reject</Text>
                          </Pressable>
                          <Pressable style={styles.approveButton} onPress={() => handleReview("approve")}>
                            <Text style={styles.approveText}>Approve</Text>
                          </Pressable>
                        </View>
                      )}
                    </>
                  )}
                </>
              )}
            </AestheticScrollView>
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
    marginBottom: 12,
  },
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
  modeRow: { flexDirection: "row", gap: 10, marginTop: 4, marginBottom: 10 },
  modeButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  modeButtonActive: {
    borderColor: "#062B59",
    backgroundColor: "#EFF6FF",
  },
  modeButtonText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#475569",
    textAlign: "center",
  },
  modeButtonTextActive: {
    color: "#062B59",
  },
  modalActions: { flexDirection: "row", gap: 10, marginTop: 6 },
  rejectButton: { flex: 1, height: 48, borderRadius: 12, borderWidth: 1, borderColor: "#DC2626", alignItems: "center", justifyContent: "center" },
  rejectText: { color: "#DC2626", fontWeight: "700" },
  approveButton: { flex: 1, height: 48, borderRadius: 12, backgroundColor: "#062B59", alignItems: "center", justifyContent: "center" },
  approveText: { color: "#FFFFFF", fontWeight: "700" },
  cancelButton: { flex: 1, height: 48, borderRadius: 12, borderWidth: 1, borderColor: "#E2E8F0", alignItems: "center", justifyContent: "center" },
  cancelText: { color: "#475569", fontWeight: "700" },
  sendButton: { flex: 1, height: 48, borderRadius: 12, backgroundColor: "#B45309", alignItems: "center", justifyContent: "center" },
  sendText: { color: "#FFFFFF", fontWeight: "700" },
});
