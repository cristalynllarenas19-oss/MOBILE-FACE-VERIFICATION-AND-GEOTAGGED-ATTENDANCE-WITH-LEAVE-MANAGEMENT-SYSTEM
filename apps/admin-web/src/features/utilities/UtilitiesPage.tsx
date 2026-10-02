import { useState } from "react";
import { Briefcase, Building2, CalendarClock, ClipboardList, DatabaseBackup, History, IdCard, Megaphone, Timer, type LucideIcon } from "lucide-react";
import { NotificationModal, type NotificationConfig } from "../../components/ui/NotificationModal";
import { PermissionCode, permissions } from "../../types/rbac";
import { LeaveTypesTab } from "./LeaveTypesTab";
import { UndertimeSettingsCard } from "./UndertimeSettingsCard";
import { ShiftsTab } from "./ShiftsTab";
import { AuditLogsTab } from "./AuditLogsTab";
import { DepartmentsTab } from "./DepartmentsTab";
import { PositionsTab } from "./PositionsTab";
import { AnnouncementsTab } from "./AnnouncementsTab";
import { EmployeeTypesTab } from "./EmployeeTypesTab";
import { BackupRestoreTab } from "./BackupRestoreTab";
import "./UtilitiesPage.css";

export type { NotificationConfig as Notification } from "../../components/ui/NotificationModal";
export type UtilTab = "leave-types" | "undertime" | "shifts" | "departments" | "positions" | "announcements" | "employee-types" | "backup-restore" | "audit-logs";

// Rendered as the Utilities sub-items in the sidebar (AppLayout) — same
// order, labels and icons as the former in-page tab bar.
export const UTILITY_TABS: { id: UtilTab; label: string; icon: LucideIcon }[] = [
  { id: "leave-types",    label: "Leave Types",      icon: ClipboardList },
  { id: "undertime",      label: "Undertime",        icon: Timer },
  { id: "shifts",         label: "Shifts",           icon: CalendarClock },
  { id: "departments",    label: "Departments",      icon: Building2 },
  { id: "announcements",  label: "Announcements",    icon: Megaphone },
  { id: "positions",      label: "Positions",        icon: Briefcase },
  { id: "employee-types", label: "Employee Types",   icon: IdCard },
  { id: "backup-restore", label: "Backup & Restore", icon: DatabaseBackup },
  { id: "audit-logs",     label: "Audit Logs",       icon: History },
];

export function UtilitiesPage({ user, tab = "leave-types" }: { user?: { permissions: PermissionCode[] }; tab?: UtilTab }) {
  const canManageLeaveTypes = user?.permissions.includes(permissions.leaveTypesWrite) ?? true;
  const canManageShifts = user?.permissions.includes(permissions.schedulesWrite) ?? true;
  const [notification, setNotification] = useState<NotificationConfig>(null);

  return (
    <>
      <NotificationModal notification={notification} onClose={() => setNotification(null)} />

      {tab === "leave-types" && <LeaveTypesTab canManage={canManageLeaveTypes} notify={setNotification} />}
      {tab === "undertime" && <UndertimeSettingsCard canManage={canManageLeaveTypes} notify={setNotification} />}
      {tab === "shifts" && <ShiftsTab canManageShifts={canManageShifts} notify={setNotification} />}
      {tab === "departments" && <DepartmentsTab user={user} notify={setNotification} />}
      {tab === "positions" && <PositionsTab user={user} notify={setNotification} />}
      {tab === "announcements" && <AnnouncementsTab user={user} notify={setNotification} />}
      {tab === "employee-types" && <EmployeeTypesTab user={user} notify={setNotification} />}
      {tab === "backup-restore" && <BackupRestoreTab notify={setNotification} />}
      {tab === "audit-logs" && <AuditLogsTab notify={setNotification} />}
    </>
  );
}
