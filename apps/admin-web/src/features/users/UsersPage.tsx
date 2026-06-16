import { useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2, Plus, X } from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { apiRequest } from "../../lib/api";
import "./UsersPage.css";

type UserRow = {
  id: string;
  email: string;
  status: string;
  employee?: { firstName: string; lastName: string } | null;
  userRoles: { role: { name: string; code: string } }[];
};

type UserFilter = "ALL" | "ACTIVE" | "INACTIVE";
type Notification = { type: "success" | "error"; message: string } | null;

const initialForm = {
  email: "",
  firstName: "",
  lastName: "",
  hireDate: "",
  password: "",
  role: "ADMIN",
};

function getRoleLabel(roleCode?: string) {
  switch (roleCode) {
    case "ADMIN":
      return "HR Admin";
    case "SUPERVISOR":
      return "Supervisor";
    default:
      return "No Role";
  }
}

function getUserDisplayName(user: UserRow) {
  return user.employee ? `${user.employee.firstName} ${user.employee.lastName}` : "Unassigned";
}

export function UsersPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [filter, setFilter] = useState<UserFilter>("ALL");
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [form, setForm] = useState(initialForm);
  const [isSaving, setIsSaving] = useState(false);
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null);
  const [confirmUser, setConfirmUser] = useState<UserRow | null>(null);
  const [error, setError] = useState("");
  const [notification, setNotification] = useState<Notification>(null);

  const loadUsers = () => {
    apiRequest<UserRow[]>("/users").then(setUsers).catch(() => undefined);
  };

  useEffect(loadUsers, []);

  useEffect(() => {
    if (!notification) return;

    const timeoutId = window.setTimeout(() => setNotification(null), 3500);
    return () => window.clearTimeout(timeoutId);
  }, [notification]);

  const activeCount = users.filter((user) => user.status === "ACTIVE").length;
  const inactiveCount = users.length - activeCount;
  const visibleUsers = users.filter((user) => {
    if (filter === "ALL") return true;
    return user.status === filter;
  });

  const closeAddUser = () => {
    setIsAddOpen(false);
    setForm(initialForm);
    setError("");
  };

  const openStatusConfirmation = (user: UserRow) => {
    setError("");
    setConfirmUser(user);
  };

  const handleCreateUser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSaving(true);
    setError("");

    try {
      const payload = {
        email: form.email.trim(),
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        password: form.password,
        role: form.role,
        ...(form.hireDate ? { hireDate: form.hireDate } : {}),
      };

      await apiRequest("/users", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      closeAddUser();
      setNotification({ type: "success", message: "User account was added successfully." });
      loadUsers();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to create user.";
      setError(message);
      setNotification({ type: "error", message });
    } finally {
      setIsSaving(false);
    }
  };

  const updateUserStatus = async () => {
    if (!confirmUser) return;

    const user = confirmUser;
    const nextStatus = user.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    setUpdatingUserId(user.id);
    setError("");

    try {
      await apiRequest(`/users/${user.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      setConfirmUser(null);
      setNotification({
        type: "success",
        message: `${user.email} has been ${nextStatus === "ACTIVE" ? "activated" : "deactivated"}.`,
      });
      loadUsers();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to update user status.";
      setError(message);
      setNotification({ type: "error", message });
    } finally {
      setUpdatingUserId(null);
    }
  };

  return (
    <>
      {notification && (
        <div className={`users-notification ${notification.type}`} role="status">
          {notification.type === "success" ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
          <span>{notification.message}</span>
        </div>
      )}

      <div className="users-toolbar">
        <div className="filter-tabs">
          <button className={filter === "ALL" ? "active" : ""} onClick={() => setFilter("ALL")}>All Users ({users.length})</button>
          <button className={filter === "ACTIVE" ? "active" : ""} onClick={() => setFilter("ACTIVE")}>Active ({activeCount})</button>
          <button className={filter === "INACTIVE" ? "active" : ""} onClick={() => setFilter("INACTIVE")}>Inactive ({inactiveCount})</button>
        </div>

        <button className="add-user-button" onClick={() => setIsAddOpen(true)}>
          <Plus size={15} />
          Add User
        </button>
      </div>

      <section className="table-card users-table-card">
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
            {visibleUsers.map((user) => (
              <tr key={user.id}>
                <td data-label="ID">{user.id.slice(0, 8)}</td>
                <td data-label="Name">{getUserDisplayName(user)}</td>
                <td data-label="Email">{user.email}</td>
                <td data-label="Role" className="role-cell"><Badge tone="role">{getRoleLabel(user.userRoles[0]?.role.code)}</Badge></td>
                <td data-label="Status" className="status-cell"><Badge tone={user.status === "ACTIVE" ? "success" : "danger"}>{user.status}</Badge></td>
                <td data-label="Action">
                  <button
                    className={`user-status-button ${user.status === "ACTIVE" ? "deactivate" : "activate"}`}
                    onClick={() => openStatusConfirmation(user)}
                    disabled={updatingUserId === user.id}
                  >
                    {updatingUserId === user.id ? "Updating..." : user.status === "ACTIVE" ? "Deactivate" : "Activate"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {isAddOpen && (
        <div className="user-modal-backdrop" role="presentation">
          <section className="user-modal" role="dialog" aria-modal="true" aria-labelledby="add-user-title">
            <div className="user-modal-header">
              <div>
                <h2 id="add-user-title">Add User</h2>
                <p>Create a new account for the admin system.</p>
              </div>
              <button className="icon-button" onClick={closeAddUser} aria-label="Close add user form">
                <X size={18} />
              </button>
            </div>

            <form className="user-form" onSubmit={handleCreateUser}>
              <div className="add-user-form-grid">
                <label>
                  First Name
                  <input
                    type="text"
                    value={form.firstName}
                    onChange={(event) => setForm((current) => ({ ...current, firstName: event.target.value }))}
                    placeholder="Juan"
                    required
                  />
                </label>

                <label>
                  Last Name
                  <input
                    type="text"
                    value={form.lastName}
                    onChange={(event) => setForm((current) => ({ ...current, lastName: event.target.value }))}
                    placeholder="Dela Cruz"
                    required
                  />
                </label>
              </div>

              <div className="add-user-form-grid">
                <label>
                  Email
                  <input
                    type="email"
                    value={form.email}
                    onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
                    placeholder="admin@example.com"
                    required
                  />
                </label>

                <label>
                  Password
                  <input
                    type="password"
                    value={form.password}
                    onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
                    minLength={8}
                    placeholder="Minimum 8 characters"
                    required
                  />
                </label>
              </div>

              <div className="add-user-form-grid">
                <label>
                  Role
                  <select
                    value={form.role}
                    onChange={(event) => setForm((current) => ({ ...current, role: event.target.value }))}
                  >
                    <option value="ADMIN">HR Admin</option>
                    <option value="SUPERVISOR">Supervisor</option>
                  </select>
                </label>

                <label>
                  Hire Date
                  <input
                    type="date"
                    value={form.hireDate}
                    onChange={(event) => setForm((current) => ({ ...current, hireDate: event.target.value }))}
                  />
                </label>
              </div>

              {error && <p className="user-form-error">{error}</p>}

              <div className="user-form-actions">
                <button type="button" className="outline-button" onClick={closeAddUser}>Cancel</button>
                <button type="submit" className="primary-button" disabled={isSaving}>
                  {isSaving ? "Adding..." : "Add User"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {confirmUser && (
        <div className="user-modal-backdrop" role="presentation">
          <section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-status-title">
            <div className="confirm-modal-header">
              <div className="confirm-icon">
                <AlertTriangle size={22} />
              </div>
              <h2 id="confirm-status-title">
                {confirmUser.status === "ACTIVE" ? "Deactivate User" : "Activate User"}
              </h2>
              <button
                className="icon-button"
                onClick={() => setConfirmUser(null)}
                aria-label="Close confirmation"
                disabled={updatingUserId === confirmUser.id}
              >
                <X size={18} />
              </button>
            </div>

            <p className="confirm-modal-copy">
              Are you sure you want to {confirmUser.status === "ACTIVE" ? "deactivate" : "activate"}{" "}
              <strong>{confirmUser.email}</strong>?
            </p>

            {error && <p className="user-form-error confirm-error">{error}</p>}

            <div className="confirm-modal-actions">
              <button
                type="button"
                className="outline-button"
                onClick={() => setConfirmUser(null)}
                disabled={updatingUserId === confirmUser.id}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`primary-button ${confirmUser.status === "ACTIVE" ? "danger-action" : "confirm-action"}`}
                onClick={updateUserStatus}
                disabled={updatingUserId === confirmUser.id}
              >
                {updatingUserId === confirmUser.id
                  ? "Updating..."
                  : confirmUser.status === "ACTIVE"
                    ? "Deactivate"
                    : "Activate"}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
