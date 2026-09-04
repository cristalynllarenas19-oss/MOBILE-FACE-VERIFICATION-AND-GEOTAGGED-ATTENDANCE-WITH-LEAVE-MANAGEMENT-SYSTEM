// Local YYYY-MM-DD (not UTC — a plain .toISOString().slice(0, 10) can land on
// the wrong calendar day for timezones ahead of UTC).
export function toDateInputValue(isoDate: string) {
  const date = new Date(isoDate);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function formatFullDate(isoDate: string) {
  if (!isoDate) return "";
  return new Date(isoDate).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export function formatShortDate(isoDate: string) {
  if (!isoDate) return "";
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}
