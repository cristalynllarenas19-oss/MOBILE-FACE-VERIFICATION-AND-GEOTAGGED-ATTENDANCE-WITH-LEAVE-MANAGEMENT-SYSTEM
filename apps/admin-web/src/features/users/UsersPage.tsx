import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
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

type EmployeeOption = {
  id: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
  hireDate?: string;
  user?: { email?: string } | null;
  department: { name: string };
  position: { title: string };
};

type UserFilter = "ALL" | "ACTIVE" | "INACTIVE";
type Notification = { type: "success" | "error"; message: string } | null;

const initialForm = {
  email: "",
  employeeId: "",
  firstName: "",
  lastName: "",
  hireDate: "",
  department: "",
  position: "",
  role: "ADMIN",
};

// Looks across ALL of the account's roles, not just the first one — a
// promoted account is now EMPLOYEE + SUPERVISOR/ADMIN, and array order isn't
// guaranteed to put the elevated role first.
function getRoleLabel(userRoles: UserRow["userRoles"]) {
  const codes = userRoles.map((userRole) => userRole.role.code);
  if (codes.includes("ADMIN")) return "HR Admin";
  if (codes.includes("SUPERVISOR")) return "Supervisor";
  return "No Role";
}

function getUserDisplayName(user: UserRow) {
  return user.employee ? `${user.employee.firstName} ${user.employee.lastName}` : "Unassigned";
}

