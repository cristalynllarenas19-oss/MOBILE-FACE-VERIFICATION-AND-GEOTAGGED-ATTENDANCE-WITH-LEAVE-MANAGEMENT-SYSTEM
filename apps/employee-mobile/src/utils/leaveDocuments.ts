import { LeaveRequest } from "../api";

export type LeaveDocument = {
  key: string;
  label: string;
  createdAt: string;
  noteId?: string;
  kind: "submission" | "cancellation";
};

// A request can cycle through reject -> resubmit any number of times; the
// backend only keeps the latest attachment on the request row itself, but
// archives every prior round as a RESUBMITTED note (see resubmit() in
// leave.service.ts), so the full document trail is reconstructed here from
// that note history instead of only ever showing the single current file.
// `createdAt` is carried through so LeaveTimeline can line each document up
// with the timeline step it actually belongs to by timestamp rather than by
// position — a request resubmitted before the archiving behavior above
// shipped only has the later round's document, not the original's, and
// matching by position alone would misattach it to the wrong step. Shared by
// LeaveScreen.tsx and NotificationsScreen.tsx so every screen that shows a
// leave request agrees on the same Document 1 / Document 2 / … numbering.
export function getRequestDocuments(request: LeaveRequest): LeaveDocument[] {
  return [...getSubmissionDocuments(request), ...getCancellationDocuments(request)];
}

// A supporting document sent with a cancellation, kept on its CANCELLED note
// (see cancel() in leave.service.ts) — labelled separately so it never shifts
// the Document 1 / Document 2 / … numbering of the filing rounds.
function getCancellationDocuments(request: LeaveRequest): LeaveDocument[] {
  return (request.notes ?? [])
    .filter((n) => n.type === "CANCELLED" && n.attachmentName)
    .map((n) => ({
      key: n.id,
      label: "Cancellation Document",
      createdAt: n.createdAt,
      noteId: n.id,
      kind: "cancellation" as const,
    }));
}

function getSubmissionDocuments(request: LeaveRequest): LeaveDocument[] {
  const resubmissionNotes = (request.notes ?? [])
    .filter((n) => n.type === "RESUBMITTED" && n.attachmentName)
    .slice()
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  if (resubmissionNotes.length > 0) {
    return resubmissionNotes.map((n, index) => ({
      key: n.id,
      label: `Document ${index + 1}`,
      createdAt: n.createdAt,
      noteId: n.id,
      kind: "submission" as const,
    }));
  }

  if (request.attachmentName) {
    return [{ key: "current", label: "Document 1", createdAt: request.createdAt, kind: "submission" }];
  }

  return [];
}
