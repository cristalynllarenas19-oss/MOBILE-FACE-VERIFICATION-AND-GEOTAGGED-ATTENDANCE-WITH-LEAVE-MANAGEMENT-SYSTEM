import React from "react";
import { Text, StyleSheet } from "react-native";

const TONES: Record<string, { color: string; bg: string }> = {
  PRESENT: { color: "#15803D", bg: "#DCFCE7" },
  APPROVED: { color: "#15803D", bg: "#DCFCE7" },
  SUPERVISOR_APPROVED: { color: "#0369A1", bg: "#E0F2FE" },
  LATE: { color: "#B45309", bg: "#FEF3C7" },
  PENDING: { color: "#B45309", bg: "#FEF3C7" },
  PENDING_REVIEW: { color: "#B45309", bg: "#FEF3C7" },
  ABSENT: { color: "#B91C1C", bg: "#FEE2E2" },
  REJECTED: { color: "#B91C1C", bg: "#FEE2E2" },
  CANCELLED: { color: "#B91C1C", bg: "#FEE2E2" },
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
};

export default function StatusPill({ status }: { status: string }) {
  const tone = TONES[status] ?? DEFAULT_TONE;
  return (
    <Text style={[styles.pill, { color: tone.color, backgroundColor: tone.bg }]} numberOfLines={1}>
      {LABEL_OVERRIDES[status] ?? status.replace(/_/g, " ")}
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
  },
});
