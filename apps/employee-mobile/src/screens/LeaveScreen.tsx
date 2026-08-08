import React, { useEffect, useMemo, useRef, useState } from "react";
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
import LeaveBalanceChart from "../components/LeaveBalanceChart";
import {
  LeaveType,
  LeaveBalance,
  LeaveRequest,
  UndertimeEligibility,
  UndertimeFiling,
  getLeaveTypes,
  getLeaveBalances,
  getLeaveRequests,
  createLeaveRequest,
  cancelLeaveRequest,
  getUndertimeEligibility,
  getUndertimeFilings,
  fileUndertime,
} from "../api";
import { CACHE_KEYS, useCachedData } from "../utils/dataCache";

const { height: SCREEN_HEIGHT } = Dimensions.get("window");
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

// Stable fallbacks so useMemo filters don't recompute on every render while
// the cache/network is still empty.
const EMPTY_LEAVE_TYPES: LeaveType[] = [];
const EMPTY_BALANCES: LeaveBalance[] = [];
const EMPTY_REQUESTS: LeaveRequest[] = [];
const EMPTY_UNDERTIME_FILINGS: UndertimeFiling[] = [];

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

function isOneDayLeaveType(name?: string, isSingleDayOnly?: boolean) {
  if (isSingleDayOnly) return true;
  const normalized = (name ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return normalized.includes("adverse weather") || normalized === "sick leave" || normalized === "emergency leave";
}

// SUPERVISOR_APPROVED only exists on legacy rows from the old two-step flow;
// it stays amber because it still needs one more Approve click to finalize.
function statusTone(status: string) {
  if (status === "APPROVED") return { color: "#15803D", bg: "#DCFCE7" };
  if (status === "REJECTED" || status === "CANCELLED") return { color: "#B91C1C", bg: "#FEE2E2" };
  return { color: "#B45309", bg: "#FEF3C7" };
}

function statusLabel(status: string) {
  if (status === "SUPERVISOR_APPROVED") return "APPROVED — FINALIZING";
  return status.replace("_", " ");
}

export default function LeaveScreen({ employeeId }: Props) {
  const leaveTypesCache = useCachedData<LeaveType[]>("leave-types", getLeaveTypes);
  const balancesCache = useCachedData<LeaveBalance[]>(
    employeeId ? CACHE_KEYS.leaveBalances(employeeId) : null,
    () => getLeaveBalances(employeeId!),
  );
  const requestsCache = useCachedData<LeaveRequest[]>(
    employeeId ? CACHE_KEYS.leaveRequests(employeeId) : null,
    () => getLeaveRequests(employeeId!),
  );
  const leaveTypes = leaveTypesCache.data ?? EMPTY_LEAVE_TYPES;
  const balances = balancesCache.data ?? EMPTY_BALANCES;
  const requests = requestsCache.data ?? EMPTY_REQUESTS;
  const isLoadingData = leaveTypesCache.isLoading || balancesCache.isLoading || requestsCache.isLoading;

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
  const [dropdownLayout, setDropdownLayout] = useState({ x: 0, y: 0, width: 0 });
  const dropdownButtonRef = useRef<View>(null);

  const [attachment, setAttachment] = useState<PickedAttachment | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isPickingFile, setIsPickingFile] = useState(false);

  const [showPending, setShowPending] = useState(false);
  const [activeTab, setActiveTab] = useState<"balance" | "request" | "undertime">("balance");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [resultModal, setResultModal] = useState<{ status: ResultModalStatus; title: string; message: string } | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  // Undertime filing
  const undertimeEligibilityCache = useCachedData<UndertimeEligibility>(
    employeeId ? CACHE_KEYS.undertimeEligibility(employeeId) : null,
    () => getUndertimeEligibility(employeeId!),
  );
  const undertimeFilingsCache = useCachedData<UndertimeFiling[]>(
    employeeId ? CACHE_KEYS.undertimeFilings(employeeId) : null,
    () => getUndertimeFilings(employeeId!),
  );
  const undertimeEligibility = undertimeEligibilityCache.data;
  const undertimeFilings = undertimeFilingsCache.data ?? EMPTY_UNDERTIME_FILINGS;
  const [undertimeReason, setUndertimeReason] = useState("");
  const [isFilingUndertime, setIsFilingUndertime] = useState(false);

  async function handleFileUndertime() {
    if (!employeeId) return;
    setIsFilingUndertime(true);
    try {
      await fileUndertime(employeeId, undertimeReason.trim() || undefined);
      setUndertimeReason("");
      await Promise.all([undertimeEligibilityCache.refresh(), undertimeFilingsCache.refresh()]);
      setResultModal({ status: "approved", title: "Undertime Filed", message: "Your undertime filing for today has been recorded." });
    } catch (err) {
      setResultModal({
        status: "error",
        title: "Filing Failed",
        message: err instanceof Error ? err.message : "Unable to file undertime.",
      });
    } finally {
      setIsFilingUndertime(false);
    }
  }

  const selectedLeaveType = leaveTypes.find((t) => t.id === leaveTypeId);
  const isSingleDayLeave = isOneDayLeaveType(selectedLeaveType?.name, selectedLeaveType?.isSingleDayOnly);
  // Separate from isSingleDayLeave (which only controls the 1-day duration
  // UI) — this is the advance-filing rule (Sick Leave: today only, never a
  // future date), driven by the leave type's own config so it isn't tied to
  // the type's name or its single-day-ness.
  const lockedToToday = selectedLeaveType?.advanceFilingAllowed === false;
  const today = useMemo(() => new Date(), []);
  const todayStart = useMemo(() => new Date(today.getFullYear(), today.getMonth(), today.getDate()), [today]);
  const filteredLeaveTypes = leaveTypes
    .filter((item) => item.isActive)
    .filter((item) => item.name.toLowerCase().includes(searchLeave.toLowerCase()));

  const remainingByLeaveType = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of balances) map.set(b.leaveTypeId, b.remainingDays);
    return map;
  }, [balances]);

  function remainingDaysFor(item: LeaveType) {
    const remaining = remainingByLeaveType.get(item.id);
    if (remaining !== undefined) return remaining;
    return item.requiresAdminGrant ? 0 : Number(item.defaultDays);
  }

  // Admin-grant-only types (Solo Parent, Study Leave, Added Paternity Leave)
  // that this employee hasn't been granted yet shouldn't clutter the balance
  // view with a 0/0 row — they only show up there once HR/Admin grants them.
  const visibleBalances = useMemo(() => {
    return balances.filter((b) => {
      const type = leaveTypes.find((t) => t.id === b.leaveTypeId);
      if (type?.requiresAdminGrant && b.earnedDays <= 0) return false;
      return true;
    });
  }, [balances, leaveTypes]);

  function isLeaveTypeExhausted(item: LeaveType) {
    if (item.allowWithoutPay || item.isUnlimitedDays) return false;
    return remainingDaysFor(item) <= 0;
  }

  // "Request" button on a balance row: jump to the request tab with that
  // leave type already selected, unless it can't be requested (same rules as
  // the disabled dropdown entries).
  function handleRequestFromBalance(id: string) {
    const type = leaveTypes.find((t) => t.id === id);
    if (!type || !type.isActive) return;
    if (isLeaveTypeExhausted(type)) {
      setResultModal({
        status: "info",
        title: type.requiresAdminGrant ? "Not Yet Granted" : "No Balance Left",
        message: type.requiresAdminGrant
          ? `${type.name} must be granted by HR/Admin before you can request it. Please apply to HR/Admin first.`
          : `You have no remaining ${type.name} days to request.`,
      });
      return;
    }
    setLeaveTypeId(id);
    if (type.isSingleDayOnly) {
      setStartDate(todayStart);
      setEndDate(todayStart);
      setStartDateSelected(true);
      setEndDateSelected(true);
    }
    setActiveTab("request");
  }

  function openLeaveTypeDropdown() {
    dropdownButtonRef.current?.measureInWindow((x, y, width, height) => {
      setDropdownLayout({ x, y: y + height, width });
      setIsDropdownOpen(true);
    });
    setSearchLeave("");
  }

  const pendingRequests = useMemo(
    () => requests.filter((r) => r.status === "PENDING" || r.status === "SUPERVISOR_APPROVED" || r.status === "NEEDS_REVISION"),
    [requests],
  );

  // Re-fetches everything after a mutation (e.g. submitting a request);
  // initial loads happen inside each useCachedData hook.
  async function loadData() {
    try {
      await Promise.all([leaveTypesCache.refresh(), balancesCache.refresh(), requestsCache.refresh()]);
    } catch (error) {
      console.error("Failed to load leave data", error);
    }
  }

  async function handleCancel(requestId: string) {
    setCancellingId(requestId);
    try {
      await cancelLeaveRequest(requestId);
      await requestsCache.refresh();
    } catch (err) {
      setResultModal({
        status: "error",
        title: "Cancellation Failed",
        message: err instanceof Error ? err.message : "Unable to cancel this leave request.",
      });
    } finally {
      setCancellingId(null);
    }
  }

  const handleStartDateConfirm = (selectedDate = new Date()) => {
    setStartPickerVisibility(false);
    setStartDate(selectedDate);
    setStartDateSelected(true);
    if (isSingleDayLeave) {
      setEndDate(selectedDate);
      setEndDateSelected(true);
      return;
    }
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
    if (isSingleDayLeave) return 1;
    if (!startDateSelected || !endDateSelected) return 0;
    const diff = Math.round((endDate.getTime() - startDate.getTime()) / 86400000) + 1;
    return Math.max(1, diff);
  }, [isSingleDayLeave, startDate, endDate, startDateSelected, endDateSelected]);

  // The date range a request can span cannot exceed the leave type's
  // remaining allotment (e.g. Vacation Leave with 15 days left caps the end
  // date 15 days after the start date) — unlimited/without-pay types are
  // exempt, same as the balance check in handleSubmit below.
  const maxEndDate = useMemo(() => {
    if (!selectedLeaveType || !startDateSelected) return undefined;
    if (selectedLeaveType.allowWithoutPay || selectedLeaveType.isUnlimitedDays) return undefined;
    const remaining = remainingDaysFor(selectedLeaveType);
    const max = new Date(startDate);
    max.setDate(max.getDate() + Math.max(0, remaining - 1));
    return max;
  }, [selectedLeaveType, startDate, startDateSelected, remainingByLeaveType]);

  // Single-day-only types (Sick Leave, Emergency Leave) always mirror the end
  // date to the start date the moment either one is known.
  useEffect(() => {
    if (isSingleDayLeave && startDateSelected) {
      setEndDate(startDate);
      setEndDateSelected(true);
    }
  }, [isSingleDayLeave, startDate, startDateSelected]);

  useEffect(() => {
    if (!lockedToToday) return;
    setStartDate(todayStart);
    setEndDate(todayStart);
    setStartDateSelected(true);
    setEndDateSelected(true);
  }, [lockedToToday, todayStart]);

  // Clamp a previously-picked end date if switching leave type (or the
  // remaining balance) shrinks the allowed range below it.
  useEffect(() => {
    if (!maxEndDate || !endDateSelected) return;
    if (endDate > maxEndDate) setEndDate(maxEndDate);
  }, [maxEndDate]);

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

    const leaveStartDate = isSingleDayLeave ? startDate : startDate;
    const leaveEndDate = isSingleDayLeave ? startDate : endDate;
    const leaveTotalDays = isSingleDayLeave ? 1 : totalDays;

    if (selectedLeaveType?.requiresDocument && !attachment) {
      setResultModal({
        status: "info",
        title: "Document Required",
        message: `${selectedLeaveType.name} requires a supporting document. Please attach one before submitting.`,
      });
      return;
    }
    if (selectedLeaveType && !selectedLeaveType.allowWithoutPay && !selectedLeaveType.isUnlimitedDays) {
      const remainingDays = remainingDaysFor(selectedLeaveType);
      if (selectedLeaveType.requiresAdminGrant && remainingDays <= 0) {
        setResultModal({
          status: "info",
          title: "Not Yet Granted",
          message: `${selectedLeaveType.name} must be granted by HR/Admin before you can request it. Please apply to HR/Admin first.`,
        });
        return;
      }
      if (remainingDays <= 0) {
        setResultModal({
          status: "error",
          title: "No Remaining Balance",
          message: "You have no remaining balance for this leave type.",
        });
        return;
      }
      if (leaveTotalDays > remainingDays) {
        setResultModal({
          status: "error",
          title: "Insufficient Balance",
          message: `You have ${remainingDays} day(s) of ${selectedLeaveType.name} left, but requested ${leaveTotalDays}.`,
        });
        return;
      }
    }

    setIsSubmitting(true);
    try {
      await createLeaveRequest({
        employeeId,
        leaveTypeId,
        startDate: leaveStartDate.toISOString(),
        endDate: leaveEndDate.toISOString(),
        totalDays: leaveTotalDays,
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
      <View style={styles.tabSwitcher}>
        <Pressable
          style={[styles.tabButton, activeTab === "balance" && styles.tabButtonActive]}
          onPress={() => setActiveTab("balance")}
        >
          <Text style={[styles.tabButtonText, activeTab === "balance" && styles.tabButtonTextActive]}>Balance</Text>
        </Pressable>
        <Pressable
          style={[styles.tabButton, activeTab === "request" && styles.tabButtonActive]}
          onPress={() => setActiveTab("request")}
        >
          <Text style={[styles.tabButtonText, activeTab === "request" && styles.tabButtonTextActive]}>Request</Text>
        </Pressable>
        <Pressable
          style={[styles.tabButton, activeTab === "undertime" && styles.tabButtonActive]}
          onPress={() => setActiveTab("undertime")}
        >
          <Text style={[styles.tabButtonText, activeTab === "undertime" && styles.tabButtonTextActive]}>Undertime</Text>
        </Pressable>
      </View>

      {activeTab === "balance" ? (
        <View style={[styles.tabContentPad, { flex: 1 }]}>
          <LeaveBalanceChart
            balances={visibleBalances}
            loading={isLoadingData}
            pendingCount={pendingRequests.length}
            onPressPending={() => setShowPending(true)}
            onRequestLeave={handleRequestFromBalance}
          />
        </View>
      ) : activeTab === "undertime" ? (
        <ScrollView
          contentContainerStyle={[styles.tabContentPad, { flexGrow: 1 }]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.card}>
            <View style={styles.formHeader}>
              <Ionicons color="#DC2777" name="document-text-outline" size={32} />
              <Text style={styles.cardTitle}>File Undertime</Text>
            </View>

            {/* Mirrors whatever the backend's eligibility check returns — the
                8th/23rd filing days and the 3-per-month cap are not hardcoded
                here, only reflected from the API. */}
            {undertimeEligibility && (
              <Text style={styles.pendingNoticeText}>
                {undertimeEligibility.filedThisMonth}/{undertimeEligibility.maxFilingsPerMonth} filed this month.{" "}
                {undertimeEligibility.alreadyFiledToday
                  ? "You've already filed undertime today."
                  : !undertimeEligibility.isFilingDay
                    ? `Undertime can only be filed on the ${undertimeEligibility.filingDaysOfMonth.join(" or ")} of the month.`
                    : undertimeEligibility.remaining <= 0
                      ? "You've reached this month's filing limit."
                      : "You're eligible to file undertime today."}
              </Text>
            )}

            <Text style={styles.label}>Reason (optional)</Text>
            <View style={styles.textAreaContainer}>
              <TextInput
                placeholder="Optional note for this filing"
                multiline
                value={undertimeReason}
                onChangeText={setUndertimeReason}
                style={styles.textAreaInput}
              />
            </View>

            <Pressable
              style={[styles.button, (isFilingUndertime || !undertimeEligibility?.eligible) && styles.buttonDisabled]}
              onPress={handleFileUndertime}
              disabled={isFilingUndertime || !undertimeEligibility?.eligible}
            >
              {isFilingUndertime ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.buttonText}>File Undertime for Today</Text>
              )}
            </Pressable>

            <Text style={[styles.cardTitle, { fontSize: 15, marginTop: 20, marginBottom: 8 }]}>This Month's Filings</Text>
            {undertimeFilings.length === 0 ? (
              <Text style={styles.modalEmptyText}>No undertime filings yet.</Text>
            ) : (
              undertimeFilings.map((f) => (
                <View key={f.id} style={styles.requestCard}>
                  <Text style={styles.requestTitle}>{new Date(f.filingDate).toLocaleDateString()}</Text>
                  {f.reason && <Text>{f.reason}</Text>}
                </View>
              ))
            )}
          </View>
        </ScrollView>
      ) : pendingRequests.length > 0 ? (
        <ScrollView
          contentContainerStyle={[styles.tabContentPad, { flexGrow: 1 }]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.card}>
            <View style={styles.formHeader}>
              <Ionicons color="#DC2777" name="document-text-outline" size={32} />
              <Text style={styles.cardTitle}>Leave Request</Text>
            </View>

            <Text style={styles.pendingNoticeText}>
              You have a leave request awaiting review. You can submit a new request once it's approved, rejected, or cancelled.
            </Text>

            {pendingRequests.map((request) => {
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
                    {statusLabel(request.status)}
                  </Text>
                  {(request.status === "PENDING" || request.status === "SUPERVISOR_APPROVED") && (
                    <Pressable
                      style={styles.cancelRequestButton}
                      onPress={() => handleCancel(request.id)}
                      disabled={cancellingId === request.id}
                    >
                      <Text style={styles.cancelRequestButtonText}>
                        {cancellingId === request.id ? "Cancelling…" : "Cancel"}
                      </Text>
                    </Pressable>
                  )}
                </View>
              );
            })}
          </View>
        </ScrollView>
      ) : (
        <ScrollView
          contentContainerStyle={[styles.tabContentPad, { flexGrow: 1 }]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.card}>
            <View style={styles.formHeader}>
              <Ionicons color="#DC2777" name="document-text-outline" size={32} />
              <Text style={styles.cardTitle}>Leave Request</Text>
            </View>

            <Text style={styles.label}>Leave Type</Text>
            <View style={styles.dropdownWrapper}>
              <Pressable
                ref={dropdownButtonRef}
                style={[styles.dropdownButton, isDropdownOpen && { borderColor: "#062B59" }]}
                onPress={() => (isDropdownOpen ? setIsDropdownOpen(false) : openLeaveTypeDropdown())}
              >
                <Text style={[styles.dropdownText, !leaveTypeId && { color: "#94A3B8" }]}>
                  {selectedLeaveType?.name || (isLoadingData ? "Loading leave types…" : "Select Leave Type")}
                </Text>
                <Ionicons name={isDropdownOpen ? "chevron-up" : "chevron-down"} size={20} color="#64748B" />
              </Pressable>
            </View>

            <Modal
              visible={isDropdownOpen}
              transparent
              animationType="none"
              onRequestClose={() => setIsDropdownOpen(false)}
            >
              <Pressable style={StyleSheet.absoluteFill} onPress={() => setIsDropdownOpen(false)} />
              <View
                style={[
                  styles.inlineDropdownContainer,
                  { top: dropdownLayout.y, left: dropdownLayout.x, width: dropdownLayout.width },
                ]}
              >
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

                <ScrollView style={{ maxHeight: 160 }} persistentScrollbar={true} indicatorStyle="black">
                  {filteredLeaveTypes.length > 0 ? (
                    filteredLeaveTypes.map((item) => {
                      const exhausted = isLeaveTypeExhausted(item);
                      return (
                        <Pressable
                          key={item.id}
                          style={[styles.inlineItem, exhausted && styles.inlineItemDisabled]}
                          disabled={exhausted}
                          onPress={() => {
                            setLeaveTypeId(item.id);
                            if (isOneDayLeaveType(item.name, item.isSingleDayOnly)) {
                              setStartDate(todayStart);
                              setEndDate(todayStart);
                              setStartDateSelected(true);
                              setEndDateSelected(true);
                            }
                            setIsDropdownOpen(false);
                            setSearchLeave("");
                          }}
                        >
                          <Text
                            style={[
                              styles.inlineItemText,
                              leaveTypeId === item.id && styles.selectedItemText,
                              exhausted && styles.disabledItemText,
                            ]}
                          >
                            {item.name}
                            {item.requiresDocument ? " (document required)" : ""}
                            {exhausted
                              ? item.requiresAdminGrant
                                ? " (apply to HR/Admin first)"
                                : " (no balance left)"
                              : ""}
                          </Text>
                        </Pressable>
                      );
                    })
                  ) : (
                    <View style={styles.noResultsBox}>
                      <Text style={styles.noResultsText}>No leave types found</Text>
                    </View>
                  )}
                </ScrollView>
              </View>
            </Modal>

            <Text style={styles.label}>{isSingleDayLeave ? "Date" : "Leave Duration"}</Text>
            {isSingleDayLeave ? (
              <View style={styles.dateRow}>
                <Pressable style={styles.dateBox} onPress={() => setStartPickerVisibility(true)}>
                  <Text style={[styles.dateText, !startDateSelected && { color: "#94A3B8" }]}>
                    {startDateSelected ? formatDate(startDate) : "Select Date"}
                  </Text>
                  <Ionicons name="calendar-outline" size={20} color="#64748B" />
                </Pressable>
              </View>
            ) : (
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
            )}
            {isSingleDayLeave ? (
              <Text style={styles.totalDaysText}>1 day only</Text>
            ) : startDateSelected && endDateSelected ? (
              <Text style={styles.totalDaysText}>{totalDays} day{totalDays === 1 ? "" : "s"} total</Text>
            ) : null}
            {maxEndDate && !isSingleDayLeave && (
              <Text style={styles.totalDaysText}>
                {remainingDaysFor(selectedLeaveType!)} day{remainingDaysFor(selectedLeaveType!) === 1 ? "" : "s"} available for {selectedLeaveType!.name} — end date can't go past {formatDate(maxEndDate)}
              </Text>
            )}

            <DateTimePickerModal
              isVisible={isStartPickerVisible}
              mode="date"
              maximumDate={lockedToToday ? todayStart : undefined}
              onConfirm={handleStartDateConfirm}
              onCancel={() => setStartPickerVisibility(false)}
            />

            <DateTimePickerModal
              isVisible={isEndPickerVisible}
              mode="date"
              minimumDate={startDateSelected ? startDate : undefined}
              maximumDate={maxEndDate}
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
      )}

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
                        {statusLabel(request.status)}
                      </Text>
                      {(request.status === "PENDING" || request.status === "SUPERVISOR_APPROVED") && (
                        <Pressable
                          style={styles.cancelRequestButton}
                          onPress={() => handleCancel(request.id)}
                          disabled={cancellingId === request.id}
                        >
                          <Text style={styles.cancelRequestButtonText}>
                            {cancellingId === request.id ? "Cancelling…" : "Cancel"}
                          </Text>
                        </Pressable>
                      )}
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
  tabSwitcher: {
    flexDirection: "row",
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 4,
    backgroundColor: "#F1F5F9",
    borderRadius: 14,
    padding: 4,
  },
  tabButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 11,
    alignItems: "center",
  },
  tabButtonActive: {
    backgroundColor: "#062B59",
  },
  tabButtonText: {
    fontSize: 14,
    fontWeight: "700",
    color: "#64748B",
  },
  tabButtonTextActive: {
    color: "#FFFFFF",
  },
  tabContentPad: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: SCREEN_HEIGHT < 700 ? 16 : 24,
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
  pendingNoticeText: {
    color: "#64748B",
    fontSize: 13,
    marginTop: 12,
    marginBottom: 4,
    lineHeight: 18,
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
  inlineItemDisabled: {
    backgroundColor: "#F8FAFC",
  },
  disabledItemText: {
    color: "#CBD5E1",
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
  requestCard: { backgroundColor: "#F8FAFC", borderRadius: 12, padding: 14, marginBottom: 12 },
  requestTitle: { fontWeight: "700", marginBottom: 4 },
  requestAttachmentRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  requestAttachmentText: { fontSize: 12, color: "#64748B" },
  pendingText: { fontWeight: "700", marginTop: 8, alignSelf: "flex-start", fontSize: 11, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, overflow: "hidden" },
  cancelRequestButton: { alignSelf: "flex-start", marginTop: 10, borderWidth: 1.5, borderColor: "#FCA5A5", backgroundColor: "#FEF2F2", borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5 },
  cancelRequestButtonText: { color: "#DC2626", fontWeight: "700", fontSize: 11 },
  closeButton: { backgroundColor: "#062B59", borderRadius: 12, padding: 12, marginTop: 12 },
  closeText: { color: "#FFFFFF", textAlign: "center", fontWeight: "700" },
});