export function UsersPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [filter, setFilter] = useState<UserFilter>("ALL");
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [form, setForm] = useState(initialForm);
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [isLoadingEmployees, setIsLoadingEmployees] = useState(false);
  const [employeeError, setEmployeeError] = useState("");
  const [isEmployeeSearchOpen, setIsEmployeeSearchOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null);
  const [confirmUser, setConfirmUser] = useState<UserRow | null>(null);
  const [error, setError] = useState("");
  const [notification, setNotification] = useState<Notification>(null);
  const [suggestionsRect, setSuggestionsRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const searchWrapperRef = useRef<HTMLDivElement>(null);
  const suggestionsPortalRef = useRef<HTMLDivElement>(null);
  const modalBodyRef = useRef<HTMLDivElement>(null);

  const loadUsers = () => {
    apiRequest<UserRow[]>("/users").then(setUsers).catch(() => undefined);
  };

  useEffect(loadUsers, []);

  useEffect(() => {
    if (!isAddOpen) return;

    setIsLoadingEmployees(true);
    setEmployeeError("");

    apiRequest<EmployeeOption[]>("/employees")
      .then(setEmployees)
      .catch((err) => setEmployeeError(err instanceof Error ? err.message : "Unable to load employees."))
      .finally(() => setIsLoadingEmployees(false));
  }, [isAddOpen]);

  useEffect(() => {
    if (!notification) return;

    const timeoutId = window.setTimeout(() => setNotification(null), 3500);
    return () => window.clearTimeout(timeoutId);
  }, [notification]);

  // The suggestions dropdown renders in a portal (so it can float above the
  // modal's scrollable body instead of being clipped by it) — its position
  // is measured from the search input rather than relying on CSS `absolute`.
  useEffect(() => {
    if (!isEmployeeSearchOpen) {
      setSuggestionsRect(null);
      return;
    }

    const updateRect = () => {
      const rect = searchWrapperRef.current?.getBoundingClientRect();
      if (rect) setSuggestionsRect({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    };

    updateRect();

    const bodyEl = modalBodyRef.current;
    bodyEl?.addEventListener("scroll", updateRect);
    window.addEventListener("resize", updateRect);
    return () => {
      bodyEl?.removeEventListener("scroll", updateRect);
      window.removeEventListener("resize", updateRect);
    };
  }, [isEmployeeSearchOpen]);

  useEffect(() => {
    if (!isEmployeeSearchOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !searchWrapperRef.current?.contains(target) &&
        !suggestionsPortalRef.current?.contains(target)
      ) {
        setIsEmployeeSearchOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isEmployeeSearchOpen]);

  const activeCount = users.filter((user) => user.status === "ACTIVE").length;
  const inactiveCount = users.length - activeCount;
  const visibleUsers = users.filter((user) => {
    if (filter === "ALL") return true;
    return user.status === filter;
  });

  const closeAddUser = () => {
    setIsAddOpen(false);
    setForm(initialForm);
    setEmployeeSearch("");
    setEmployeeError("");
    setIsEmployeeSearchOpen(false);
    setError("");
  };

  const visibleEmployeeOptions = employeeSearch.trim()
    ? employees
        .filter((employee) => {
          const query = employeeSearch.trim().toLowerCase();
          const fullName = `${employee.firstName} ${employee.lastName}`.toLowerCase();
          const email = employee.user?.email?.toLowerCase() ?? "";
          return (
            fullName.includes(query) ||
            employee.employeeNo.toLowerCase().includes(query) ||
            email.includes(query)
          );
        })
        .slice(0, 6)
    : [];

  const selectEmployee = (employee: EmployeeOption) => {
    setEmployeeSearch(`${employee.firstName} ${employee.lastName}`);
    setForm((current) => ({
      ...current,
      employeeId: employee.id,
      firstName: employee.firstName,
      lastName: employee.lastName,
      email: employee.user?.email ?? current.email,
      hireDate: employee.hireDate ? employee.hireDate.slice(0, 10) : "",
      department: employee.department.name,
      position: employee.position.title,
    }));
    setIsEmployeeSearchOpen(false);
  };

  const clearEmployeeSearch = () => {
    setEmployeeSearch("");
    setIsEmployeeSearchOpen(false);
    setForm((current) => ({ ...current, employeeId: "", department: "", position: "" }));
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
      // Assigning a role only ever sends employeeId + role — their existing
      // email/password from Employee Management are never touched here.
      await apiRequest("/users", {
        method: "POST",
        body: JSON.stringify({ employeeId: form.employeeId, role: form.role }),
      });
      closeAddUser();
      setNotification({ type: "success", message: "Role assigned successfully." });
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

      <div className="users-filter-bar">
        <div className="users-filter-group">
          <span className="users-filter-label">View</span>
          <div className="filter-tabs">
            <button className={filter === "ALL" ? "active" : ""} onClick={() => setFilter("ALL")}>All Users ({users.length})</button>
            <button className={filter === "ACTIVE" ? "active" : ""} onClick={() => setFilter("ACTIVE")}>Active ({activeCount})</button>
            <button className={filter === "INACTIVE" ? "active" : ""} onClick={() => setFilter("INACTIVE")}>Inactive ({inactiveCount})</button>
          </div>
        </div>

        <div className="users-filter-actions">
          <button className="add-user-button" onClick={() => setIsAddOpen(true)}>
            <Plus size={15} />
            Add User
          </button>
        </div>
      </div>

      <section className="table-card users-table-card">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>NAME</th>
              <th>EMAIL</th>
              <th>ROLE</th>
              <th>STATUS</th>
              <th>ACTION</th>
            </tr>
          </thead>
          <tbody>
            {visibleUsers.map((user) => (
              <tr key={user.id}>
                <td data-label="ID">{user.id.slice(0, 8)}</td>
                <td data-label="Name">{getUserDisplayName(user)}</td>
                <td data-label="Email">{user.email}</td>
                <td data-label="Role" className="role-cell"><Badge tone="role">{getRoleLabel(user.userRoles)}</Badge></td>
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
                <p>Search for an employee and assign them a system role.</p>
              </div>
              <button className="icon-button" onClick={closeAddUser} aria-label="Close add user form">
                <X size={18} />
              </button>
            </div>

            <form className="user-form" onSubmit={handleCreateUser}>
              <div className="user-form-body" ref={modalBodyRef}>
                <label className="employee-search-field">
                  Employee
                  <div className="employee-search-control" ref={searchWrapperRef}>
                    <input
                      type="text"
                      value={employeeSearch}
                      onFocus={() => setIsEmployeeSearchOpen(true)}
                      onChange={(event) => {
                        setEmployeeSearch(event.target.value);
                        setIsEmployeeSearchOpen(true);
                      }}
                      placeholder="Search by Employee ID, Name, or Email"
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="employee-search-clear"
                      onClick={clearEmployeeSearch}
                      aria-label="Clear employee search"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </label>

                {isEmployeeSearchOpen && employeeSearch.trim() && suggestionsRect &&
                  createPortal(
                    <div
                      className="employee-suggestions employee-suggestions-portal"
                      role="listbox"
                      ref={suggestionsPortalRef}
                      style={{ top: suggestionsRect.top, left: suggestionsRect.left, width: suggestionsRect.width }}
                    >
                      {isLoadingEmployees && <div className="employee-suggestion-state">Loading employees...</div>}
                      {!isLoadingEmployees && employeeError && (
                        <div className="employee-suggestion-state error">{employeeError}</div>
                      )}
                      {!isLoadingEmployees && !employeeError && visibleEmployeeOptions.length === 0 && (
                        <div className="employee-suggestion-state">No matching employees found.</div>
                      )}
                      {!isLoadingEmployees && !employeeError && visibleEmployeeOptions.map((employee) => (
                        <button
                          type="button"
                          key={employee.id}
                          className="employee-suggestion"
                          onClick={() => selectEmployee(employee)}
                          role="option"
                        >
                          <span>{employee.firstName} {employee.lastName}</span>
                          <small>{employee.employeeNo}</small>
                        </button>
                      ))}
                    </div>,
                    document.body,
                  )}

                {form.employeeId ? (
                  <>
                    <div className="selected-employee-summary">
                      <div className="add-user-form-grid">
                        <div className="readonly-field">
                          <span className="readonly-field-label">First Name</span>
                          <span className="readonly-field-value">{form.firstName}</span>
                        </div>
                        <div className="readonly-field">
                          <span className="readonly-field-label">Last Name</span>
                          <span className="readonly-field-value">{form.lastName}</span>
                        </div>
                      </div>
                      <div className="add-user-form-grid">
                        <div className="readonly-field">
                          <span className="readonly-field-label">Email</span>
                          <span className="readonly-field-value">{form.email}</span>
                        </div>
                        <div className="readonly-field">
                          <span className="readonly-field-label">Hire Date</span>
                          <span className="readonly-field-value">{form.hireDate || "—"}</span>
                        </div>
                      </div>
                      <p className="selected-employee-note">Using this employee's existing login — email and password are unchanged.</p>
                    </div>

                    <label>
                      Department
                      <input type="text" value={form.department} readOnly />
                    </label>

                    <label>
                      Position
                      <input type="text" value={form.position} readOnly />
                    </label>

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
                    </div>
                  </>
                ) : (
                  <p className="employee-search-hint">Search for an employee above to assign a role.</p>
                )}

                {error && <p className="user-form-error">{error}</p>}
              </div>

              <div className="user-form-actions">
                <button type="submit" className="primary-button" disabled={isSaving || !form.employeeId}>
                  {isSaving ? "Adding..." : "Add User"}
                </button>
                <button type="button" className="outline-button" onClick={closeAddUser}>Cancel</button>
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
              <button
                type="button"
                className="outline-button"
                onClick={() => setConfirmUser(null)}
                disabled={updatingUserId === confirmUser.id}
              >
                Cancel
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
