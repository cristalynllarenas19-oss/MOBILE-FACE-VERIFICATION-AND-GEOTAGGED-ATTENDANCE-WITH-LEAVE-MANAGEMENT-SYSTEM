import { useMemo } from "react";

export type TimelineDocument = { label: string; createdAt: string; onPress: () => void; isLoading?: boolean };

// How close a document's own createdAt has to land to a FILED/RESUBMIT_LEAVE
// event's occurredAt to count as "that event's document" — the note and the
// audit-log row are written moments apart in the same request handler, so
// real matches land well under a second apart. Generous enough to survive
// ordinary request latency, tight enough not to misattach a different
// round's document to a step whose own document is missing (e.g. a request
// resubmitted before this archiving behavior existed).
const DOCUMENT_MATCH_TOLERANCE_MS = 5 * 60 * 1000;

// Kept structurally identical to employee-mobile's LeaveRequestHistoryEvent
// (see api.ts there and buildHistory in backend/leave.service.ts) — every
// screen that shows a leave request's history reads the same shape.
export type LeaveRequestHistoryEvent = {
  action:
    | "FILED"
    | "SUPERVISOR_APPROVE_LEAVE"
    | "APPROVE_LEAVE"
    | "REJECT_LEAVE"
    | "RESUBMIT_LEAVE"
    | "CANCEL_LEAVE"
    | "REQUEST_CANCEL_LEAVE"
    | "APPROVE_CANCEL_LEAVE"
    | "DENY_CANCEL_LEAVE";
  status: string | null;
  actorName: string | null;
  occurredAt: string;
  remarks: string | null;
  requirementDetails: string | null;
};

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
  // rendered as its own line so "who did what" and "what's actually
  // needed" are each easy to scan on their own.
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

const TIMELINE_TONE_SYMBOL: Record<TimelineTone, string> = {
  done: "✓",
  current: "···",
  warn: "!",
  danger: "×",
  upcoming: "",
};

// One row per audit event, in the order they actually happened — every pass
// through the reject/resubmit loop (and every cancellation step) gets its
// own dated row instead of only the latest cycle being visible. A trailing
// "current" row is appended while something is still awaiting a reviewer's
// action (PENDING/CANCELLATION_PENDING); NEEDS_REVISION doesn't get one
// since the resubmit affordance right below the timeline already makes clear
// whose turn it is to act.
// Kept in lockstep with employee-mobile's components/LeaveTimeline.tsx —
// same fields, same per-action mapping — so every screen that shows a
// request's history agrees on where it stands.
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
// order) one-per-submission-event attaches each file to the step where it
// actually entered the record, instead of listing them separately.
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
    steps.push({ key: "review-current", tone: "current", title: "Review", when: "In progress", detail: "Awaiting review from the supervisor or HR." });
  } else if (status === "CANCELLATION_PENDING") {
    steps.push({ key: "cancel-current", tone: "current", title: "Cancellation decision", when: "In progress", detail: "Awaiting the supervisor's decision." });
  }

  return steps;
}

export function LeaveTimeline({
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
    <div style={{ marginTop: 14, padding: "12px 24px 0", borderTop: "1px solid #E2E8F0" }}>
      <p style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, color: "#94A3B8", margin: "0 0 10px" }}>
        APPROVAL PROGRESS
      </p>
      {steps.map((step, index) => {
        const tone = TIMELINE_TONE_STYLE[step.tone];
        return (
          <div key={step.key} style={{ display: "flex", gap: 10, paddingBottom: 14 }}>
            {/* position:relative + the connector below being absolutely
                positioned (not flexed) — a flex:1 line only fills the gap
                when the rail's own height is determinate, which broke down
                for short-content steps and rendered as a stub instead of
                reaching the next node. */}
            <div style={{ width: 18, position: "relative" }}>
              <div
                style={{
                  width: 18, height: 18, borderRadius: 9, flexShrink: 0, position: "relative", zIndex: 1,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: tone.bg, border: `2px solid ${tone.border}`,
                  color: tone.fg, fontSize: 10, fontWeight: 700, lineHeight: 1,
                }}
              >
                {TIMELINE_TONE_SYMBOL[step.tone]}
              </div>
              {index < steps.length - 1 && (
                <div style={{ position: "absolute", top: 18, bottom: -14, left: 8, width: 2, background: tone.line }} />
              )}
            </div>
            <div style={{ flex: 1, paddingTop: 1 }}>
              <div style={{ fontSize: 10.5, color: "#94A3B8", marginBottom: 2 }}>{step.when}</div>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: step.tone === "upcoming" ? "#94A3B8" : "#0F172A" }}>
                {step.title}
              </div>
              {!!step.detail && (
                <p
                  style={{
                    fontSize: 11.5, margin: "2px 0 0", lineHeight: "15px",
                    color: step.tone === "warn" || step.tone === "danger" ? tone.fg : "#64748B",
                  }}
                >
                  {step.detail}
                </p>
              )}
              {step.requirement && (
                <p
                  style={{
                    display: "inline-block",
                    fontSize: 11.5, fontWeight: 700, margin: "5px 0 0",
                    color: "#92400E", background: "#FEF3C7",
                    borderRadius: 6, padding: "4px 8px",
                  }}
                >
                  Requirement: {step.requirement}
                </p>
              )}
              {step.document && (
                <button
                  type="button"
                  onClick={step.document.onPress}
                  disabled={step.document.isLoading}
                  style={{
                    display: "flex", alignItems: "center", gap: 4, marginTop: 6,
                    border: "none", background: "none", padding: 0, cursor: step.document.isLoading ? "default" : "pointer",
                    color: "#1680D8", fontSize: 11.5, fontWeight: 600, textDecoration: "underline",
                  }}
                >
                  📎 {step.document.isLoading ? "Loading…" : step.document.label}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
