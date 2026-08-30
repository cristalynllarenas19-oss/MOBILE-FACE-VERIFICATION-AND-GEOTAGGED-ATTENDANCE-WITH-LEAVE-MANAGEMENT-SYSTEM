import React, { useEffect, useState } from "react";
import { Modal, SafeAreaView, View, Text, TextInput, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import SegmentedControl from "../../components/SegmentedControl";
import ResultModal, { ResultModalStatus } from "../../components/ResultModal";
import AestheticScrollView from "../../components/AestheticScrollView";
import {
  EvaluationCriteriaInput,
  EvaluationRecommendation,
  getEmployeeEvaluation,
  saveEvaluationDraft,
  submitEvaluation,
} from "../../api";

type Props = {
  visible: boolean;
  employeeId: string;
  employeeName: string;
  onClose: () => void;
  // Called after a successful submit, so the caller can mark the source
  // notification handled / refresh whatever list surfaced it.
  onSubmitted?: () => void;
};

const RATING_SEGMENTS = [1, 2, 3, 4, 5].map((n) => ({ key: String(n), label: String(n) }));

const CRITERIA: { key: keyof EvaluationCriteriaInput; label: string }[] = [
  { key: "workQuality", label: "Work Quality" },
  { key: "productivity", label: "Productivity" },
  { key: "jobKnowledge", label: "Job Knowledge" },
  { key: "workAttitude", label: "Work Attitude" },
  { key: "communication", label: "Communication" },
  { key: "teamwork", label: "Teamwork" },
  { key: "adaptability", label: "Adaptability" },
];

const RECOMMENDATIONS: { key: EvaluationRecommendation; label: string }[] = [
  { key: "READY_FOR_CONVERSION", label: "Ready for Conversion to Regular" },
  { key: "NOT_YET_READY", label: "Not Yet Ready / Extend Probationary Period" },
  { key: "NOT_RECOMMENDED", label: "Not Recommended for Regularization" },
];

function emptyForm(): EvaluationCriteriaInput {
  return {};
}

export default function EvaluationFormScreen({ visible, employeeId, employeeName, onClose, onSubmitted }: Props) {
  const [isLoading, setIsLoading] = useState(true);
  const [form, setForm] = useState<EvaluationCriteriaInput>(emptyForm());
  const [alreadySubmitted, setAlreadySubmitted] = useState<{ submittedAt: string | null } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [resultModal, setResultModal] = useState<{ status: ResultModalStatus; title: string; message: string } | null>(null);

  useEffect(() => {
    if (!visible) return;
    setIsLoading(true);
    setValidationError(null);
    getEmployeeEvaluation(employeeId)
      .then((existing) => {
        if (!existing) {
          setForm(emptyForm());
          setAlreadySubmitted(null);
          return;
        }
        setForm({
          workQuality: existing.workQuality ?? undefined,
          productivity: existing.productivity ?? undefined,
          jobKnowledge: existing.jobKnowledge ?? undefined,
          workAttitude: existing.workAttitude ?? undefined,
          communication: existing.communication ?? undefined,
          teamwork: existing.teamwork ?? undefined,
          adaptability: existing.adaptability ?? undefined,
          overallRating: existing.overallRating ?? undefined,
          comments: existing.comments ?? undefined,
          recommendation: existing.recommendation ?? undefined,
        });
        setAlreadySubmitted(existing.status === "SUBMITTED" ? { submittedAt: existing.submittedAt } : null);
      })
      .catch((error) => {
        setResultModal({ status: "error", title: "Failed to Load", message: error instanceof Error ? error.message : "Could not load this evaluation." });
      })
      .finally(() => setIsLoading(false));
  }, [visible, employeeId]);

  function setRating(key: keyof EvaluationCriteriaInput, value: number) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function isComplete() {
    return (
      CRITERIA.every((c) => typeof form[c.key] === "number") &&
      typeof form.overallRating === "number" &&
      !!form.recommendation
    );
  }

  async function handleSaveDraft() {
    setIsSaving(true);
    try {
      await saveEvaluationDraft(employeeId, form);
      setResultModal({ status: "info", title: "Draft Saved", message: "Your progress has been saved. You can finish this evaluation later." });
    } catch (error) {
      setResultModal({ status: "error", title: "Save Failed", message: error instanceof Error ? error.message : "Failed to save draft." });
    } finally {
      setIsSaving(false);
    }
  }

  function handlePressSubmit() {
    if (!isComplete()) {
      setValidationError("Please rate every criterion, set an overall rating, and select a recommendation before submitting.");
      return;
    }
    setValidationError(null);
    setShowConfirm(true);
  }

  async function handleConfirmSubmit() {
    setShowConfirm(false);
    setIsSubmitting(true);
    try {
      await submitEvaluation(employeeId, form as Required<Omit<EvaluationCriteriaInput, "comments">> & { comments?: string });
      setResultModal({ status: "approved", title: "Evaluation Submitted", message: `${employeeName}'s performance evaluation has been submitted.` });
      onSubmitted?.();
    } catch (error) {
      setResultModal({ status: "error", title: "Submit Failed", message: error instanceof Error ? error.message : "Failed to submit evaluation." });
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleCloseResult() {
    const wasSuccess = resultModal?.status === "approved";
    setResultModal(null);
    if (wasSuccess) onClose();
  }

  const isLocked = !!alreadySubmitted;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.header}>
          <Pressable onPress={onClose} style={({ pressed }) => [styles.headerButton, pressed && styles.headerButtonPressed]} hitSlop={8}>
            <Ionicons name="chevron-back" size={24} color="#062B59" />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>Performance Evaluation</Text>
            <Text style={styles.headerSubtitle} numberOfLines={1}>{employeeName}</Text>
          </View>
        </View>

        {isLoading ? (
          <View style={styles.centered}>
            <ActivityIndicator color="#062B59" size="large" />
          </View>
        ) : (
          <AestheticScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            {isLocked && (
              <View style={styles.submittedBanner}>
                <Ionicons name="checkmark-circle" size={18} color="#15803D" />
                <Text style={styles.submittedBannerText}>
                  Submitted{alreadySubmitted?.submittedAt ? ` on ${new Date(alreadySubmitted.submittedAt).toLocaleDateString()}` : ""}. This evaluation can no longer be edited.
                </Text>
              </View>
            )}

            {CRITERIA.map((criterion) => (
              <View key={criterion.key} style={styles.field}>
                <Text style={styles.label}>{criterion.label}</Text>
                <SegmentedControl
                  segments={RATING_SEGMENTS}
                  value={form[criterion.key] ? String(form[criterion.key]) : ""}
                  onChange={(v) => setRating(criterion.key, Number(v))}
                  style={isLocked ? styles.segmentedDisabled : undefined}
                />
              </View>
            ))}

            <View style={styles.divider} />

            <View style={styles.field}>
              <Text style={styles.label}>Overall Performance Rating</Text>
              <SegmentedControl
                segments={RATING_SEGMENTS}
                value={form.overallRating ? String(form.overallRating) : ""}
                onChange={(v) => setRating("overallRating", Number(v))}
                style={isLocked ? styles.segmentedDisabled : undefined}
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Supervisor Comments / Remarks</Text>
              <TextInput
                style={styles.textArea}
                multiline
                editable={!isLocked}
                placeholder="Optional comments about this employee's performance"
                value={form.comments ?? ""}
                onChangeText={(v) => setForm((f) => ({ ...f, comments: v }))}
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Recommendation</Text>
              {RECOMMENDATIONS.map((option) => {
                const isActive = form.recommendation === option.key;
                return (
                  <Pressable
                    key={option.key}
                    disabled={isLocked}
                    style={[styles.recommendationOption, isActive && styles.recommendationOptionActive]}
                    onPress={() => setForm((f) => ({ ...f, recommendation: option.key }))}
                  >
                    <View style={[styles.radioOuter, isActive && styles.radioOuterActive]}>
                      {isActive && <View style={styles.radioInner} />}
                    </View>
                    <Text style={[styles.recommendationText, isActive && styles.recommendationTextActive]}>{option.label}</Text>
                  </Pressable>
                );
              })}
            </View>

            {validationError && <Text style={styles.validationError}>{validationError}</Text>}

            {!isLocked && (
              <View style={styles.actions}>
                <Pressable style={[styles.draftButton, isSaving && styles.buttonDisabled]} onPress={handleSaveDraft} disabled={isSaving || isSubmitting}>
                  {isSaving ? <ActivityIndicator color="#062B59" /> : <Text style={styles.draftButtonText}>Save as Draft</Text>}
                </Pressable>
                <Pressable style={[styles.submitButton, isSubmitting && styles.buttonDisabled]} onPress={handlePressSubmit} disabled={isSaving || isSubmitting}>
                  {isSubmitting ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.submitButtonText}>Submit Evaluation</Text>}
                </Pressable>
              </View>
            )}
          </AestheticScrollView>
        )}
      </SafeAreaView>

      <Modal visible={showConfirm} transparent animationType="fade" onRequestClose={() => setShowConfirm(false)}>
        <View style={styles.confirmOverlay}>
          <View style={styles.confirmCard}>
            <Text style={styles.confirmTitle}>Submit Evaluation?</Text>
            <Text style={styles.confirmMessage}>
              Once submitted, this evaluation cannot be edited. Admin will be notified to review it and make the final regularization decision.
            </Text>
            <View style={styles.confirmActions}>
              <Pressable style={styles.confirmCancelButton} onPress={() => setShowConfirm(false)}>
                <Text style={styles.confirmCancelText}>Review Again</Text>
              </Pressable>
              <Pressable style={styles.confirmSubmitButton} onPress={handleConfirmSubmit}>
                <Text style={styles.confirmSubmitText}>Confirm & Submit</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <ResultModal
        visible={!!resultModal}
        status={resultModal?.status ?? "info"}
        title={resultModal?.title ?? ""}
        message={resultModal?.message ?? ""}
        onClose={handleCloseResult}
      />
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#FFFFFF" },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#E2E8F0",
  },
  headerButton: { minWidth: 40, paddingVertical: 4, paddingHorizontal: 4 },
  headerButtonPressed: { opacity: 0.6 },
  headerTitle: { fontSize: 17, fontWeight: "700", color: "#062B59" },
  headerSubtitle: { fontSize: 13, color: "#64748B", marginTop: 1 },
  content: { padding: 16, paddingBottom: 32, gap: 6 },
  submittedBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#ECFDF3",
    borderRadius: 12,
    padding: 12,
    marginBottom: 14,
  },
  submittedBannerText: { flex: 1, fontSize: 12.5, color: "#15803D", fontWeight: "600" },
  field: { marginBottom: 18 },
  label: { fontSize: 13.5, fontWeight: "700", color: "#062B59", marginBottom: 8 },
  segmentedDisabled: { opacity: 0.6 },
  divider: { height: 1, backgroundColor: "#E2E8F0", marginVertical: 8 },
  textArea: {
    minHeight: 90,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 12,
    padding: 12,
    fontSize: 13.5,
    textAlignVertical: "top",
    color: "#0F172A",
  },
  recommendationOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
  },
  recommendationOptionActive: { borderColor: "#062B59", backgroundColor: "#F0F7FF" },
  radioOuter: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: "#CBD5E1",
    alignItems: "center",
    justifyContent: "center",
  },
  radioOuterActive: { borderColor: "#062B59" },
  radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: "#062B59" },
  recommendationText: { flex: 1, fontSize: 13, color: "#334155", fontWeight: "600" },
  recommendationTextActive: { color: "#062B59" },
  validationError: { fontSize: 12.5, color: "#DC2626", fontWeight: "600", marginBottom: 12 },
  actions: { flexDirection: "row", gap: 10, marginTop: 8 },
  draftButton: { flex: 1, height: 50, borderRadius: 14, borderWidth: 1, borderColor: "#062B59", alignItems: "center", justifyContent: "center" },
  draftButtonText: { color: "#062B59", fontWeight: "700", fontSize: 14 },
  submitButton: { flex: 1, height: 50, borderRadius: 14, backgroundColor: "#062B59", alignItems: "center", justifyContent: "center" },
  submitButtonText: { color: "#FFFFFF", fontWeight: "700", fontSize: 14 },
  buttonDisabled: { opacity: 0.7 },
  confirmOverlay: { flex: 1, backgroundColor: "rgba(6, 43, 89, 0.55)", justifyContent: "center", alignItems: "center", padding: 24 },
  confirmCard: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: "#FFFFFF",
    borderRadius: 22,
    padding: 24,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.2,
    shadowRadius: 20,
    elevation: 10,
  },
  confirmTitle: { fontSize: 18, fontWeight: "700", color: "#062B59", marginBottom: 8, textAlign: "center" },
  confirmMessage: { fontSize: 13.5, color: "#475569", textAlign: "center", lineHeight: 20, marginBottom: 20 },
  confirmActions: { flexDirection: "row", gap: 10 },
  confirmCancelButton: { flex: 1, height: 48, borderRadius: 12, borderWidth: 1, borderColor: "#E2E8F0", alignItems: "center", justifyContent: "center" },
  confirmCancelText: { color: "#334155", fontWeight: "700", fontSize: 13.5 },
  confirmSubmitButton: { flex: 1, height: 48, borderRadius: 12, backgroundColor: "#062B59", alignItems: "center", justifyContent: "center" },
  confirmSubmitText: { color: "#FFFFFF", fontWeight: "700", fontSize: 13.5 },
});
