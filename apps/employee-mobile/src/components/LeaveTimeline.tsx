import React, { useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LeaveRequestHistoryEvent } from "../api";

function formatTimelineDate(iso: string) {
  const date = new Date(iso);
  return (
    date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    ", " +
    date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  );
}

type TimelineTone = "done" | "current" | "warn" | "danger" | "upcoming";
type TimelineStep = { key: string; tone: TimelineTone; title: string; when: string; detail: string };

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
        detail: `${isRevision ? "Revision requested" : "Rejected"}${by}.${event.requirementDetails ? ` Requirement: ${event.requirementDetails}` : ""}${event.remarks ? ` "${event.remarks}"` : ""}`,
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

function buildTimelineSteps(history: LeaveRequestHistoryEvent[], status: string): TimelineStep[] {
  const events = [...history].sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime());
  const steps = events.map(eventToStep);

  if (status === "PENDING") {
    steps.push({ key: "review-current", tone: "current", title: "Review", when: "In progress", detail: "Awaiting review from your supervisor or HR." });
  } else if (status === "CANCELLATION_PENDING") {
    steps.push({ key: "cancel-current", tone: "current", title: "Cancellation decision", when: "In progress", detail: "Awaiting your supervisor's decision." });
  }

  return steps;
}

export default function LeaveTimeline({ history, status }: { history?: LeaveRequestHistoryEvent[]; status: string }) {
  const steps = useMemo(() => buildTimelineSteps(history ?? [], status), [history, status]);
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
});
