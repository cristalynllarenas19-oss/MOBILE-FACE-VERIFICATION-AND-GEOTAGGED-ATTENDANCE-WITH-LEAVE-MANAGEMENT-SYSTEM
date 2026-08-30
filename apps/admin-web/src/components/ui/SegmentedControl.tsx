import { CSSProperties } from "react";
import "./SegmentedControl.css";

export type SegmentedControlOption = { key: string; label: string };

const DENSE_GAP = 4;

// Web mirror of employee-mobile's SegmentedControl.tsx — same navy pill,
// same sliding-thumb motion, just CSS transforms instead of RN Animated.
export function SegmentedControl({
  segments,
  value,
  onChange,
  style,
  dense,
}: {
  segments: SegmentedControlOption[];
  value: string;
  onChange: (key: string) => void;
  style?: CSSProperties;
  // Tighter label size/spacing for tracks with longer labels (e.g. DTR's
  // Time In / Lunch Start / Lunch End / Time Out) — keeps the default look
  // for every other SegmentedControl untouched.
  dense?: boolean;
}) {
  const activeIndex = Math.max(0, segments.findIndex((s) => s.key === value));
  const gap = dense ? DENSE_GAP : 0;
  const gapTotal = gap * (segments.length - 1);
  const thumbWidth = `((100% - 8px - ${gapTotal}px) / ${segments.length})`;
  const thumbOffset = `calc(${activeIndex * 100}% + ${activeIndex * gap}px)`;

  return (
    <div className={`seg-track${dense ? " dense" : ""}`} style={style}>
      <div
        className="seg-thumb"
        style={{
          width: `calc${thumbWidth}`,
          transform: `translateX(${thumbOffset})`,
        }}
      />
      {segments.map((segment) => (
        <button
          key={segment.key}
          type="button"
          className={`seg-btn${dense ? " dense" : ""}${segment.key === value ? " active" : ""}`}
          onClick={() => onChange(segment.key)}
        >
          {segment.label}
        </button>
      ))}
    </div>
  );
}
