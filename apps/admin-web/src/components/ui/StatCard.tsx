import { LucideIcon } from "lucide-react";
import type { KeyboardEvent } from "react";

export function StatCard({
  label,
  value,
  icon: Icon,
  tone,
  onClick,
  title,
}: {
  label: string;
  value: string | number;
  icon: LucideIcon;
  tone: "blue" | "green" | "yellow" | "red" | "pink" | "cyan" | "purple" | "teal";
  // Makes the whole card a keyboard-accessible link (e.g. into Attendance
  // Management pre-filtered to the card's status).
  onClick?: () => void;
  title?: string;
}) {
  const interactiveProps = onClick
    ? {
        role: "button",
        tabIndex: 0,
        onClick,
        onKeyDown: (event: KeyboardEvent) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onClick();
          }
        },
      }
    : {};

  return (
    <article className={`stat-card${onClick ? " stat-card-clickable" : ""}`} title={title} {...interactiveProps}>
      <div className={`stat-icon ${tone}`}>
        <Icon size={15} />
      </div>
      <div className="stat-text">
        <p>{label}</p>
        <strong>{value}</strong>
      </div>
    </article>
  );
}
