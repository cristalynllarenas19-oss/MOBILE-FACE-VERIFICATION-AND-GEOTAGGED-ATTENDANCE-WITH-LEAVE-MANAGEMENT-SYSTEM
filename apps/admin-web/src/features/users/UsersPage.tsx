import { useEffect, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { apiRequest } from "../../lib/api";

type UserRow = {
  id: string;
  email: string;
  status: string;
  employee?: { firstName: string; lastName: string } | null;
  userRoles: { role: { name: string; code: string } }[];
};

export function UsersPage() {
  const [users, setUsers] = useState<UserRow[]>([]);

  useEffect(() => {
    apiRequest<UserRow[]>("/users").then(setUsers).catch(() => undefined);
  }, []);

  const activeCount = users.filter((user) => user.status === "ACTIVE").length;

  return (
    <>
      <div className="filter-tabs">
        <button className="active">All Users ({users.length})</button>
        <button>Active ({activeCount})</button>
        <button>Inactive ({users.length - activeCount})</button>
      </div>
      <section className="table-card">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>{user.id.slice(0, 8)}</td>
                <td>{user.employee ? `${user.employee.firstName} ${user.employee.lastName}` : "Unassigned"}</td>
                <td>{user.email}</td>
                <td><Badge tone="role">{user.userRoles[0]?.role.name ?? "No Role"}</Badge></td>
                <td><Badge tone={user.status === "ACTIVE" ? "success" : "danger"}>{user.status}</Badge></td>
                <td><button className="outline-button">{user.status === "ACTIVE" ? "Deactivate" : "Activate"}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
