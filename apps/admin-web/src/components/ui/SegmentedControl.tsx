import { CSSProperties } from "react";
import "./SegmentedControl.css";

export type SegmentedControlOption = { key: string; label: string };

// Web mirror of employee-mobile's SegmentedControl.tsx — same navy pill,
// same sliding-thumb motion, just CSS transforms instead of RN Animated.
export function SegmentedControl({
  segments,
  value,
  onChange,
  style,
}: {
  segments: SegmentedControlOption[];
  value: string;
  onChange: (key: string) => void;
  style?: CSSProperties;
}) {
  const activeIndex = Math.max(0, segments.findIndex((s) => s.key === value));

  return (
    <div className="seg-track" style={style}>
      <div
        className="seg-thumb"
        style={{
          width: `calc((100% - 8px) / ${segments.length})`,
          transform: `translateX(${activeIndex * 100}%)`,
        }}
      />
      {segments.map((segment) => (
        <button
          key={segment.key}
          type="button"
          className={`seg-btn${segment.key === value ? " active" : ""}`}
          onClick={() => onChange(segment.key)}
        >
          {segment.label}
        </button>
      ))}
    </div>
  );
}
