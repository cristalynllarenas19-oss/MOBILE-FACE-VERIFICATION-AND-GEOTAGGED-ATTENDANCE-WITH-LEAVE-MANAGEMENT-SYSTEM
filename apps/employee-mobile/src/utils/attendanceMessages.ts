const FRIENDLY_REASONS: Record<string, string> = {
  "GPS accuracy is too low": "Your location signal is too weak. Move to an open area and try again.",
  "Employee is outside the approved work location": "You're outside your assigned work area. Move closer and try again.",
  "No face detected in the captured photo. Please retake in good lighting.":
    "We couldn't find a face in the photo. Make sure you're well-lit and facing the camera, then try again.",
  "Face does not match enrolled profile":
    "The detected face does not match the registered employee. Please make sure you are the employee assigned to this account.",
  "Borderline face match requires HR review":
    "Your face match was inconclusive, so this attendance has been sent to HR for review.",
  "Liveness check failed": "We couldn't confirm a live face. Please try again.",
};

export function getFriendlyReason(reason: string | null | undefined, verificationStatus: string) {
  if (reason && FRIENDLY_REASONS[reason]) {
    return FRIENDLY_REASONS[reason];
  }
  if (reason) {
    return reason;
  }
  if (verificationStatus === "APPROVED") {
    return "Your face was verified and you're within your assigned work area.";
  }
  return "Please try again.";
}

// Copy for a flagged (PENDING_REVIEW — borderline face match) attempt,
// keyed by how many such attempts the employee has had today (including
// this one). Escalates in tone as the same-day count climbs toward the
// backend's FLAGGED_NOTIFY_THRESHOLD (3), where the supervisor is actually
// notified — see AttendanceService.submit()/recordFlaggedAttempt().
export function getFlaggedAttemptMessage(actionLabel: string, flaggedAttemptCount: number | null | undefined) {
  if (flaggedAttemptCount === 2) {
    return {
      title: "Still Unable to Confirm",
      message:
        "This is your 2nd unclear attempt today. One more, and your supervisor will be notified to review this attendance. Try again in better lighting.",
    };
  }

  if (flaggedAttemptCount && flaggedAttemptCount >= 3) {
    return {
      title: "Supervisor Notified",
      message:
        "This is your 3rd unclear attempt today. Your supervisor has been notified and will need to review and approve this attendance manually.",
    };
  }

  return {
    title: `${actionLabel} Pending Review`,
    message: "We couldn't clearly confirm it's you. Please make sure you're well-lit and facing the camera, then try again.",
  };
}
