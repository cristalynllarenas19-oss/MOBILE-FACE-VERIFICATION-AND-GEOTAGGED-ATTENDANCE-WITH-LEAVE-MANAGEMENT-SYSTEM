import { X } from "lucide-react";
import "./ModalCloseButton.css";

// Top-right "X" for centered, header-less dialogs (confirm / notification /
// success cards). The parent dialog must be position: relative.
export function ModalCloseButton({
  onClose,
  disabled,
  label = "Close",
}: {
  onClose: () => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button type="button" className="modal-corner-close" onClick={onClose} disabled={disabled} aria-label={label}>
      <X size={16} />
    </button>
  );
}
