import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import "./FormSelectDropdown.css";

export type FormSelectDropdownOption = { value: string; label: string };

// A drop-in replacement for a plain <select> inside a form field, used where
// the native select's browser-controlled popup (which can open upward and
// overlap the fields above it, with no way to fix that via CSS) needs to
// reliably open downward, directly under the field, and stay confined to
// its scrollable parent (e.g. a modal form) instead of escaping it.
//
// Deliberately NOT portaled to <body> the way DropdownFilter is — that
// component intentionally escapes clipping ancestors (chart cards with
// overflow:hidden) so its menu is never cut off. Here the opposite is
// wanted: the menu stays a normal descendant of this field, so if there's
// no room below within the modal's own scroll area, the menu is clipped by
// that scroll container and the user scrolls the form to reach it, rather
// than the menu flipping upward over the fields above.
export function FormSelectDropdown({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: FormSelectDropdownOption[];
  placeholder: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleOutside(event: MouseEvent) {
      if (shellRef.current && !shellRef.current.contains(event.target as Node)) setOpen(false);
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleOutside);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const selected = options.find((option) => option.value === value);

  return (
    <div className="form-select-dropdown" ref={shellRef}>
      <button
        type="button"
        className="form-select-dropdown-trigger"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={selected ? undefined : "form-select-dropdown-placeholder"}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown size={15} className={`form-select-dropdown-chevron${open ? " open" : ""}`} />
      </button>

      {open && (
        <div className="form-select-dropdown-menu" role="listbox">
          {options.map((option) => (
            <button
              type="button"
              key={option.value}
              role="option"
              aria-selected={value === option.value}
              className={`form-select-dropdown-option${value === option.value ? " active" : ""}`}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
