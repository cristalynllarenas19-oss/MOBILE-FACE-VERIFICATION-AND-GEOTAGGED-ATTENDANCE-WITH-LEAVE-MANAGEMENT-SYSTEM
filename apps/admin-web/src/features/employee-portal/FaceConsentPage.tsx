import { useState } from "react";
import { FiCamera, FiCheckCircle, FiLogOut } from "react-icons/fi";
import { acceptFaceConsent } from "../../lib/api";
import "./EmployeePortal.css";
import "./FaceConsentPage.css";

export function FaceConsentPage({
  onAccepted,
  onLogout,
}: {
  onAccepted: (faceConsentAcceptedAt: string) => void;
  onLogout: () => void;
}) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleAccept() {
    setIsLoading(true);
    setError("");
    try {
      const { faceConsentAcceptedAt } = await acceptFaceConsent();
      onAccepted(faceConsentAcceptedAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Please try again.");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="face-consent-page">
      <div className="emp-form-page">
        <div className="face-consent-icon">
          <FiCamera size={28} />
        </div>
        <h1 className="face-consent-title">Face Data Consent</h1>
        <p className="face-consent-subtitle">
          Before your account can be used for attendance, we need your consent to collect and use your facial data.
        </p>

        <div className="emp-card face-consent-card">
          <h2 className="face-consent-card-heading">What this means</h2>
          <ConsentPoint text="Your facial data will be captured by an administrator and stored securely for face verification purposes." />
          <ConsentPoint text="Every time you time in or time out, your face will be scanned and matched against this data to confirm it's really you." />
          <ConsentPoint text="This data is used only for attendance authentication and will not be shared with third parties." />
          <ConsentPoint text="You are not required to capture your own face on this app — an administrator handles face registration on your behalf, but only after you accept this consent." />
        </div>

        <p className="face-consent-disclaimer">
          By clicking "I Agree", you consent to the collection, storage, and use of your facial data for attendance
          verification, in accordance with the Data Privacy Act of 2012.
        </p>

        {error && <p className="face-consent-error">{error}</p>}

        <button className="face-consent-button" onClick={handleAccept} disabled={isLoading}>
          {isLoading ? "Saving..." : "I Agree"}
        </button>

        <button className="face-consent-logout" onClick={onLogout} type="button">
          <FiLogOut size={14} />
          Log out instead
        </button>
      </div>
    </div>
  );
}

function ConsentPoint({ text }: { text: string }) {
  return (
    <div className="face-consent-point">
      <FiCheckCircle size={17} className="face-consent-point-icon" />
      <p>{text}</p>
    </div>
  );
}
