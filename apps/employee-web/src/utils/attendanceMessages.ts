const FRIENDLY_REASONS: Record<string, string> = {
  "GPS accuracy is too low": "Your location signal is too weak. Move to an open area and try again.",
  "Employee is outside the approved work location": "You're outside your assigned work area. Move closer and try again.",
  "No face detected in the captured photo. Please retake in good lighting.":
    "We couldn't find a face in the photo. Make sure you're well-lit and facing the camera, then try again.",
  "Face does not match enrolled profile":
    "We couldn't verify your identity. Try again with clear lighting and your face centered in the frame.",
  "Borderline face match requires HR review": "Your face match was inconclusive, so this attendance has been sent to HR for review.",
  "Liveness check failed": "We couldn't confirm a live face. Please try again.",
};

export function getFriendlyReason(reason: string | null | undefined, verificationStatus: string) {
  if (reason && FRIENDLY_REASONS[reason]) return FRIENDLY_REASONS[reason];
  if (reason) return reason;
  if (verificationStatus === "APPROVED") return "Your face was verified and you're within your assigned work area.";
  return "Please try again.";
}
