import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, X } from "lucide-react";
import "./DropdownFilter.css";

export type MultiSelectOption = { value: string; label: string };

// Same portal/fixed-positioning approach as DropdownFilter (see that file for
// why: keeps the menu from being clipped by an ancestor modal/card, and lets
// it float above the layout instead of pushing content down when opened).
// This variant checks multiple options at once instead of picking one.
export function MultiSelectDropdown({
  values,
  options,
  onChange,
  placeholder,
  menuLabel,
  ariaLabel,
  className = "",
}: {
  values: string[];
  options: MultiSelectOption[];
  onChange: (values: string[]) => void;
  placeholder: string;
  menuLabel: string;
  ariaLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number; minWidth: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (shellRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    function updatePosition() {
      const rect = shellRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.max(220, rect.width);
      const left = Math.min(rect.left, window.innerWidth - width - 8);
      setMenuPosition({ top: rect.bottom + 6, left: Math.max(8, left), minWidth: width });
    }
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  const selectedSet = new Set(values);
  const isFiltered = values.length > 0;
  const triggerLabel = !isFiltered
    ? placeholder
    : values.length === 1
      ? options.find((option) => option.value === values[0])?.label ?? placeholder
      : `${values.length} selected`;

  function toggle(value: string) {
    onChange(selectedSet.has(value) ? values.filter((v) => v !== value) : [...values, value]);
  }

  return (
    <div className={`dropdown-filter-shell ${className}`} ref={shellRef}>
      <button
        type="button"
        className={`dropdown-filter-trigger ${isFiltered ? "active" : ""}`}
        onClick={() => setOpen((current) => !current)}
        aria-label={ariaLabel}
      >
        <span>{triggerLabel}</span>
        <ChevronDown size={15} className={open ? "dropdown-filter-chevron open" : "dropdown-filter-chevron"} />
      </button>
      {open &&
        menuPosition &&
        createPortal(
          <div
            className="dropdown-filter-menu"
            ref={menuRef}
            style={{ top: menuPosition.top, left: menuPosition.left, minWidth: menuPosition.minWidth }}
          >
            <div className="dropdown-filter-menu-header">
              <span>{menuLabel}</span>
              {isFiltered && (
                <button type="button" className="dropdown-filter-clear" onClick={() => onChange([])}>
                  <X size={13} /> Clear
                </button>
              )}
            </div>
            {options.length === 0 ? (
              <p className="multi-select-empty">No options available.</p>
            ) : (
              options.map((option) => (
                <label key={option.value} className="multi-select-option">
                  <input
                    type="checkbox"
                    checked={selectedSet.has(option.value)}
                    onChange={() => toggle(option.value)}
                  />
                  <span>{option.label}</span>
                </label>
              ))
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
