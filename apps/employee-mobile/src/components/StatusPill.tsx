import React from "react";
import { Text, StyleSheet } from "react-native";

const TONES: Record<string, { color: string; bg: string }> = {
  PRESENT: { color: "#15803D", bg: "#DCFCE7" },
  APPROVED: { color: "#15803D", bg: "#DCFCE7" },
  // Same green as APPROVED, not its own blue — the label already reads
  // "Approved" (see LABEL_OVERRIDES below), so the color has to agree with
  // it too. A supervisor reviewing this request and the employee who filed
  // it must see the same color, not just the same text.
  SUPERVISOR_APPROVED: { color: "#15803D", bg: "#DCFCE7" },
  LATE: { color: "#B45309", bg: "#FEF3C7" },
  PENDING: { color: "#B45309", bg: "#FEF3C7" },
  PENDING_REVIEW: { color: "#B45309", bg: "#FEF3C7" },
  ABSENT: { color: "#B91C1C", bg: "#FEE2E2" },
  // Same red as ABSENT — admin-web's getStatusTone() puts FLAGGED and
  // ABSENT in the same "danger" tone, so a flagged attempt reads as the
  // same level of problem in both apps.
  FLAGGED: { color: "#B91C1C", bg: "#FEE2E2" },
  REJECTED: { color: "#B91C1C", bg: "#FEE2E2" },
  // Darker red than REJECTED, not a different color family — still reads as
  // "not approved" but distinct in shade from an outright rejection.
  CANCELLED: { color: "#7F1D1D", bg: "#FEE2E2" },
  LAPSED: { color: "#475569", bg: "#E2E8F0" },
  ON_LEAVE: { color: "#7C3AED", bg: "#EDE9FE" },
  NEEDS_REVISION: { color: "#B45309", bg: "#FEF3C7" },
  CANCELLATION_PENDING: { color: "#B45309", bg: "#FEF3C7" },
};

const DEFAULT_TONE = { color: "#334155", bg: "#F1F5F9" };

// Only these two leave statuses need a label different from a plain
// underscore swap — SUPERVISOR_APPROVED reads as "Approved" (legacy rows
// from the old two-step flow; approval is single-step now) and
// CANCELLATION_PENDING reads clearer reordered — same wording as
// LeaveScreen.tsx and admin-web's Leave pages, so a supervisor and the
// employee they're reviewing always see the same status text.
const LABEL_OVERRIDES: Record<string, string> = {
  SUPERVISOR_APPROVED: "APPROVED",
  CANCELLATION_PENDING: "PENDING CANCELLATION",
  // Reads the same as admin-web's "Flagged – Pending Review" — the status
  // alone ("flagged") does not say that someone still has to decide on it.
  FLAGGED: "FLAGGED - PENDING REVIEW",
};

// lapseReason only matters for LAPSED — it's what tells "the employee came
// to work anyway" apart from "nobody decided, so the days stand as absent".
export default function StatusPill({ status, lapseReason }: { status: string; lapseReason?: string | null }) {
  const tone = TONES[status] ?? DEFAULT_TONE;
  const label =
    status === "LAPSED"
      ? lapseReason === "REPORTED_FOR_WORK"
        ? "LAPSED - REPORTED TO WORK"
        : "LAPSED - ABSENT"
      : LABEL_OVERRIDES[status] ?? status.replace(/_/g, " ");
  return (
    <Text style={[styles.pill, { color: tone.color, backgroundColor: tone.bg }]} numberOfLines={1}>
      {label}
    </Text>
  );
}

const styles = StyleSheet.create({
  pill: {
    fontSize: 11,
    fontWeight: "700",
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: "hidden",
    // Never squeezed by a sibling in the same row — the longest label
    // ("LAPSED - REPORTED TO WORK") would otherwise be cut off with "…".
    flexShrink: 0,
  },
});
