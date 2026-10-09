import React, { useMemo } from "react";
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LeaveRequestHistoryEvent } from "../api";

export type TimelineDocument = { label: string; createdAt: string; onPress: () => void; isLoading?: boolean };

// How close a document's own createdAt has to land to a FILED/RESUBMIT_LEAVE
// event's occurredAt to count as "that event's document" — the note and the
// audit-log row are written moments apart in the same request handler, so
// real matches land well under a second apart. Generous enough to survive
// ordinary request latency, tight enough not to misattach a different
// round's document to a step whose own document is missing (e.g. a request
// resubmitted before this archiving behavior existed).
const DOCUMENT_MATCH_TOLERANCE_MS = 5 * 60 * 1000;

function formatTimelineDate(iso: string) {
  const date = new Date(iso);
  return (
    date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    ", " +
    date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  );
}

type TimelineTone = "done" | "current" | "warn" | "danger" | "upcoming";
type TimelineStep = {
  key: string;
  tone: TimelineTone;
  title: string;
  when: string;
  detail: string;
  // Split out from `detail` instead of folded into one run-on sentence —
  // "Revision requested by X. Requirement: Y" wrapped awkwardly mid-phrase
  // at narrow widths. Rendered as its own line so "who did what" and "what's
  // actually needed" are each easy to scan on their own.
  requirement?: string;
  document?: TimelineDocument;
};

const TIMELINE_TONE_STYLE: Record<TimelineTone, { bg: string; fg: string; border: string; line: string }> = {
  done: { bg: "#1680D8", fg: "#FFFFFF", border: "#1680D8", line: "#1680D8" },
  current: { bg: "#E6F2FC", fg: "#1680D8", border: "#1680D8", line: "#E2E8F0" },
  warn: { bg: "#FEF3C7", fg: "#B45309", border: "#FEF3C7", line: "#B45309" },
  danger: { bg: "#FEE2E2", fg: "#B91C1C", border: "#FEE2E2", line: "#E2E8F0" },
  upcoming: { bg: "#FFFFFF", fg: "#94A3B8", border: "#E2E8F0", line: "#E2E8F0" },
};

const TIMELINE_TONE_ICON: Record<TimelineTone, keyof typeof Ionicons.glyphMap> = {
  done: "checkmark",
  current: "time-outline",
  warn: "alert",
  danger: "close",
  upcoming: "ellipse",
};

// One row per audit event, in the order they actually happened — every pass
// through the reject/resubmit loop (and every cancellation step) gets its
// own dated row instead of only the latest cycle being visible. A trailing
// "current" row is appended while something is still awaiting a reviewer's
// action (PENDING/CANCELLATION_PENDING); NEEDS_REVISION doesn't get one
// since the resubmit affordance right below the timeline already makes clear
// the ball is in the employee's court.
// Kept in lockstep with admin-web's LeaveTimeline (features/leave and
// employee-portal) — same fields, same per-action mapping — so every app
// that shows a request's history agrees on where it stands.
function eventToStep(event: LeaveRequestHistoryEvent, index: number): TimelineStep {
  const when = formatTimelineDate(event.occurredAt);
  const by = event.actorName ? ` by ${event.actorName}` : "";

  switch (event.action) {
    case "FILED":
      return { key: `filed-${index}`, tone: "done", title: "Filed", when, detail: `Submitted${by}.` };
    case "SUPERVISOR_APPROVE_LEAVE":
      return { key: `supervisor-${index}`, tone: "done", title: "Supervisor review", when, detail: `Approved${by}.` };
    case "APPROVE_LEAVE":
      return { key: `approve-${index}`, tone: "done", title: "Approved", when, detail: `Approved${by}.` };
    case "REJECT_LEAVE": {
      const isRevision = event.status === "NEEDS_REVISION";
      return {
        key: `reject-${index}`,
        tone: isRevision ? "warn" : "danger",
        title: isRevision ? "Additional requirements requested" : "Rejected",
        when,
        detail: `${isRevision ? "Revision requested" : "Rejected"}${by}.${event.remarks ? ` "${event.remarks}"` : ""}`,
        requirement: event.requirementDetails ?? undefined,
      };
    }
    case "RESUBMIT_LEAVE":
      return {
        key: `resubmit-${index}`,
        tone: "done",
        title: "Resubmitted",
        when,
        detail: `Resubmitted${by}.${event.remarks ? ` "${event.remarks}"` : ""}`,
      };
    case "REQUEST_CANCEL_LEAVE":
      return {
        key: `request-cancel-${index}`,
        tone: "warn",
        title: "Cancellation requested",
        when,
        detail: `Requested${by}.${event.remarks ? ` "${event.remarks}"` : ""}`,
      };
    case "APPROVE_CANCEL_LEAVE":
    case "CANCEL_LEAVE":
      return { key: `cancelled-${index}`, tone: "danger", title: "Cancelled", when, detail: `Cancelled${by}.` };
    case "DENY_CANCEL_LEAVE":
      return {
        key: `deny-cancel-${index}`,
        tone: "warn",
        title: "Cancellation denied",
        when,
        detail: `This leave remains approved.${event.remarks ? ` "${event.remarks}"` : ""}`,
      };
    default:
      return { key: `event-${index}`, tone: "done", title: event.action, when, detail: `${by}.` };
  }
}

