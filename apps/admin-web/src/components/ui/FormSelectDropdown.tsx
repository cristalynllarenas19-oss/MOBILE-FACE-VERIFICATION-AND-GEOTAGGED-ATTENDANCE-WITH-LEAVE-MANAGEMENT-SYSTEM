import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import "./FormSelectDropdown.css";
import "./EmployeeSearchSelect.css";

export type FormSelectDropdownOption = { value: string; label: string; disabled?: boolean };

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
  searchable,
  menuVariant = "default",
}: {
  value: string;
  onChange: (value: string) => void;
  options: FormSelectDropdownOption[];
  placeholder: string;
  disabled?: boolean;
  ariaLabel?: string;
  // Makes the field itself a text box: typing into it filters the options by
  // label — for long lists (e.g. picking an employee) where scrolling to find
  // an option is impractical.
  searchable?: boolean;
  // "employee" draws the menu like the employee search on Attendance/Reports
  // (EmployeeSearchSelect) — roomy rows with bold names — for employee pickers.
  menuVariant?: "default" | "employee";
}) {
  const isEmployeeMenu = menuVariant === "employee";
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const shellRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Each open starts with an empty filter.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const needle = query.trim().toLowerCase();
  const visibleOptions =
    searchable && needle ? options.filter((option) => option.label.toLowerCase().includes(needle)) : options;

  const select = (option: FormSelectDropdownOption) => {
    onChange(option.value);
    setOpen(false);
    inputRef.current?.blur();
  };

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
      {searchable ? (
        // Closed, it reads like the plain trigger (showing the selection);
        // open, it's a text box whose contents filter the menu, with the
        // current selection kept visible as its placeholder.
        <div
          className={`form-select-dropdown-trigger form-select-dropdown-combobox${disabled ? " disabled" : ""}`}
          onMouseDown={(event) => {
            if (disabled || event.target === inputRef.current) return;
            // Clicking the chevron/padding toggles, like the plain trigger.
            event.preventDefault();
            if (open) setOpen(false);
            else inputRef.current?.focus();
          }}
        >
          <input
            ref={inputRef}
            type="text"
            className="form-select-dropdown-input"
            value={open ? query : selected?.label ?? ""}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onKeyDown={(event) => {
              // Enter picks the first match instead of submitting the form.
              if (event.key === "Enter") {
                event.preventDefault();
                const first = visibleOptions.find((option) => !option.disabled);
                if (first) select(first);
              } else if (event.key === "Tab") {
                setOpen(false);
              }
            }}
            placeholder={open && selected ? selected.label : placeholder}
            disabled={disabled}
            aria-label={ariaLabel}
            role="combobox"
            aria-haspopup="listbox"
            aria-expanded={open}
            autoComplete="off"
          />
          <ChevronDown size={15} className={`form-select-dropdown-chevron${open ? " open" : ""}`} />
        </div>
      ) : (
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
      )}

      {open && (
        <div className={isEmployeeMenu ? "employee-search-select-list" : "form-select-dropdown-menu"} role="listbox">
          {searchable &&
            visibleOptions.length === 0 &&
            (isEmployeeMenu ? (
              <div className="employee-search-select-empty">No matching employees found.</div>
            ) : (
              <p className="form-select-dropdown-empty">No matches found.</p>
            ))}
          {visibleOptions.map((option) => (
            <button
              type="button"
              key={option.value}
              role="option"
              aria-selected={value === option.value}
              aria-disabled={option.disabled}
              disabled={option.disabled}
              className={
                isEmployeeMenu
                  ? `employee-search-select-option${value === option.value ? " selected" : ""}`
                  : `form-select-dropdown-option${value === option.value ? " active" : ""}`
              }
              onClick={() => select(option)}
            >
              {isEmployeeMenu ? <span>{option.label}</span> : option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
