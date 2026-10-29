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
import LeaveTimeline from "../../components/LeaveTimeline";
import AestheticScrollView from "../../components/AestheticScrollView";
import { ZoomableImage } from "../../components/ZoomableImage";
import { WebView } from "react-native-webview";
import {
  TeamLeaveRequest,
  TeamUndertimeFiling,
  getTeamLeaveRequests,
  approveLeaveRequest,
  rejectLeaveRequest,
  approveLeaveCancellation,
  denyLeaveCancellation,
  getTeamUndertimeFilings,
  approveUndertimeFiling,
  rejectUndertimeFiling,
  filedMinutes,
} from "../../api";
import { useCachedData } from "../../utils/dataCache";
import { CARD_SHADOW } from "../../styles/ui";

// There's no push/WebSocket infra in this app — a newly filed leave request
// only shows up here on the next fetch. Polling this often while the screen
// is mounted (it unmounts when the tab is switched away, since navigation
// swaps tabs via plain state rather than routing) is the pragmatic way to
// make that feel near-instant without adding real-time transport.
const LEAVE_POLL_MS = 3000;

// A 30-day Maternity Leave extension is filed under the Maternity Leave type
// itself (see requestExtension in leave.service.ts) and reviewed like any
// other request — titled so the reviewer knows what they're approving.
function leaveRequestTitle(request: { extensionOfId?: string | null; leaveType: { name: string } }) {
  return request.extensionOfId ? `${request.leaveType.name} Extension (30 days, without pay)` : request.leaveType.name;
}

function lateMinutesLabel(minutes: number) {
  return `${minutes} minute${minutes === 1 ? "" : "s"} undertime`;
}

type Props = {
  currentEmployeeId?: string;
  // Set when arriving here from a leave notification's "View Leave Request"
  // button — opens straight into that request's review modal once it's in
  // the (already-cached) team list. onFocusRequestHandled clears it on the
  // parent's side once consumed.
  initialFocusRequestId?: string | null;
  onFocusRequestHandled?: () => void;
};

