import { useState } from "react";
import { Building2, CalendarClock, ClipboardList, DatabaseBackup, History, Megaphone, Timer } from "lucide-react";
import { NotificationModal, type NotificationConfig } from "../../components/ui/NotificationModal";
import { PermissionCode, permissions } from "../../types/rbac";
import { LeaveTypesTab } from "./LeaveTypesTab";
import { UndertimeSettingsCard } from "./UndertimeSettingsCard";
import { ShiftsTab } from "./ShiftsTab";
import { AuditLogsTab } from "./AuditLogsTab";
import { DepartmentsTab } from "./DepartmentsTab";
import { AnnouncementsTab } from "./AnnouncementsTab";
import { BackupRestoreTab } from "./BackupRestoreTab";
import "./UtilitiesPage.css";

export type { NotificationConfig as Notification } from "../../components/ui/NotificationModal";
type UtilTab = "leave-types" | "undertime" | "shifts" | "departments" | "announcements" | "backup-restore" | "audit-logs";

export function UtilitiesPage({ user }: { user?: { permissions: PermissionCode[] } }) {
  const canManageLeaveTypes = user?.permissions.includes(permissions.leaveTypesWrite) ?? true;
  const canManageShifts = user?.permissions.includes(permissions.schedulesWrite) ?? true;
  const [tab, setTab] = useState<UtilTab>("leave-types");
  const [notification, setNotification] = useState<NotificationConfig>(null);

  return (
    <>
      <NotificationModal notification={notification} onClose={() => setNotification(null)} />

      <div className="filter-tabs utilities-tabs">
        <button className={tab === "leave-types" ? "active" : ""} onClick={() => setTab("leave-types")}>
          <ClipboardList size={14} /> Leave Types
        </button>
        <button className={tab === "undertime" ? "active" : ""} onClick={() => setTab("undertime")}>
          <Timer size={14} /> Undertime
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
      {tab === "undertime" && <UndertimeSettingsCard canManage={canManageLeaveTypes} notify={setNotification} />}
      {tab === "shifts" && <ShiftsTab canManageShifts={canManageShifts} notify={setNotification} />}
      {tab === "departments" && <DepartmentsTab user={user} notify={setNotification} />}
      {tab === "announcements" && <AnnouncementsTab user={user} notify={setNotification} />}
      {tab === "backup-restore" && <BackupRestoreTab notify={setNotification} />}
      {tab === "audit-logs" && <AuditLogsTab notify={setNotification} />}
    </>
  );
}
