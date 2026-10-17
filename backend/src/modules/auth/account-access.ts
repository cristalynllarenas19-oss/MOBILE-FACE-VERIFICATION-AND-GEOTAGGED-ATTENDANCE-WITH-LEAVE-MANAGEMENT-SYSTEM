import { PrismaService } from "../../prisma/prisma.service";

type AccessUser = {
  status: string;
  employee?: { employmentStatus: string } | null;
};

type RoleWithPermissions = {
  code: string;
  permissions: { permission: { code: string } }[];
};

// Deactivating an account in User Management only switches off its
// Supervisor/HR Admin role — the person keeps their employee login
// (attendance, leave). An archived (SEPARATED) employee is also INACTIVE but
// stays fully locked out, as does a LOCKED account.
export function canSignIn(user: AccessUser) {
  if (user.status === "ACTIVE") return true;
  return user.status === "INACTIVE" && !!user.employee && user.employee.employmentStatus !== "SEPARATED";
}

// The roles an account actually gets to use right now: all of them while
// ACTIVE, otherwise just EMPLOYEE (looked up when the account was only ever
// granted the elevated role, e.g. a Supervisor-only account).
export async function effectiveRoles<T extends RoleWithPermissions>(
  prisma: PrismaService,
  user: { status: string },
  roles: T[],
): Promise<T[]> {
  if (user.status === "ACTIVE") return roles;
  const employeeRoles = roles.filter((role) => role.code === "EMPLOYEE");
  if (employeeRoles.length) return employeeRoles;
  const employeeRole = await prisma.role.findUnique({
    where: { code: "EMPLOYEE" },
    include: { permissions: { include: { permission: true } } },
  });
  return employeeRole ? [employeeRole as unknown as T] : [];
}
