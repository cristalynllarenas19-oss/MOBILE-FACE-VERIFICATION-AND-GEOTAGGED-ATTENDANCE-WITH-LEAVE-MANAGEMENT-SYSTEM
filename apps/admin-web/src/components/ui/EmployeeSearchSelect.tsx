import { useState } from "react";
import { ChevronDown, X } from "lucide-react";
import "./EmployeeSearchSelect.css";

export type EmployeeSearchOption = {
  id: string;
  firstName: string;
  lastName: string;
  department: { name: string };
};

// Matches on the employee's name (either order), case-insensitively. Shared
// by the dropdown and the tables it filters so both always agree on what a
// query means.
export function matchesEmployeeQuery(employee: { firstName: string; lastName: string }, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [`${employee.firstName} ${employee.lastName}`, `${employee.lastName} ${employee.firstName}`].some((value) =>
    value.toLowerCase().includes(needle),
  );
}

// Search box with a floating employee list under it — same look as the
// employee picker in Add User. The value is plain text: typing filters as
// you go, and picking an employee just fills in their name.
export function EmployeeSearchSelect({
  value,
  onChange,
  options,
  placeholder = "Search employee",
  ariaLabel = "Search by employee",
}: {
  value: string;
  onChange: (value: string) => void;
  options: EmployeeSearchOption[];
  placeholder?: string;
  ariaLabel?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const visibleOptions = options.filter((option) => matchesEmployeeQuery(option, value));

  return (
    <div
      className="employee-search-select"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setIsOpen(false);
      }}
    >
      <input
        type="text"
        role="combobox"
        className="employee-search-select-input"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        value={value}
        onFocus={() => setIsOpen(true)}
        onClick={() => setIsOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && isOpen) {
            event.stopPropagation();
            setIsOpen(false);
          }
        }}
        onChange={(event) => {
          onChange(event.target.value);
          setIsOpen(true);
        }}
        placeholder={placeholder}
        autoComplete="off"
      />
      {value ? (
        <button
          type="button"
          className="employee-search-select-clear"
          onClick={() => onChange("")}
          aria-label="Clear employee search"
        >
          <X size={14} />
        </button>
      ) : (
        <ChevronDown
          size={15}
          className={`employee-search-select-chevron${isOpen ? " open" : ""}`}
          aria-hidden="true"
        />
      )}

      {isOpen && (
        <div
          className="employee-search-select-list"
          role="listbox"
          // Keeps focus in the search box, so clicking the scrollbar
          // doesn't close the list.
          onMouseDown={(event) => event.preventDefault()}
        >
          {visibleOptions.length === 0 ? (
            <div className="employee-search-select-empty">No matching employees found.</div>
          ) : (
            visibleOptions.map((option) => {
              const name = `${option.firstName} ${option.lastName}`;
              return (
                <button
                  type="button"
                  key={option.id}
                  className={`employee-search-select-option${name === value ? " selected" : ""}`}
                  onClick={() => {
                    onChange(name);
                    setIsOpen(false);
                  }}
                  aria-selected={name === value}
                  role="option"
                >
                  <span>{name}</span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
