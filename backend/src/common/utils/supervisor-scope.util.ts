// Every Supervisor account is also an EMPLOYEE (that role is always assigned
// first, in Employee Management, before Supervisor is added later in User
// Management) — so the JWT's singular, backward-compatible `role` claim
// reads "EMPLOYEE" for essentially every real Supervisor, not "SUPERVISOR".
// Department-scoping must therefore check the full `roles` array, not the
// primary role, or it silently never applies. An ADMIN who also carries
// SUPERVISOR is not scoped down — ADMIN always sees everything.
export function getSupervisorDepartmentScope(user: {
  role: string;
  roles?: string[];
  departmentId?: string;
}): string | undefined {
  const roles = user.roles ?? [user.role];
  const isScopedSupervisor = roles.includes("SUPERVISOR") && !roles.includes("ADMIN");
  return isScopedSupervisor ? user.departmentId : undefined;
}
