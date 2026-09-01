import { useEffect, useState } from "react";
import { AlertTriangle, Building2, CalendarClock, CheckCircle2, ClipboardList, DatabaseBackup, History, Megaphone } from "lucide-react";
import { PermissionCode, permissions } from "../../types/rbac";
import { LeaveTypesTab } from "./LeaveTypesTab";
import { ShiftsTab } from "./ShiftsTab";
import { AuditLogsTab } from "./AuditLogsTab";
import { DepartmentsTab } from "./DepartmentsTab";
import { AnnouncementsTab } from "./AnnouncementsTab";
import { BackupRestoreTab } from "./BackupRestoreTab";
import "./UtilitiesPage.css";

export type Notification = { type: "success" | "error"; message: string } | null;
type UtilTab = "leave-types" | "shifts" | "departments" | "announcements" | "backup-restore" | "audit-logs";

export function UtilitiesPage({ user }: { user?: { permissions: PermissionCode[] } }) {
  const canManageLeaveTypes = user?.permissions.includes(permissions.leaveTypesWrite) ?? true;
  const canManageShifts = user?.permissions.includes(permissions.schedulesWrite) ?? true;
  const [tab, setTab] = useState<UtilTab>("leave-types");
  const [notification, setNotification] = useState<Notification>(null);

  useEffect(() => {
    if (!notification) return;
    const id = window.setTimeout(() => setNotification(null), 6000);
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
        <button className={tab === "departments" ? "active" : ""} onClick={() => setTab("departments")}>
          <Building2 size={14} /> Departments
        </button>
        <button className={tab === "announcements" ? "active" : ""} onClick={() => setTab("announcements")}>
          <Megaphone size={14} /> Announcements
        </button>
        <button className={tab === "backup-restore" ? "active" : ""} onClick={() => setTab("backup-restore")}>
          <DatabaseBackup size={14} /> Backup & Restore
        </button>
        <button className={tab === "audit-logs" ? "active" : ""} onClick={() => setTab("audit-logs")}>
          <History size={14} /> Audit Logs
        </button>
      </div>

      {tab === "leave-types" && <LeaveTypesTab canManage={canManageLeaveTypes} notify={setNotification} />}
      {tab === "shifts" && <ShiftsTab canManageShifts={canManageShifts} notify={setNotification} />}
      {tab === "departments" && <DepartmentsTab user={user} notify={setNotification} />}
      {tab === "announcements" && <AnnouncementsTab user={user} notify={setNotification} />}
      {tab === "backup-restore" && <BackupRestoreTab notify={setNotification} />}
      {tab === "audit-logs" && <AuditLogsTab notify={setNotification} />}
    </>
  );
}
