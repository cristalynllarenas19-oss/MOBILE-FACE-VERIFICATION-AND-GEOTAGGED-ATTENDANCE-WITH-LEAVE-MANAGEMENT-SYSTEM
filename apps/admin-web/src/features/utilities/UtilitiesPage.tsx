import { useEffect, useState } from "react";
import { AlertTriangle, CalendarClock, CheckCircle2, ClipboardList, History } from "lucide-react";
import { PermissionCode, permissions } from "../../types/rbac";
import { LeaveTypesTab } from "./LeaveTypesTab";
import { ShiftsTab } from "./ShiftsTab";
import { AuditLogsTab } from "./AuditLogsTab";
import "./UtilitiesPage.css";

export type Notification = { type: "success" | "error"; message: string } | null;
type UtilTab = "leave-types" | "shifts" | "audit-logs";

export function UtilitiesPage({ user }: { user?: { permissions: PermissionCode[] } }) {
  const canManageShifts = user?.permissions.includes(permissions.schedulesWrite) ?? true;
  const [tab, setTab] = useState<UtilTab>("leave-types");
  const [notification, setNotification] = useState<Notification>(null);

  useEffect(() => {
    if (!notification) return;
    const id = window.setTimeout(() => setNotification(null), 3500);
    return () => window.clearTimeout(id);
  }, [notification]);

  return (
    <>
      {notification && (
        <div className={`utilities-notification ${notification.type}`} role="status">
          {notification.type === "success" ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
          <span>{notification.message}</span>
        </div>
      )}

      <div className="filter-tabs utilities-tabs">
        <button className={tab === "leave-types" ? "active" : ""} onClick={() => setTab("leave-types")}>
          <ClipboardList size={14} /> Leave Types
        </button>
        <button className={tab === "shifts" ? "active" : ""} onClick={() => setTab("shifts")}>
          <CalendarClock size={14} /> Shifts
        </button>
        <button className={tab === "audit-logs" ? "active" : ""} onClick={() => setTab("audit-logs")}>
          <History size={14} /> Audit Logs
        </button>
      </div>

      {tab === "leave-types" && <LeaveTypesTab notify={setNotification} />}
      {tab === "shifts" && <ShiftsTab canManageShifts={canManageShifts} notify={setNotification} />}
      {tab === "audit-logs" && <AuditLogsTab notify={setNotification} />}
    </>
  );
}
