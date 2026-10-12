import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import AestheticScrollView from "../../components/AestheticScrollView";
import {
  RegularizationReview,
  approveRegularization,
  getRegularizationReview,
  getTeamEmployees,
  recommendRegularization,
  rejectRegularization,
} from "../../api";
import { CACHE_KEYS, revalidateCached } from "../../utils/dataCache";
import { ui } from "../../styles/ui";

type Props = {
  visible: boolean;
  employeeId: string;
  onClose: () => void;
};

const STATUS_LABELS: Record<string, string> = {
  REGULAR: "Regular",
  PROBATIONARY: "Probationary",
  PERMANENT_SEASONAL: "Permanent Seasonal",
  PROBATIONARY_SEASONAL: "Probationary Seasonal",
  SEPARATED: "Separated",
};

function formatLongDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function formatTenure(hireDate: string) {
  const start = new Date(hireDate);
  const now = new Date();
  let months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  if (now.getDate() < start.getDate()) months -= 1;
  if (months < 0) return "—";
  const anchor = new Date(start.getFullYear(), start.getMonth() + months, start.getDate());
  const days = Math.max(0, Math.round((now.getTime() - anchor.getTime()) / 86_400_000));
  return `${months} month${months === 1 ? "" : "s"}, ${days} day${days === 1 ? "" : "s"}`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

// Opened from the probation notifications — same review admin-web shows. The
// Supervisor's Approve / Reject is a recommendation sent to Admin; only the
// Admin's Approve converts the employee, and the Admin's Reject leaves them
// on probation.
export default function RegularizationReviewScreen({ visible, employeeId, onClose }: Props) {
  const [review, setReview] = useState<RegularizationReview | null>(null);
  const [remarks, setRemarks] = useState("");
  const [error, setError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  // Set once this viewer has decided — replaces the buttons with the outcome.
  const [outcome, setOutcome] = useState("");

  const loadReview = useCallback(
    () =>
      getRegularizationReview(employeeId)
        .then(setReview)
        .catch((err) => setError(err instanceof Error ? err.message : "Unable to load this employee's record.")),
    [employeeId],
  );

  useEffect(() => {
    loadReview();
  }, [loadReview]);

  async function decide(decision: "APPROVE" | "REJECT") {
    if (!review) return;
    setIsSaving(true);
    setError("");
    const note = remarks.trim() || undefined;
    try {
      if (review.viewerRole === "SUPERVISOR") {
        await recommendRegularization(employeeId, decision, note);
        setOutcome(
          decision === "APPROVE"
            ? "Your recommendation to approve was sent to the admin."
            : "Your recommendation to reject was sent to the admin.",
        );
      } else if (decision === "APPROVE" && review.targetStatus) {
        await approveRegularization(employeeId, review.targetStatus);
        // The Team tab reads the same cached roster — refresh its status.
        revalidateCached(CACHE_KEYS.teamEmployees, getTeamEmployees).catch(() => undefined);
        setOutcome(`Approved. The employee is now ${STATUS_LABELS[review.targetStatus] ?? review.targetStatus}.`);
      } else {
        await rejectRegularization(employeeId, note);
        setOutcome("Rejected. The employee remains on probation.");
      }
      await loadReview();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save your decision.");
    } finally {
      setIsSaving(false);
    }
  }

  const employee = review?.employee;
  const recommendation = review?.recommendation;
  const canDecide =
    !!review && !outcome && !!review.targetStatus && (review.viewerRole === "ADMIN" || !review.recommendation);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={ui.modalOverlay}>
        <View style={ui.modalCard}>
          <Text style={[ui.modalTitle, styles.title]}>Regularization Review</Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {employee ? `${employee.firstName} ${employee.lastName}` : " "}
          </Text>

          {!review && !error ? (
            <View style={styles.centered}>
              <ActivityIndicator color="#062B59" size="large" />
            </View>
          ) : (
            <AestheticScrollView style={styles.body} keyboardShouldPersistTaps="handled">
              {review && employee && (
                <>
                  <Text style={styles.section}>Employee Record</Text>
                  <Row label="Employee No." value={employee.employeeNo} />
                  <Row label="Email" value={employee.email ?? "—"} />
                  <Row label="Department" value={employee.department ?? "—"} />
                  <Row label="Position" value={employee.position ?? "—"} />
                  <Row label="Employee Type" value={employee.employeeType ?? "—"} />
                  <Row label="Supervisor" value={employee.supervisorName ?? "Unassigned"} />
                  <Row label="Status" value={STATUS_LABELS[employee.employmentStatus] ?? employee.employmentStatus} />
                  <Row label="Hire Date" value={formatLongDate(employee.hireDate)} />
                  <Row label="Length of Service" value={formatTenure(employee.hireDate)} />

                  <Text style={styles.section}>Attendance Since Hire</Text>
                  <View style={styles.stats}>
                    {(
                      [
                        ["Working days", review.attendance.totalWorkingDays],
                        ["Present", review.attendance.daysPresent],
                        ["Absent", review.attendance.absences],
                        ["Late", review.attendance.lateOccurrences],
                        ["Undertime", review.attendance.undertimeOccurrences],
                      ] as const
                    ).map(([label, value]) => (
                      <View key={label} style={styles.stat}>
                        <Text style={styles.statValue}>{value}</Text>
                        <Text style={styles.statLabel} numberOfLines={1}>
                          {label}
                        </Text>
                      </View>
                    ))}
                  </View>

                  <Text style={styles.section}>Supervisor Recommendation</Text>
                  {recommendation ? (
                    <>
                      <Row label="Recommendation" value={recommendation.decision === "APPROVE" ? "Approve" : "Reject"} />
                      <Row label="By" value={recommendation.supervisorName} />
                      {!!recommendation.decidedAt && <Row label="Date" value={formatLongDate(recommendation.decidedAt)} />}
                      <Row label="Remarks" value={recommendation.remarks || "None"} />
                    </>
                  ) : (
                    <Text style={styles.note}>No recommendation from the supervisor yet.</Text>
                  )}

                  {!review.targetStatus && !outcome && (
                    <Text style={styles.note}>This employee is no longer on probation.</Text>
                  )}

                  {canDecide && (
                    <>
                      <Text style={styles.section}>Remarks (optional)</Text>
                      <TextInput
                        style={styles.remarksInput}
                        value={remarks}
                        onChangeText={setRemarks}
                        maxLength={1000}
                        multiline
                        placeholder={
                          review.viewerRole === "SUPERVISOR" ? "Add a note for the admin" : "Add a note about this decision"
                        }
                        placeholderTextColor="#94A3B8"
                      />
                      {review.viewerRole === "SUPERVISOR" && (
                        <Text style={styles.hint}>Your decision is sent to the admin, who makes the final call.</Text>
                      )}
                    </>
                  )}
                </>
              )}

              {!!outcome && <Text style={styles.outcome}>{outcome}</Text>}
              {!!error && <Text style={styles.error}>{error}</Text>}
            </AestheticScrollView>
          )}

          {canDecide && (
            <View style={styles.decisionRow}>
              <Pressable
                style={({ pressed }) => [styles.rejectButton, (pressed || isSaving) && styles.dim]}
                disabled={isSaving}
                onPress={() => decide("REJECT")}
              >
                <Ionicons name="close-circle-outline" size={17} color="#DC2626" />
                <Text style={styles.rejectButtonText}>Reject</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.approveButton, (pressed || isSaving) && styles.dim]}
                disabled={isSaving}
                onPress={() => decide("APPROVE")}
              >
                {isSaving ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Ionicons name="checkmark-circle-outline" size={17} color="#FFFFFF" />
                )}
                <Text style={styles.approveButtonText}>Approve</Text>
              </Pressable>
            </View>
          )}

          <Pressable style={styles.closeButton} disabled={isSaving} onPress={onClose}>
            <Text style={styles.closeButtonText}>Close</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  title: { marginBottom: 2 },
  subtitle: { fontSize: 12.5, fontWeight: "600", color: "#64748B", textAlign: "center", marginBottom: 8 },
  centered: { alignItems: "center", justifyContent: "center", paddingVertical: 40 },
  body: { flexGrow: 0 },
  section: {
    fontSize: 10.5,
    fontWeight: "700",
    color: "#94A3B8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 14,
    marginBottom: 4,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#E2E8F0",
  },
  rowLabel: { fontSize: 12.5, fontWeight: "600", color: "#64748B" },
  rowValue: { flex: 1, fontSize: 13, fontWeight: "700", color: "#062B59", textAlign: "right" },
  stats: {
    flexDirection: "row",
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    backgroundColor: "#F8FAFC",
  },
  stat: { flex: 1, alignItems: "center", paddingHorizontal: 2 },
  statValue: { fontSize: 15, fontWeight: "800", color: "#062B59" },
  statLabel: { fontSize: 9.5, fontWeight: "700", color: "#64748B", marginTop: 2 },
  note: { fontSize: 12.5, fontWeight: "600", color: "#64748B", paddingVertical: 6 },
  remarksInput: {
    minHeight: 64,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13.5,
    fontWeight: "600",
    color: "#0F172A",
    textAlignVertical: "top",
  },
  hint: { fontSize: 11.5, fontWeight: "600", color: "#94A3B8", marginTop: 6 },
  outcome: { fontSize: 13, fontWeight: "800", color: "#15803D", marginTop: 14 },
  error: { fontSize: 12.5, fontWeight: "700", color: "#DC2626", marginTop: 10 },
  decisionRow: { flexDirection: "row", gap: 8, marginTop: 14 },
  rejectButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 46,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#FCA5A5",
    backgroundColor: "#FFFFFF",
  },
  rejectButtonText: { fontSize: 14, fontWeight: "800", color: "#DC2626" },
  approveButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 46,
    borderRadius: 12,
    backgroundColor: "#062B59",
  },
  approveButtonText: { fontSize: 14, fontWeight: "800", color: "#FFFFFF" },
  dim: { opacity: 0.6 },
  closeButton: { alignSelf: "center", marginTop: 12, paddingHorizontal: 18, paddingVertical: 8 },
  closeButtonText: { fontSize: 13, fontWeight: "700", color: "#64748B" },
});