// Each round's document is filed exactly once — at the original FILED event
// or at the RESUBMIT_LEAVE that followed a rejection — so walking events in
// order and handing out `documents` (already in that same chronological
// order, see getRequestDocuments in LeaveScreen.tsx) one-per-submission-event
// attaches each file to the step where it actually entered the record,
// instead of listing them separately above the timeline.
function buildTimelineSteps(
  history: LeaveRequestHistoryEvent[],
  status: string,
  documents: TimelineDocument[],
): TimelineStep[] {
  const events = [...history].sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime());
  // Matched by nearest timestamp rather than position: a request resubmitted
  // before the backend started archiving the pre-resubmit attachment is
  // missing one round's document entirely, and matching by position alone
  // would shift every later round's document onto the wrong step. Each
  // document is consumed at most once.
  const unmatchedDocs = [...documents];
  const steps = events.map((event, index) => {
    const step = eventToStep(event, index);
    if (event.action === "FILED" || event.action === "RESUBMIT_LEAVE") {
      const eventTime = new Date(event.occurredAt).getTime();
      let bestIndex = -1;
      let bestDiff = Infinity;
      unmatchedDocs.forEach((doc, docIndex) => {
        const diff = Math.abs(new Date(doc.createdAt).getTime() - eventTime);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestIndex = docIndex;
        }
      });
      if (bestIndex !== -1 && bestDiff <= DOCUMENT_MATCH_TOLERANCE_MS) {
        step.document = unmatchedDocs[bestIndex];
        unmatchedDocs.splice(bestIndex, 1);
      }
    }
    return step;
  });

  if (status === "PENDING") {
    steps.push({ key: "review-current", tone: "current", title: "Review", when: "In progress", detail: "Awaiting review from your supervisor or HR." });
  } else if (status === "CANCELLATION_PENDING") {
    steps.push({ key: "cancel-current", tone: "current", title: "Cancellation decision", when: "In progress", detail: "Awaiting your supervisor's decision." });
  }

  return steps;
}

export default function LeaveTimeline({
  history,
  status,
  documents,
}: {
  history?: LeaveRequestHistoryEvent[];
  status: string;
  documents?: TimelineDocument[];
}) {
  const steps = useMemo(() => buildTimelineSteps(history ?? [], status, documents ?? []), [history, status, documents]);
  return (
    <View style={styles.timelineWrap}>
      <Text style={styles.timelineLabel}>APPROVAL PROGRESS</Text>
      {steps.map((step, index) => {
        const tone = TIMELINE_TONE_STYLE[step.tone];
        return (
          <View key={step.key} style={styles.timelineStep}>
            <View style={styles.timelineRail}>
              <View style={[styles.timelineNode, { backgroundColor: tone.bg, borderColor: tone.border }]}>
                <Ionicons name={TIMELINE_TONE_ICON[step.tone]} size={11} color={tone.fg} />
              </View>
              {index < steps.length - 1 && <View style={[styles.timelineLine, { backgroundColor: tone.line }]} />}
            </View>
            <View style={styles.timelineBody}>
              <Text style={styles.timelineWhen}>{step.when}</Text>
              <Text style={[styles.timelineTitle, step.tone === "upcoming" && styles.timelineTitleUpcoming]}>
                {step.title}
              </Text>
              {!!step.detail && (
                <Text
                  style={[
                    styles.timelineDetail,
                    (step.tone === "warn" || step.tone === "danger") && { color: tone.fg },
                  ]}
                >
                  {step.detail}
                </Text>
              )}
              {step.requirement && (
                <Text style={styles.timelineRequirement}>Requirement: {step.requirement}</Text>
              )}
              {step.document && (
                <Pressable
                  style={styles.timelineDocLink}
                  onPress={step.document.onPress}
                  disabled={step.document.isLoading}
                >
                  {step.document.isLoading ? (
                    <ActivityIndicator size="small" color="#1680D8" />
                  ) : (
                    <Ionicons name="attach-outline" size={13} color="#1680D8" />
                  )}
                  <Text style={styles.timelineDocLinkText}>{step.document.label}</Text>
                </Pressable>
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  timelineWrap: { marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: "#E2E8F0" },
  timelineLabel: { fontSize: 10.5, fontWeight: "700", letterSpacing: 0.4, color: "#94A3B8", marginBottom: 10 },
  timelineStep: { flexDirection: "row", gap: 10, paddingBottom: 14 },
  // position: "relative" + the line below being absolutely positioned (not
  // flexed) — a flex:1 line inside this column only fills space when RN's
  // stretch sizing gives the rail a determinate height, which it doesn't
  // reliably do here, so the line was rendering as a short stub instead of
  // reaching the next node.
  timelineRail: { width: 18, alignItems: "center", position: "relative" },
  timelineNode: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, alignItems: "center", justifyContent: "center", zIndex: 1 },
  // top: node height, bottom: -paddingBottom of timelineStep — anchors the
  // line from just under this node straight through to the top of the next
  // one regardless of how tall this step's text is.
  timelineLine: { position: "absolute", top: 18, bottom: -14, width: 2 },
  timelineBody: { flex: 1, paddingTop: 1 },
  timelineWhen: { fontSize: 10.5, color: "#94A3B8", marginBottom: 2 },
  timelineTitle: { fontSize: 12.5, fontWeight: "700", color: "#0F172A" },
  timelineTitleUpcoming: { color: "#94A3B8", fontWeight: "600" },
  timelineDetail: { fontSize: 11.5, color: "#64748B", marginTop: 2, lineHeight: 15 },
  timelineRequirement: {
    alignSelf: "flex-start",
    fontSize: 11.5,
    fontWeight: "700",
    color: "#92400E",
    backgroundColor: "#FEF3C7",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginTop: 5,
  },
  timelineDocLink: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 6 },
  timelineDocLinkText: { fontSize: 11.5, fontWeight: "600", color: "#1680D8", textDecorationLine: "underline" },
});
