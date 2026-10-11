import { MobileUser } from "../api";

// The mobile app has one management portal shared by Admins and
// Supervisors, so anything that names the portal has to ask which of the
// two the signed-in account actually is. Same precedence as admin-web's
// profileRoleLabel (AppLayout.tsx): Admin wins over Supervisor.
export function managementRoleLabel(user: Pick<MobileUser, "role" | "roles"> | null | undefined) {
  const roles = user?.roles?.length ? user.roles : user?.role ? [user.role] : [];
  return roles.includes("ADMIN") ? "Admin" : "Supervisor";
}

// True for any account with a role beyond plain Employee.
export function hasManagementRole(user: Pick<MobileUser, "role" | "roles"> | null | undefined) {
  const roles = user?.roles?.length ? user.roles : user?.role ? [user.role] : [];
  return roles.some((role) => role !== "EMPLOYEE");
}
