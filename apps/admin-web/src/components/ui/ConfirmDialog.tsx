import { AlertTriangle } from "lucide-react";
import "./ConfirmDialog.css";

export type ConfirmDialogConfig = {
  title: string;
  description: string;
  confirmLabel: string;
  tone?: "danger" | "primary";
  onConfirm: () => void;
};

export function ConfirmDialog({
  config,
  onCancel,
}: {
  config: ConfirmDialogConfig;
  onCancel: () => void;
}) {
  const tone = config.tone ?? "danger";

  return (
    <div className="confirm-dialog-backdrop" role="presentation" onClick={onCancel}>
      <section
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`confirm-dialog-icon-wrap ${tone}`}>
          <AlertTriangle size={26} strokeWidth={2} />
        </div>
        <h2 id="confirm-dialog-title" className="confirm-dialog-title">
          {config.title}
        </h2>
        <p className="confirm-dialog-description">{config.description}</p>

        <div className="confirm-dialog-footer">
          <button type="button" className="confirm-dialog-cancel-button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={`confirm-dialog-confirm-button ${tone}`}
            onClick={() => {
              config.onConfirm();
              onCancel();
            }}
          >
            {config.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
