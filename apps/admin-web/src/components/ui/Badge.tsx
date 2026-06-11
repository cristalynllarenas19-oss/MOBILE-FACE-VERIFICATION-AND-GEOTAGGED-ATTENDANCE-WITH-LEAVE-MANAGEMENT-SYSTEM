export function Badge({
  children,
  tone = "neutral",
}: {
  children: string;
  tone?: "neutral" | "success" | "danger" | "warning" | "role";
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
