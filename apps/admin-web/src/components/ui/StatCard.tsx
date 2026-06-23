import { LucideIcon } from "lucide-react";

export function StatCard({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string | number;
  icon: LucideIcon;
  tone: "blue" | "green" | "yellow" | "red" | "pink" | "cyan" | "purple" | "teal";
}) {
  return (
    <article className="stat-card">
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
