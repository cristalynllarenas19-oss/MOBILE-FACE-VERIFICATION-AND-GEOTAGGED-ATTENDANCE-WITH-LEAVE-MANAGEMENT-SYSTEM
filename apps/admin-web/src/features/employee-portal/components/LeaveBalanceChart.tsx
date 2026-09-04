import { CirclePlus } from "lucide-react";
import { LeaveBalance } from "../api";
import { colorForLeaveType } from "../../../lib/leaveTypeColors";
import "./LeaveBalanceChart.css";

// Mirrors employee-mobile's LeaveBalanceChart.tsx — same palette (see
// lib/leaveTypeColors), same ring math — so the two platforms read as the
// same feature, just laid out for a wider viewport.

const RING_SIZE = 106;
const RING_STROKE = 11;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

type Props = {
  balances: LeaveBalance[];
  loading?: boolean;
  pendingCount?: number;
  // How many of pendingCount are specifically NEEDS_REVISION — those need the
  // employee to act (resubmit), unlike a plain PENDING/SUPERVISOR_APPROVED
  // request that's just awaiting someone else's decision, so the pill calls
  // that out instead of lumping everything under "Pending".
  needsRevisionCount?: number;
  onPressPending?: () => void;
  onPressViewAll?: () => void;
  onRequest?: (leaveTypeId: string) => void;
};

export function LeaveBalanceChart({ balances, loading, pendingCount, needsRevisionCount, onPressPending, onPressViewAll, onRequest }: Props) {
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
          return { id: balance.leaveTypeId, color: colorForLeaveType(balance.leaveTypeName, index), length, offset };
        })
        .filter((segment) => segment.length > 0)
    : [];

  const otherPendingCount = (pendingCount ?? 0) - (needsRevisionCount ?? 0);

  const header = (
    <div className="lbc-header">
      <h3 className="lbc-title">My Leave Balance</h3>
      {Boolean(pendingCount) && (
        <button type="button" className="lbc-pending-pill" onClick={onPressPending}>
          ⏳{" "}
          {needsRevisionCount ? (
            <>
              <span className="lbc-pending-pill-revision">{needsRevisionCount} Needs Revision</span>
              {otherPendingCount > 0 && <> · {otherPendingCount} Pending</>}
            </>
          ) : (
            `${pendingCount} Pending`
          )}
        </button>
      )}
    </div>
  );

  const viewAllButton = onPressViewAll && (
    <button type="button" className="lbc-view-all-button" onClick={onPressViewAll}>
      View Filed Leave
    </button>
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
      {viewAllButton}

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
            <span className="lbc-ring-percent">{usedPercent}% used</span>
          </div>
        </div>

        <div className="lbc-stats-col">
          <div className="lbc-hero-row">
            <span className="lbc-hero-value">{totalRemaining}</span>
            <span className="lbc-hero-label">Remaining</span>
          </div>

          <div className="lbc-stat-row">
            <span className="lbc-stat-label">Earned</span>
            <span className="lbc-stat-value">{totalEarned}</span>
          </div>
          <div className="lbc-stat-row">
            <span className="lbc-stat-label">Used</span>
            <span className="lbc-stat-value">{totalUsed}</span>
          </div>
        </div>
      </div>

      <div className="lbc-divider" />

      <div className="lbc-bars-scroll">
      <div className="lbc-bars-grid">
        {balances.map((balance, index) => {
          const color = colorForLeaveType(balance.leaveTypeName, index);
          const ratio = balance.earnedDays > 0 ? Math.min(1, balance.usedDays / balance.earnedDays) : 0;
          return (
            <div key={balance.leaveTypeId} className="lbc-bar-cell">
              <div className="lbc-bar-label-row">
                <span className="lbc-dot" style={{ background: color }} />
                <span className="lbc-bar-label">{balance.leaveTypeName}</span>
              </div>
              <div className="lbc-bar-track">
                <div className="lbc-bar-fill" style={{ width: `${ratio * 100}%`, background: color }} />
              </div>
              <span className="lbc-bar-value">{balance.usedDays}/{balance.earnedDays} days used</span>
              {onRequest && (
                <button
                  type="button"
                  className="lbc-request-button"
                  onClick={() => onRequest(balance.leaveTypeId)}
                >
                  <CirclePlus size={11} color="#1680D8" strokeWidth={2} />
                  Request
                </button>
              )}
            </div>
          );
        })}
      </div>
      </div>
    </div>
  );
}
