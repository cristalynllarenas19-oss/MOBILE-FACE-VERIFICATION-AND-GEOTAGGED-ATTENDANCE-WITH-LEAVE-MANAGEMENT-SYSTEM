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
import {
  FlaggedAttendanceLog,
  PreviousFlaggedAttempt,
  getPreviousFlaggedAttempts,
  reviewFlaggedAttendanceLog,
} from "../../api";
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

// "1st", "2nd", "3rd" — which same-day failed attempt a capture was.
function ordinal(value: number) {
  const suffix = value % 100 >= 11 && value % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][value % 10] ?? "th";
  return `${value}${suffix}`;
}

// Same rule as admin-web's getPositionLabel: a Supervisor or Admin shows
// their highest role rather than their position title; everyone else shows
// their position, or plain "Employee" when none is assigned.
function positionLabel(employee: FlaggedAttendanceLog["employee"]) {
  const roleCodes = employee.user?.userRoles.map((userRole) => userRole.role.code) ?? [];
  if (roleCodes.includes("ADMIN")) return "Admin";
  if (roleCodes.includes("SUPERVISOR")) return "Supervisor";
  return employee.position?.title ?? "Employee";
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

  // The queue only lists the latest failed attempt; the earlier same-day
  // ones it superseded are fetched here (oldest first) so the reviewer can
  // still flip back to them. null = showing the latest.
  const [previousAttempts, setPreviousAttempts] = useState<PreviousFlaggedAttempt[]>([]);
  const [viewedAttempt, setViewedAttempt] = useState<number | null>(null);
  React.useEffect(() => {
    setPreviousAttempts([]);
    setViewedAttempt(null);
    if (!log?.id) return;
    let cancelled = false;
    getPreviousFlaggedAttempts(log.id)
      .then((attempts) => {
        if (!cancelled) setPreviousAttempts(attempts);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [log?.id]);

  if (!log) return null;

  // Whichever attempt is on screen. The decision buttons always act on the
  // latest one (`log`) — that is the attempt still awaiting review.
  const shown = (viewedAttempt !== null ? previousAttempts[viewedAttempt] : undefined) ?? log;
  const latestAttemptNumber = previousAttempts.length + 1;
  const attemptLabel =
    viewedAttempt !== null ? `${ordinal(viewedAttempt + 1)} attempt` : `${ordinal(latestAttemptNumber)} attempt · Latest`;

  const registeredUri = toImageUri(log.employee.faceProfiles?.[0]?.referenceImageData);
  const capturedUri = toImageUri(shown.faceImageData, shown.faceImageMimeType);
  const captureLabel = `${LOG_TYPE_LABELS[shown.logType]} Capture`;
  const mapQuery = `${shown.latitude},${shown.longitude}`;

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

            <AestheticScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
              {previousAttempts.length > 0 && (
                <View style={styles.attemptRow}>
                  {previousAttempts.map((attempt, index) => (
                    <Pressable
                      key={attempt.id}
                      style={[ui.filterChip, viewedAttempt === index && ui.filterChipActive]}
                      onPress={() => setViewedAttempt(index)}
                    >
                      <Text style={[ui.filterChipText, viewedAttempt === index && ui.filterChipTextActive]}>
                        {ordinal(index + 1)} attempt
                      </Text>
                    </Pressable>
                  ))}
                  <Pressable
                    style={[ui.filterChip, viewedAttempt === null && ui.filterChipActive]}
                    onPress={() => setViewedAttempt(null)}
                  >
                    <Text style={[ui.filterChipText, viewedAttempt === null && ui.filterChipTextActive]}>
                      {ordinal(latestAttemptNumber)} attempt
                    </Text>
                  </Pressable>
                </View>
              )}

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
                  {shown.faceSimilarityScore ? `${shown.faceSimilarityScore}%` : "N/A"}
                </Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.matchLabel}>Face match score · {attemptLabel}</Text>
                  <Text style={styles.matchStatus}>{shown.verificationStatus.replace(/_/g, " ")}</Text>
                </View>
              </View>

              <Text style={styles.sectionTitle}>Attempt</Text>
              <View style={styles.detailCard}>
                <Row label="Attempt" value={attemptLabel} />
                <Row label="Captured at" value={new Date(shown.capturedAt).toLocaleString()} />
                <Row label="Type" value={LOG_TYPE_LABELS[shown.logType]} />
                <Row label="Mode" value={log.recordType === "FIELD" ? "Field" : "Non-field"} />
                <Row label="Failure reason" value={shown.failureReason ?? "None"} />
              </View>

              <Text style={styles.sectionTitle}>Employee</Text>
              <View style={styles.detailCard}>
                <Row label="Name" value={`${log.employee.firstName} ${log.employee.lastName}`} />
                <Row label="Position" value={positionLabel(log.employee)} />
                <Row label="Department" value={log.employee.department.name} />
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Status</Text>
                  <StatusPill status="FLAGGED" />
                </View>
              </View>

              <Text style={styles.sectionTitle}>Location</Text>
              <View style={styles.detailCard}>
                <Row label="Site" value={log.workLocation?.name ?? "—"} />
                <Row label="Distance from site" value={`${Math.round(Number(shown.distanceFromSiteMeters))}m`} />
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
                      {Number(shown.latitude).toFixed(5)}, {Number(shown.longitude).toFixed(5)}
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
  body: { marginTop: 12 },
  bodyContent: { paddingBottom: 8, gap: 10 },
  attemptRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
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
