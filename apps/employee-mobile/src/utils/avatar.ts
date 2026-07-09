// Deterministic "initials + color" avatar, the same trick most mobile apps
// use to avoid a plain gray circle for every list row that has no photo.
const PALETTE = ["#1680D8", "#7C3AED", "#0EA5E9", "#15803D", "#B45309", "#DB2777", "#0891B2", "#4338CA"];

export function initials(firstName?: string, lastName?: string) {
  const a = firstName?.trim()?.[0] ?? "";
  const b = lastName?.trim()?.[0] ?? "";
  return `${a}${b}`.toUpperCase() || "?";
}

export function colorFor(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) % PALETTE.length;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}