export default function SupervisorLeaveScreen({ currentEmployeeId, initialFocusRequestId, onFocusRequestHandled }: Props) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [selectedFilter, setFilter] = useState<"PENDING" | "LAPSED" | "ALL">("PENDING");
  const [requestType, setRequestType] = useState<"leave" | "undertime">("leave");
  // Undertime filings never lapse, so on that tab a leftover "Lapsed"
  // selection falls back to showing everything.
  const filter = requestType === "undertime" && selectedFilter === "LAPSED" ? "ALL" : selectedFilter;

  const [reviewRequest, setReviewRequest] = useState<TeamLeaveRequest | null>(null);
  // A document opened from the review timeline (e.g. one sent with a
  // cancellation request).
  const [viewingDocument, setViewingDocument] = useState<{ mimeType: string; dataUri: string } | null>(null);
  const [remarks, setRemarks] = useState("");
  const [reviewMode, setReviewMode] = useState<"reject" | "resubmit">("reject");
  const [requirementDetails, setRequirementDetails] = useState("");

  const [reviewUndertime, setReviewUndertime] = useState<TeamUndertimeFiling | null>(null);
  const [undertimeRemarks, setUndertimeRemarks] = useState("");

  const [resultModal, setResultModal] = useState<{ status: ResultModalStatus; title: string; message: string } | null>(null);

  const { data, isLoading, refresh, setData } = useCachedData<TeamLeaveRequest[]>(
    "team-leave-requests",
    getTeamLeaveRequests,
  );
  const requests = data ?? [];

  const {
    data: undertimeData,
    isLoading: isUndertimeLoading,
    refresh: refreshUndertime,
    setData: setUndertimeData,
  } = useCachedData<TeamUndertimeFiling[]>("team-undertime-filings", getTeamUndertimeFilings);
  const undertimeFilings = undertimeData ?? [];

  const load = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setIsRefreshing(true);
      try {
        await Promise.all([refresh(), refreshUndertime()]);
      } catch (error) {
        console.error("Failed to load leave requests", error);
      } finally {
        setIsRefreshing(false);
      }
    },
    [refresh, refreshUndertime],
  );

  // Keeps newly filed / updated team requests showing up here without the
  // supervisor having to leave and reopen the tab. Both lists are polled
  // together regardless of which segment is active, so switching segments
  // never shows stale data.
  useEffect(() => {
    const interval = setInterval(() => {
      refresh().catch(() => undefined);
      refreshUndertime().catch(() => undefined);
    }, LEAVE_POLL_MS);
    const appStateSub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        refresh().catch(() => undefined);
        refreshUndertime().catch(() => undefined);
      }
    });
    return () => {
      clearInterval(interval);
      appStateSub.remove();
    };
  }, [refresh, refreshUndertime]);

  const visibleRequests = requests.filter((r) =>
    filter === "PENDING"
      ? r.status === "PENDING" || r.status === "CANCELLATION_PENDING"
      : filter === "LAPSED"
        ? r.status === "LAPSED"
        : true,
  );
  const visibleUndertimeFilings = undertimeFilings.filter((f) => (filter === "PENDING" ? f.status === "PENDING" : true));

  function openReview(request: TeamLeaveRequest) {
    setReviewRequest(request);
    setRemarks("");
    setReviewMode("reject");
    setRequirementDetails("");
  }

  // Arriving here from a leave notification's "View Leave Request" button —
  // waits for the request to actually be in the (already-cached) team list
  // before opening its review modal.
  useEffect(() => {
    if (!initialFocusRequestId) return;
    const match = requests.find((r) => r.id === initialFocusRequestId);
    if (!match) return;
    openReview(match);
    onFocusRequestHandled?.();
  }, [initialFocusRequestId, requests]);

  function openUndertimeReview(filing: TeamUndertimeFiling) {
    setReviewUndertime(filing);
    setUndertimeRemarks("");
  }

  function closeUndertimeReview() {
    setReviewUndertime(null);
    setUndertimeRemarks("");
  }

  const isOwnUndertime = reviewUndertime?.employee.id === currentEmployeeId;
  // Same self-review rule as leave requests — a Supervisor's own filing must
  // sit PENDING until HR/Admin reviews it directly (enforced server-side too,
  // see undertime.service.ts's updateStatus).
  const canReviewUndertime = reviewUndertime?.status === "PENDING" && !isOwnUndertime;

  function handleUndertimeReview(action: "approve" | "reject") {
    if (!reviewUndertime) return;
    const remarksTrimmed = undertimeRemarks.trim();
    if (action === "reject" && !remarksTrimmed) {
      setResultModal({ status: "info", title: "Remarks Required", message: "Please provide remarks explaining why this undertime filing is being rejected." });
      return;
    }
    const targetId = reviewUndertime.id;
    const newStatus = action === "approve" ? "APPROVED" : "REJECTED";

    setUndertimeData(undertimeFilings.map((f) => (f.id === targetId ? { ...f, status: newStatus } : f)));
    setReviewUndertime(null);
    setResultModal({
      status: "approved",
      title: action === "approve" ? "Approved" : "Rejected",
      message: action === "approve" ? "This undertime filing has been approved." : "Undertime filing was rejected.",
    });

    (action === "approve" ? approveUndertimeFiling(targetId, remarksTrimmed) : rejectUndertimeFiling(targetId, remarksTrimmed))
      .then(() => refreshUndertime())
      .catch((error) => {
        refreshUndertime().catch(() => undefined);
        setResultModal({ status: "error", title: "Action Failed", message: error instanceof Error ? error.message : "Unable to review undertime filing." });
      });
  }

  const isOwnRequest = reviewRequest?.employee.id === currentEmployeeId;
  // Approval is single-step and final (see leave.controller.ts's /approve) —
  // this only gates *which* requests a Supervisor can act on (PENDING, not
  // already reviewed, and never their own), mirrors LeavePage.tsx's
  // canReviewRequest.
  const canReview = reviewRequest?.status === "PENDING" && !isOwnRequest;
  // A request that lapsed only because nobody decided it in time ("Lapsed -
  // Absent") can still be approved late, turning those absent days into
  // leave. One that lapsed because the employee reported for work can't —
  // mirrors admin-web's canApproveLapsed and the backend's own guard.
  const canApproveLapsed =
    reviewRequest?.status === "LAPSED" && reviewRequest.lapseReason !== "REPORTED_FOR_WORK" && !isOwnRequest;
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
    const remarksTrimmed = remarks.trim();
    if (decision === "deny" && !remarksTrimmed) {
      setResultModal({ status: "info", title: "Remarks Required", message: "Please provide remarks explaining why this cancellation is being denied." });
      return;
    }
    const targetId = reviewRequest.id;
    const newStatus = decision === "approve" ? "CANCELLED" : "APPROVED";

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

    (decision === "approve" ? approveLeaveCancellation(targetId, remarksTrimmed) : denyLeaveCancellation(targetId, remarksTrimmed))
      .then(() => refresh())
      .catch((error) => {
        refresh().catch(() => undefined);
        setResultModal({ status: "error", title: "Action Failed", message: error instanceof Error ? error.message : "Unable to decide on this cancellation request." });
      });
  }

  function handleReview(action: "approve" | "reject") {
    if (!reviewRequest) return;

    if (action === "reject" && !remarks.trim()) {
      setResultModal({ status: "info", title: "Remarks Required", message: "Please provide remarks explaining why this leave request is being rejected." });
      return;
    }
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
          { key: "leave", label: "Leave" },
          { key: "undertime", label: "Undertime" },
        ]}
        value={requestType}
        onChange={(key) => setRequestType(key as "leave" | "undertime")}
        style={styles.tabSwitcher}
      />
      {/* All first, so the unfiltered list is the one the thumb lands on,
          even though Pending is what this screen opens on. */}
      <SegmentedControl
        segments={[
          { key: "ALL", label: "All" },
          { key: "PENDING", label: "Pending" },
          ...(requestType === "leave" ? [{ key: "LAPSED", label: "Lapsed" }] : []),
        ]}
        value={filter}
        onChange={(key) => setFilter(key as "PENDING" | "LAPSED" | "ALL")}
        style={styles.tabSwitcher}
      />

      {requestType === "leave" ? (
        isLoading ? (
          <View style={styles.centered}>
            <ActivityIndicator color="#062B59" size="large" />
          </View>
        ) : (
          <AestheticScrollView
            style={styles.scroller}
            contentContainerStyle={styles.list}
            refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={() => load(true)} colors={["#1680D8"]} />}
          >
            {visibleRequests.length === 0 ? (
              <EmptyState
                icon="calendar-outline"
                title={filter === "PENDING" ? "No pending requests" : filter === "LAPSED" ? "No lapsed requests" : "No leave requests"}
                message={
                  filter === "PENDING"
                    ? "You're all caught up."
                    : filter === "LAPSED"
                      ? "Requests that were never decided before their leave dates passed will show up here."
                      : "Requests from your team will show up here."
                }
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
                      <StatusPill status={request.status} lapseReason={request.lapseReason} />
                    </View>
                    <Text style={styles.leaveType}>{leaveRequestTitle(request)}</Text>
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
        )
      ) : isUndertimeLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator color="#062B59" size="large" />
        </View>
      ) : (
        <AestheticScrollView
          style={styles.scroller}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={() => load(true)} colors={["#1680D8"]} />}
        >
          {visibleUndertimeFilings.length === 0 ? (
            <EmptyState
              icon="time-outline"
              title={filter === "PENDING" ? "No pending filings" : "No undertime filings"}
              message={filter === "PENDING" ? "You're all caught up." : "Undertime filings from your team will show up here."}
            />
          ) : (
            visibleUndertimeFilings.map((filing) => (
              <Pressable key={filing.id} style={({ pressed }) => [styles.card, pressed && styles.cardPressed]} onPress={() => openUndertimeReview(filing)}>
                <Avatar firstName={filing.employee.firstName} lastName={filing.employee.lastName} size={38} />
                <View style={{ flex: 1 }}>
                  <View style={styles.cardHeader}>
                    <Text style={styles.employeeName} numberOfLines={1}>
                      {filing.employee.firstName} {filing.employee.lastName}
                    </Text>
                    <StatusPill status={filing.status} />
                  </View>
                  <Text style={styles.dateRange}>
                    {filing.attendanceRecord
                      ? `${new Date(filing.attendanceRecord.attendanceDate).toLocaleDateString()} · ${lateMinutesLabel(filedMinutes(filing.attendanceRecord))}`
                      : new Date(filing.filingDate).toLocaleDateString()}
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
                      <Text style={styles.modalSubtitle}>{leaveRequestTitle(reviewRequest)}</Text>
                    </View>
                  </View>
                  <View style={styles.modalStatusRow}>
                    <StatusPill status={reviewRequest.status} lapseReason={reviewRequest.lapseReason} />
                  </View>
                  <Text style={styles.modalMeta}>
                    {new Date(reviewRequest.startDate).toLocaleDateString()} - {new Date(reviewRequest.endDate).toLocaleDateString()}
                  </Text>
                  <Text style={styles.reasonText}>{reviewRequest.reason}</Text>

                  <LeaveTimeline
                    history={reviewRequest.history}
                    status={reviewRequest.status}
                    documents={(reviewRequest.notes ?? [])
                      .filter((note) => note.type === "CANCELLED" && note.attachmentData && note.attachmentMimeType)
                      .map((note) => ({
                        label: "Cancellation Document",
                        createdAt: note.createdAt,
                        kind: "cancellation" as const,
                        onPress: () =>
                          setViewingDocument({
                            mimeType: note.attachmentMimeType!,
                            dataUri: `data:${note.attachmentMimeType};base64,${note.attachmentData}`,
                          }),
                      }))}
                  />

                  {isOwnRequest && (
                    <Text style={styles.warningText}>This is your own leave request — you cannot approve or reject it.</Text>
                  )}
                  {!isOwnRequest && reviewRequest.status === "LAPSED" && (
                    <Text style={styles.warningText}>
                      {canApproveLapsed
                        ? "This request lapsed without a decision. You can still approve it to turn the absent days into leave."
                        : "This request lapsed because the employee reported for work on the leave dates. It can no longer be approved."}
                    </Text>
                  )}
                  {!isOwnRequest &&
                    reviewRequest.status !== "PENDING" &&
                    reviewRequest.status !== "CANCELLATION_PENDING" &&
                    reviewRequest.status !== "LAPSED" && (
                      <Text style={styles.warningText}>This request has already been reviewed.</Text>
                    )}

                  {canDecideCancellation && (
                    <>
                      <Text style={styles.label}>Remarks</Text>
                      <TextInput
                        style={styles.textArea}
                        multiline
                        placeholder="Required when denying — optional when approving"
                        value={remarks}
                        onChangeText={setRemarks}
                      />
                    </>
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
                        placeholder="Required when rejecting — optional when approving"
                        value={remarks}
                        onChangeText={setRemarks}
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

                  {canApproveLapsed && (
                    <View style={styles.modalActions}>
                      <Pressable style={styles.approveButton} onPress={() => handleReview("approve")}>
                        <Text style={styles.approveText}>Approve Leave</Text>
                      </Pressable>
                    </View>
                  )}
                </>
              )}
            </AestheticScrollView>
          </View>
        </View>
      </Modal>

      <Modal visible={!!reviewUndertime} transparent animationType="fade" onRequestClose={closeUndertimeReview}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Pressable style={styles.modalCloseButton} onPress={closeUndertimeReview} hitSlop={10}>
              <Ionicons name="close" size={20} color="#64748B" />
            </Pressable>

            <AestheticScrollView keyboardShouldPersistTaps="handled">
              {reviewUndertime && (
                <>
                  <View style={styles.modalHeaderRow}>
                    <Avatar firstName={reviewUndertime.employee.firstName} lastName={reviewUndertime.employee.lastName} size={46} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.modalTitle}>
                        {reviewUndertime.employee.firstName} {reviewUndertime.employee.lastName}
                      </Text>
                      <Text style={styles.modalSubtitle}>Undertime Filing</Text>
                    </View>
                  </View>
                  <View style={styles.modalStatusRow}>
                    <StatusPill status={reviewUndertime.status} />
                  </View>
                  {reviewUndertime.attendanceRecord && (
                    <Text style={styles.modalMeta}>
                      {new Date(reviewUndertime.attendanceRecord.attendanceDate).toLocaleDateString()} · {lateMinutesLabel(filedMinutes(reviewUndertime.attendanceRecord))}
                    </Text>
                  )}
                  {reviewUndertime.reason && <Text style={styles.reasonText}>{reviewUndertime.reason}</Text>}
                  {reviewUndertime.status !== "PENDING" && reviewUndertime.remarks && (
                    <Text style={styles.reasonText}>Remarks: {reviewUndertime.remarks}</Text>
                  )}

                  {isOwnUndertime && (
                    <Text style={styles.warningText}>This is your own undertime filing — HR must review it.</Text>
                  )}
                  {!isOwnUndertime && reviewUndertime.status !== "PENDING" && (
                    <Text style={styles.warningText}>This filing has already been reviewed.</Text>
                  )}

                  {canReviewUndertime && (
                    <>
                      <Text style={styles.label}>Remarks</Text>
                      <TextInput
                        style={styles.textArea}
                        multiline
                        placeholder="Required when rejecting — optional when approving"
                        value={undertimeRemarks}
                        onChangeText={setUndertimeRemarks}
                      />

                      <View style={styles.modalActions}>
                        <Pressable style={styles.rejectButton} onPress={() => handleUndertimeReview("reject")}>
                          <Text style={styles.rejectText}>Reject</Text>
                        </Pressable>
                        <Pressable style={styles.approveButton} onPress={() => handleUndertimeReview("approve")}>
                          <Text style={styles.approveText}>Approve</Text>
                        </Pressable>
                      </View>
                    </>
                  )}
                </>
              )}
            </AestheticScrollView>
          </View>
        </View>
      </Modal>

      <Modal visible={!!viewingDocument} transparent animationType="fade" onRequestClose={() => setViewingDocument(null)}>
        <View style={styles.documentViewerOverlay}>
          {viewingDocument?.mimeType.startsWith("image/") ? (
            <ZoomableImage uri={viewingDocument.dataUri} style={styles.documentViewerMedia} />
          ) : viewingDocument ? (
            <WebView source={{ uri: viewingDocument.dataUri }} style={styles.documentViewerMedia} />
          ) : null}
          <Pressable style={styles.documentViewerCloseButton} onPress={() => setViewingDocument(null)} hitSlop={10}>
            <Ionicons name="close" size={22} color="#FFFFFF" />
          </Pressable>
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

// The employee-facing screens card shadow, shared from styles/ui so every
// card in the app floats the same way instead of this screen keeping its own
// flatter copy.
const cardShadow = CARD_SHADOW;

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  tabSwitcher: {
    marginBottom: 12,
  },
  scroller: { flex: 1 },
  list: { paddingBottom: 24, gap: 10 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#FFFFFF",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    padding: 14,
    ...cardShadow,
  },
  cardPressed: { opacity: 0.85 },
  // Wraps so a long status pill drops under the name instead of crushing it.
  cardHeader: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 8, rowGap: 4 },
  employeeName: { fontSize: 14, fontWeight: "700", color: "#062B59", flexShrink: 1 },
  leaveType: { fontSize: 13, color: "#334155", marginTop: 4, fontWeight: "600" },
  dateRange: { fontSize: 12, color: "#64748B", marginTop: 2 },
  modalOverlay: { flex: 1, backgroundColor: "rgba(6, 43, 89, 0.55)", alignItems: "center", justifyContent: "center", padding: 16 },
  // Same look as the employee's own attachment viewer (LeaveScreen.tsx).
  documentViewerOverlay: { flex: 1, backgroundColor: "rgba(15, 23, 42, 0.85)", alignItems: "center", justifyContent: "center", padding: 20 },
  documentViewerMedia: { width: "100%", height: "78%", borderRadius: 12, backgroundColor: "#FFFFFF" },
  documentViewerCloseButton: {
    position: "absolute",
    top: 50,
    right: 16,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.15)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.3)",
    alignItems: "center",
    justifyContent: "center",
  },
  modalCard: { width: "100%", maxWidth: 480, maxHeight: "92%", backgroundColor: "#FFFFFF", borderRadius: 20, padding: 20 },
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
