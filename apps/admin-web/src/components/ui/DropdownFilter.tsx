import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, X } from "lucide-react";
import "./DropdownFilter.css";

export type DropdownFilterOption = { value: string; label: string };

export function DropdownFilter({
  value,
  options,
  onChange,
  allLabel,
  menuLabel,
  allValue = "ALL",
  ariaLabel,
  className = "",
}: {
  value: string;
  options: DropdownFilterOption[];
  onChange: (value: string) => void;
  allLabel: string;
  menuLabel: string;
  allValue?: string;
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
      // The menu is portaled out of shellRef's subtree, so a click inside it
      // must be checked separately from the trigger.
      if (shellRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  // Portaled to <body> with fixed positioning so the menu always renders
  // above every card/modal instead of being clipped by whichever ancestor
  // happens to set overflow:hidden/auto (e.g. the dashboard's chart cards).
  // Recomputed on scroll/resize (capture:true catches scroll on any
  // ancestor container, not just the window) so it stays pinned under the
  // trigger.
  useLayoutEffect(() => {
    if (!open) return;
    function updatePosition() {
      const rect = shellRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.max(220, rect.width);
      // Clamp to the viewport so the menu never runs off-screen when the
      // trigger sits near the right edge on a narrow window.
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

  const isFiltered = value !== allValue;
  const selected = options.find((option) => option.value === value);
  const triggerLabel = isFiltered ? selected?.label ?? allLabel : allLabel;

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
                <button
                  type="button"
                  className="dropdown-filter-clear"
                  onClick={() => {
                    onChange(allValue);
                    setOpen(false);
                  }}
                >
                  <X size={13} /> Clear
                </button>
              )}
            </div>
            <button
              type="button"
              className={`dropdown-filter-option ${!isFiltered ? "active" : ""}`}
              onClick={() => {
                onChange(allValue);
                setOpen(false);
              }}
            >
              {allLabel}
            </button>
            {options.map((option) => (
              <button
                type="button"
                key={option.value}
                className={`dropdown-filter-option ${value === option.value ? "active" : ""}`}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
