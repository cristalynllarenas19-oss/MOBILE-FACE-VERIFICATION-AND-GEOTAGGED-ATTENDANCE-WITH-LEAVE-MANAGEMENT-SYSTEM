import { useEffect, useRef, useState } from "react";
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

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(event: MouseEvent) {
      if (shellRef.current && !shellRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
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
      {open && (
        <div className="dropdown-filter-menu">
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
        </div>
      )}
    </div>
  );
}
