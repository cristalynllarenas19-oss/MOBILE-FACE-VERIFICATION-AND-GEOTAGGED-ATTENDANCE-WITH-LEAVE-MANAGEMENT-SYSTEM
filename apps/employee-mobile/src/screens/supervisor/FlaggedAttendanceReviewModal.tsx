import React, { useState } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";

import AestheticScrollView from "../../components/AestheticScrollView";
import StatusPill from "../../components/StatusPill";
import { ZoomableImage } from "../../components/ZoomableImage";
import { FlaggedAttendanceLog, reviewFlaggedAttendanceLog } from "../../api";
import { ui } from "../../styles/ui";

const LOG_TYPE_LABELS: Record<FlaggedAttendanceLog["logType"], string> = {
  TIME_IN: "Time In",
  TIME_OUT: "Time Out",
  LUNCH_OUT: "Start Lunch",
  LUNCH_IN: "End Lunch",
};

// Face profiles are stored as whatever the enrolling client uploaded, which
// is a full data: URI from admin-web's face registration — but a bare
// base64 payload from an older row still has to render, so the prefix is
// added here instead of showing a broken image.
function toImageUri(data?: string | null, mimeType?: string | null) {
  if (!data) return null;
  if (data.startsWith("data:")) return data;
  return `data:${mimeType ?? "image/jpeg"};base64,${data}`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

// The phone-side twin of admin-web's AttendanceDetailsModal for a flagged
// row: the same registered-vs-captured comparison, the same match score and
// verification details, and the same two decisions — validate the attempt as
// genuine attendance, or tag it as a fake attendance attempt.
export default function FlaggedAttendanceReviewModal({
  log,
  onClose,
  onResolved,
}: {
  log: FlaggedAttendanceLog | null;
  onClose: () => void;
  onResolved: (decision: "validate" | "reject", title: string, message: string) => void;
}) {
  const [remarks, setRemarks] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const [previewUri, setPreviewUri] = useState<string | null>(null);

  // Remarks are per-attempt — a note typed for one flagged log must never
  // carry over to the next one opened.
  React.useEffect(() => {
    setRemarks("");
    setError("");
  }, [log?.id]);

  if (!log) return null;

  const registeredUri = toImageUri(log.employee.faceProfiles?.[0]?.referenceImageData);
  const capturedUri = toImageUri(log.faceImageData, log.faceImageMimeType);
  const captureLabel = `${LOG_TYPE_LABELS[log.logType]} Capture`;
  const mapQuery = `${log.latitude},${log.longitude}`;

  async function decide(decision: "validate" | "reject") {
    if (!log) return;
    setIsSaving(true);
    setError("");
    try {
      await reviewFlaggedAttendanceLog(log.id, decision, remarks);
      const suffix = remarks.trim() ? ` Remarks noted: ${remarks.trim()}` : "";
      onResolved(
        decision,
        decision === "validate" ? "Attempt Validated" : "Marked as Fake Attempt",
        decision === "validate"
          ? `Attendance attempt was validated and recorded.${suffix}`
          : `Attendance attempt was tagged as a fake attendance attempt.${suffix}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to review this attendance attempt.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <>
      <Modal visible transparent animationType="fade" onRequestClose={onClose}>
        <View style={ui.modalOverlay}>
          <View style={ui.modalCard}>
            <View style={styles.header}>
              <View style={{ flex: 1 }}>
                <Text style={styles.title}>Attendance Details</Text>
                <Text style={styles.subtitle}>
                  {new Date(log.attendanceDate ?? log.capturedAt).toLocaleDateString("en-US", {
                    month: "long",
                    day: "numeric",
                    year: "numeric",
                  })}
                </Text>
              </View>
              <Pressable onPress={onClose} hitSlop={10} disabled={isSaving}>
                <Ionicons name="close" size={22} color="#64748B" />
              </Pressable>
            </View>

            <View style={styles.banner}>
              <Ionicons name="warning-outline" size={16} color="#B45309" />
              <Text style={styles.bannerText}>
                Face did not match the enrolled profile for this account. Compare the registered photo against the
                captured photo before deciding.
              </Text>
            </View>

            <AestheticScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
              <View style={styles.compareRow}>
                <View style={styles.compareItem}>
                  <Text style={styles.compareCaption}>Registered Face</Text>
                  {registeredUri ? (
                    <Pressable onPress={() => setPreviewUri(registeredUri)}>
                      <Image source={{ uri: registeredUri }} style={styles.comparePhoto} resizeMode="cover" />
                    </Pressable>
                  ) : (
                    <View style={[styles.comparePhoto, styles.photoEmpty]}>
                      <Text style={styles.photoEmptyText}>Not stored</Text>
                    </View>
                  )}
                </View>
                <View style={styles.compareItem}>
                  <Text style={styles.compareCaption}>{captureLabel}</Text>
                  {capturedUri ? (
                    <Pressable onPress={() => setPreviewUri(capturedUri)}>
                      <Image source={{ uri: capturedUri }} style={styles.comparePhoto} resizeMode="cover" />
                    </Pressable>
                  ) : (
                    <View style={[styles.comparePhoto, styles.photoEmpty]}>
                      <Text style={styles.photoEmptyText}>No photo captured</Text>
                    </View>
                  )}
                </View>
              </View>

              {/* The one number the reviewer is here to judge. */}
              <View style={styles.matchCard}>
                <Text style={styles.matchScore}>
                  {log.faceSimilarityScore ? `${log.faceSimilarityScore}%` : "N/A"}
                </Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.matchLabel}>Face match score</Text>
                  <Text style={styles.matchStatus}>{log.verificationStatus.replace(/_/g, " ")}</Text>
                </View>
              </View>

              <Text style={styles.sectionTitle}>Attempt</Text>
              <View style={styles.detailCard}>
                <Row label="Captured at" value={new Date(log.capturedAt).toLocaleString()} />
                <Row label="Type" value={LOG_TYPE_LABELS[log.logType]} />
                <Row label="Mode" value={log.recordType === "FIELD" ? "Field" : "Non-field"} />
                <Row label="Failure reason" value={log.failureReason ?? "None"} />
              </View>

              <Text style={styles.sectionTitle}>Employee</Text>
              <View style={styles.detailCard}>
                <Row label="Name" value={`${log.employee.firstName} ${log.employee.lastName}`} />
                <Row label="Position" value={log.employee.position?.title ?? "—"} />
                <Row label="Department" value={log.employee.department.name} />
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Status</Text>
                  <StatusPill status="FLAGGED" />
                </View>
              </View>

              <Text style={styles.sectionTitle}>Location</Text>
              <View style={styles.detailCard}>
                <Row label="Site" value={log.workLocation?.name ?? "—"} />
                <Row label="Distance from site" value={`${Math.round(Number(log.distanceFromSiteMeters))}m`} />
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Coordinates</Text>
                  <Pressable
                    style={styles.mapLink}
                    onPress={() =>
                      Linking.openURL(`https://www.google.com/maps?q=${mapQuery}`).catch(() => undefined)
                    }
                  >
                    <Ionicons name="location-outline" size={13} color="#1680D8" />
                    <Text style={styles.mapLinkText} numberOfLines={1}>
                      {Number(log.latitude).toFixed(5)}, {Number(log.longitude).toFixed(5)}
                    </Text>
                  </Pressable>
                </View>
              </View>

              <Text style={styles.sectionTitle}>Remarks</Text>
              <TextInput
                style={styles.remarksInput}
                multiline
                editable={!isSaving}
                placeholder="Optional note recorded with your decision"
                placeholderTextColor="#94A3B8"
                value={remarks}
                onChangeText={setRemarks}
              />

              {!!error && <Text style={styles.errorText}>{error}</Text>}
            </AestheticScrollView>

            <View style={styles.actions}>
              <Pressable
                style={[styles.rejectButton, isSaving && styles.buttonDisabled]}
                disabled={isSaving}
                onPress={() => decide("reject")}
              >
                {isSaving ? (
                  <ActivityIndicator size="small" color="#B91C1C" />
                ) : (
                  <Ionicons name="close-circle-outline" size={16} color="#B91C1C" />
                )}
                <Text style={styles.rejectButtonText}>Reject as Fake Attempt</Text>
              </Pressable>
              <Pressable
                style={[styles.validateButton, isSaving && styles.buttonDisabled]}
                disabled={isSaving}
                onPress={() => decide("validate")}
              >
                {isSaving ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Ionicons name="checkmark-circle-outline" size={16} color="#FFFFFF" />
                )}
                <Text style={styles.validateButtonText}>Validate as Legitimate</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={!!previewUri} transparent animationType="fade" onRequestClose={() => setPreviewUri(null)}>
        <View style={styles.previewOverlay}>
          <BlurView
            intensity={65}
            tint="dark"
            experimentalBlurMethod="dimezisBlurView"
            style={StyleSheet.absoluteFillObject}
          />
          {previewUri && <ZoomableImage uri={previewUri} style={styles.previewMedia} />}
          <Pressable style={styles.previewClose} onPress={() => setPreviewUri(null)} hitSlop={10}>
            <Ionicons name="close" size={22} color="#FFFFFF" />
          </Pressable>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  title: { fontSize: 17, fontWeight: "800", color: "#062B59" },
  subtitle: { fontSize: 12, color: "#64748B", marginTop: 2 },
  banner: {
    flexDirection: "row",
    gap: 8,
    alignItems: "flex-start",
    backgroundColor: "#FFFBEB",
    borderColor: "#FDE68A",
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    marginTop: 12,
  },
  bannerText: { flex: 1, fontSize: 11.5, lineHeight: 16, color: "#92400E" },
  body: { marginTop: 12 },
  bodyContent: { paddingBottom: 8, gap: 10 },
  compareRow: { flexDirection: "row", gap: 10 },
  compareItem: { flex: 1 },
  compareCaption: { fontSize: 11, fontWeight: "700", color: "#475569", marginBottom: 6 },
  comparePhoto: { width: "100%", aspectRatio: 1, borderRadius: 12, backgroundColor: "#F1F5F9" },
  photoEmpty: { alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#E2E8F0" },
  photoEmptyText: { fontSize: 11, color: "#94A3B8", textAlign: "center", paddingHorizontal: 8 },
  matchCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#F8FAFC",
    borderRadius: 14,
    padding: 12,
  },
  matchScore: { fontSize: 24, fontWeight: "800", color: "#062B59" },
  matchLabel: { fontSize: 12, color: "#475569", fontWeight: "600" },
  matchStatus: { fontSize: 11, color: "#B45309", fontWeight: "700", marginTop: 2 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "800",
    color: "#062B59",
    marginTop: 4,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  detailCard: { backgroundColor: "#F8FAFC", borderRadius: 14, paddingHorizontal: 12, paddingVertical: 4 },
  detailRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#E2E8F0",
  },
  detailLabel: { fontSize: 12, color: "#64748B", fontWeight: "600" },
  detailValue: { flex: 1, fontSize: 12.5, color: "#0F172A", fontWeight: "700", textAlign: "right" },
  mapLink: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 },
  mapLinkText: { fontSize: 12.5, color: "#1680D8", fontWeight: "700" },
  remarksInput: {
    minHeight: 72,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 12,
    padding: 12,
    fontSize: 13,
    color: "#0F172A",
    textAlignVertical: "top",
  },
  errorText: { fontSize: 12, color: "#B91C1C", fontWeight: "600" },
  // Stacked, full width: both labels are too long to sit side by side on a
  // phone without being cut off. Reversed so the primary action is on top.
  actions: { flexDirection: "column-reverse", gap: 8, marginTop: 12 },
  rejectButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 46,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#FCA5A5",
    backgroundColor: "#FEF2F2",
  },
  rejectButtonText: { fontSize: 14, fontWeight: "800", color: "#B91C1C" },
  validateButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 46,
    borderRadius: 14,
    backgroundColor: "#062B59",
  },
  validateButtonText: { fontSize: 14, fontWeight: "800", color: "#FFFFFF" },
  buttonDisabled: { opacity: 0.6 },
  previewOverlay: { flex: 1, alignItems: "center", justifyContent: "center", padding: 16 },
  previewMedia: { flex: 1, width: "100%", borderRadius: 12, backgroundColor: "#FFFFFF" },
  previewClose: {
    position: "absolute",
    top: 46,
    right: 20,
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(15, 23, 42, 0.55)",
  },
});
