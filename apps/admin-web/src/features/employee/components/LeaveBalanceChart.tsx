import { LeaveBalance } from "../api";
import "./LeaveBalanceChart.css";

// Mirrors employee-mobile's LeaveBalanceChart.tsx — same palette, same
// per-type color assignment (by array index), same ring math — so the two
// platforms read as the same feature, just laid out for a wider viewport.
const LEAVE_TYPE_COLORS = ["#1680D8", "#1BAF7A", "#EDA100", "#E34948", "#7C3AED", "#0EA5B8", "#D6336C", "#4A3AA7"];

const RING_SIZE = 96;
const RING_STROKE = 10;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

type Props = {
  balances: LeaveBalance[];
  loading?: boolean;
  pendingCount?: number;
  onPressPending?: () => void;
};

export function LeaveBalanceChart({ balances, loading, pendingCount, onPressPending }: Props) {
  const totalEarned = balances.reduce((sum, b) => sum + b.earnedDays, 0);
  const totalUsed = balances.reduce((sum, b) => sum + b.usedDays, 0);
  const totalRemaining = balances.reduce((sum, b) => sum + b.remainingDays, 0);
  const usedPercent = totalEarned > 0 ? Math.round((totalUsed / totalEarned) * 100) : 0;

  let cumulativeOffset = 0;
  const ringSegments = totalEarned > 0
    ? balances
        .map((balance, index) => {
          const length = (balance.usedDays / totalEarned) * RING_CIRCUMFERENCE;
          const offset = cumulativeOffset;
          cumulativeOffset += length;
          return { id: balance.leaveTypeId, color: LEAVE_TYPE_COLORS[index % LEAVE_TYPE_COLORS.length], length, offset };
        })
        .filter((segment) => segment.length > 0)
    : [];

  const header = (
    <div className="lbc-header">
      <h3 className="lbc-title">My Leave Balance</h3>
      {Boolean(pendingCount) && (
        <button type="button" className="lbc-pending-pill" onClick={onPressPending}>
          ⏳ {pendingCount} Pending
        </button>
      )}
    </div>
  );

  if (loading) {
    return (
      <div className="lbc-card">
        {header}
        <div className="lbc-centered">Loading…</div>
      </div>
    );
  }

  if (balances.length === 0) {
    return (
      <div className="lbc-card">
        {header}
        <div className="lbc-centered lbc-empty">No leave balance data yet.</div>
      </div>
    );
  }

  return (
    <div className="lbc-card">
      {header}

      <div className="lbc-summary-row">
        <div className="lbc-ring-wrap">
          <svg width={RING_SIZE} height={RING_SIZE}>
            <circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RING_RADIUS}
              fill="none"
              stroke="#EEF2F7"
              strokeWidth={RING_STROKE}
            />
            {ringSegments.map((segment) => (
              <circle
                key={segment.id}
                cx={RING_SIZE / 2}
                cy={RING_SIZE / 2}
                r={RING_RADIUS}
                fill="none"
                stroke={segment.color}
                strokeWidth={RING_STROKE}
                strokeDasharray={`${segment.length} ${RING_CIRCUMFERENCE - segment.length}`}
                strokeDashoffset={-segment.offset}
                transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
              />
            ))}
          </svg>
          <div className="lbc-ring-center">
            <span className="lbc-ring-value">{totalRemaining}</span>
            <span className="lbc-ring-label">left</span>
            <span className="lbc-ring-percent">{usedPercent}% used</span>
          </div>
        </div>

        <div className="lbc-stats-col">
          <div className="lbc-stat-row">
            <span className="lbc-dot" style={{ background: "#062B59" }} />
            <span className="lbc-stat-label">Earned</span>
            <span className="lbc-stat-value">{totalEarned}</span>
          </div>
          <div className="lbc-stat-row">
            <span className="lbc-dot" style={{ background: "#1680D8" }} />
            <span className="lbc-stat-label">Used</span>
            <span className="lbc-stat-value">{totalUsed}</span>
          </div>
          <div className="lbc-stat-row">
            <span className="lbc-dot" style={{ background: "#DCE7F5" }} />
            <span className="lbc-stat-label">Remaining</span>
            <span className="lbc-stat-value">{totalRemaining}</span>
          </div>
        </div>
      </div>

      <div className="lbc-divider" />

      <div className="lbc-bars-grid">
        {balances.map((balance, index) => {
          const color = LEAVE_TYPE_COLORS[index % LEAVE_TYPE_COLORS.length];
          const ratio = balance.earnedDays > 0 ? Math.min(1, balance.remainingDays / balance.earnedDays) : 0;
          return (
            <div key={balance.leaveTypeId} className="lbc-bar-cell">
              <div className="lbc-bar-label-row">
                <span className="lbc-dot" style={{ background: color }} />
                <span className="lbc-bar-label">{balance.leaveTypeName}</span>
              </div>
              <div className="lbc-bar-track">
                <div className="lbc-bar-fill" style={{ width: `${ratio * 100}%`, background: color }} />
              </div>
              <span className="lbc-bar-value">{balance.remainingDays}/{balance.earnedDays} days</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
