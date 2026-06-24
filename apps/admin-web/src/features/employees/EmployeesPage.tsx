import axios from "axios";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { AlertTriangle, Archive, CheckCircle2, Eye, Pencil, Plus, Search, X } from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { apiRequest } from "../../lib/api";
import { PermissionCode, permissions } from "../../types/rbac";
import "./EmployeesPage.css";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001/api/v1";

type Employee = {
  id: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
  employmentStatus: "REGULAR" | "PROBATIONARY" | "CONTRACTUAL" | "SEPARATED";
  hireDate?: string;
  archiveType?: string;
  archiveReason?: string;
  archiveDate?: string;
  user?: { email: string } | null;
  department: { name: string };
  position: { title: string };
};

type EmployeeForm = {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  department: string;
  position: string;
  hireDate: string;
  employmentStatus: "REGULAR" | "PROBATIONARY" | "CONTRACTUAL";
};

type EditEmployeeForm = Omit<EmployeeForm, "password">;

type Notification = { type: "success" | "error"; message: string } | null;

const initialForm: EmployeeForm = {
  firstName: "",
  lastName: "",
  email: "",
  password: "",
  department: "",
  position: "",
  hireDate: "",
  employmentStatus: "REGULAR",
};

function getDateInputValue(value?: string) {
  return value ? value.slice(0, 10) : "";
}

function formatRelativeTime(value: string) {
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "";

  const now = Date.now();
  const diffDays = Math.round((now - then) / (1000 * 60 * 60 * 24));

  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 30) return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;

  const diffMonths = Math.round(diffDays / 30);
  if (diffMonths < 12) return diffMonths === 1 ? "last month" : `${diffMonths} months ago`;

  const diffYears = Math.round(diffMonths / 12);
  return diffYears === 1 ? "1 year ago" : `${diffYears} years ago`;
}

function formatArchiveDate(value?: string) {
  if (!value) return "";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const exact = date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const relative = formatRelativeTime(value);

  return relative ? `${exact} \u00b7 ${relative}` : exact;
}

function getStatusTone(status: Employee["employmentStatus"]) {
  if (status === "REGULAR") return "success";
  if (status === "SEPARATED") return "danger";
  return "warning";
}

// FIX 1: Show archiveType label instead of "SEPARATED" for archived employees
function getStatusLabel(employee: Employee) {
  if (employee.employmentStatus === "SEPARATED" && employee.archiveType) {
    return employee.archiveType;
  }
  return employee.employmentStatus;
}

function getEmployeeName(employee: Employee) {
  return `${employee.firstName} ${employee.lastName}`;
}

function matchesSearch(employee: Employee, query: string) {
  if (!query.trim()) return true;

  const needle = query.trim().toLowerCase();
  const haystacks = [
    employee.employeeNo,
    employee.firstName,
    employee.lastName,
    getEmployeeName(employee),
    employee.user?.email ?? "",
    employee.department.name,
    employee.position.title,
    employee.employmentStatus,
  ];

  return haystacks.some((value) => value.toLowerCase().includes(needle));
}

function EmployeeModal({
  title,
  description,
  children,
  onClose,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="employee-modal-backdrop" role="presentation">
      <section className="employee-modal" role="dialog" aria-modal="true" aria-labelledby="employee-modal-title">
        <div className="employee-modal-header">
          <div>
            {title && <h2 id="employee-modal-title">{title}</h2>}
            {description && <p>{description}</p>}
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close employee modal">
            <X size={18} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

function AddEmployeeModal({
  departments,
  positions,
  onClose,
  onCreated,
}: {
  departments: string[];
  positions: string[];
  onClose: () => void;
  onCreated: (employee: Employee) => void;
}) {
  const [form, setForm] = useState(initialForm);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  const updateField =
    (field: keyof EmployeeForm) =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setForm((current) => ({ ...current, [field]: event.target.value }));
    };

  const validateForm = () => {
    if (!form.firstName.trim() || !form.lastName.trim()) return "Employee name is required.";
    if (!form.email.trim()) return "Email is required.";
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) return "Enter a valid email address.";
    if (form.password.length < 8) return "Password must be at least 8 characters.";
    if (!form.department.trim()) return "Department is required.";
    if (!form.position.trim()) return "Position is required.";
    return "";
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validationError = validateForm();

    if (validationError) {
      setError(validationError);
      return;
    }

    setIsSaving(true);
    setError("");

    try {
      const token = localStorage.getItem("accessToken");
      const response = await axios.post<Employee>(
        `${API_BASE_URL}/employees`,
        {
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          email: form.email.trim(),
          password: form.password,
          department: form.department.trim(),
          position: form.position.trim(),
          employmentStatus: form.employmentStatus,
          ...(form.hireDate ? { hireDate: form.hireDate } : {}),
        },
        {
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
      );

      onCreated(response.data);
    } catch (err) {
      const message =
        axios.isAxiosError(err) && err.response?.data
          ? typeof err.response.data === "string"
            ? err.response.data
            : "Unable to add employee."
          : "Unable to add employee.";
      setError(message);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <EmployeeModal title="Add Employee" description="Create an employee profile and login account." onClose={onClose}>
      <form className="employee-form" onSubmit={handleSubmit}>
        <div className="employee-form-grid">
          <label>
            First Name
            <input type="text" value={form.firstName} onChange={updateField("firstName")} placeholder="Juan" required />
          </label>

          <label>
            Last Name
            <input type="text" value={form.lastName} onChange={updateField("lastName")} placeholder="Dela Cruz" required />
          </label>
        </div>

        <div className="employee-form-grid">
          <label>
            Email
            <input type="email" value={form.email} onChange={updateField("email")} placeholder="employee@example.com" required />
          </label>

          <label>
            Password
            <input
              type="password"
              value={form.password}
              onChange={updateField("password")}
              minLength={8}
              placeholder="Minimum 8 characters"
              required
            />
          </label>
        </div>

        <div className="employee-form-grid">
          <label>
            Department
            <input
              type="text"
              value={form.department}
              onChange={updateField("department")}
              list="employee-departments"
              placeholder="Production"
              required
            />
            <datalist id="employee-departments">
              {departments.map((department) => (
                <option key={department} value={department} />
              ))}
            </datalist>
          </label>

          <label>
            Position
            <input
              type="text"
              value={form.position}
              onChange={updateField("position")}
              list="employee-positions"
              placeholder="Leaf Processor"
              required
            />
            <datalist id="employee-positions">
              {positions.map((position) => (
                <option key={position} value={position} />
              ))}
            </datalist>
          </label>
        </div>

        <div className="employee-form-grid">
          <label>
            Employment Status
            <select value={form.employmentStatus} onChange={updateField("employmentStatus")}>
              <option value="REGULAR">Regular</option>
              <option value="PROBATIONARY">Probationary</option>
              <option value="CONTRACTUAL">Contractual</option>
            </select>
          </label>

          <label>
            Hire Date
            <input type="date" value={form.hireDate} onChange={updateField("hireDate")} />
          </label>
        </div>

        {error && <p className="employee-form-error">{error}</p>}

        <div className="employee-form-actions">
          <button type="button" className="outline-button" onClick={onClose} disabled={isSaving}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={isSaving}>
            {isSaving ? "Adding..." : "Add Employee"}
          </button>
        </div>
      </form>
    </EmployeeModal>
  );
}

function EditEmployeeModal({
  employee,
  departments,
  positions,
  onClose,
  onUpdated,
}: {
  employee: Employee;
  departments: string[];
  positions: string[];
  onClose: () => void;
  onUpdated: (employee: Employee) => void;
}) {
  const [form, setForm] = useState<EditEmployeeForm>({
    firstName: employee.firstName,
    lastName: employee.lastName,
    email: employee.user?.email ?? "",
    department: employee.department.name,
    position: employee.position.title,
    hireDate: getDateInputValue(employee.hireDate),
    employmentStatus: employee.employmentStatus === "SEPARATED" ? "REGULAR" : employee.employmentStatus,
  });
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  const updateField =
    (field: keyof EditEmployeeForm) =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setForm((current) => ({ ...current, [field]: event.target.value }));
    };

  const validateForm = () => {
    if (!form.firstName.trim() || !form.lastName.trim()) return "Employee name is required.";
    if (!form.email.trim()) return "Email is required.";
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) return "Enter a valid email address.";
    if (!form.department.trim()) return "Department is required.";
    if (!form.position.trim()) return "Position is required.";
    return "";
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validationError = validateForm();

    if (validationError) {
      setError(validationError);
      return;
    }

    setIsSaving(true);
    setError("");

    try {
      const token = localStorage.getItem("accessToken");
      const response = await axios.patch<Employee>(
        `${API_BASE_URL}/employees/${employee.id}`,
        {
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          email: form.email.trim(),
          department: form.department.trim(),
          position: form.position.trim(),
          employmentStatus: form.employmentStatus,
          ...(form.hireDate ? { hireDate: form.hireDate } : {}),
        },
        {
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
      );

      onUpdated(response.data);
    } catch (err) {
      const message =
        axios.isAxiosError(err) && err.response?.data
          ? typeof err.response.data === "string"
            ? err.response.data
            : "Unable to update employee."
          : "Unable to update employee.";
      setError(message);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <EmployeeModal title="Edit Employee" description={getEmployeeName(employee)} onClose={onClose}>
      <form className="employee-form" onSubmit={handleSubmit}>
        <div className="employee-form-grid">
          <label>
            First Name
            <input type="text" value={form.firstName} onChange={updateField("firstName")} required />
          </label>

          <label>
            Last Name
            <input type="text" value={form.lastName} onChange={updateField("lastName")} required />
          </label>
        </div>

        <div className="employee-form-grid">
          <label>
            Email
            <input type="email" value={form.email} onChange={updateField("email")} required />
          </label>

          <label>
            Employment Status
            <select value={form.employmentStatus} onChange={updateField("employmentStatus")}>
              <option value="REGULAR">Regular</option>
              <option value="PROBATIONARY">Probationary</option>
              <option value="CONTRACTUAL">Contractual</option>
            </select>
          </label>
        </div>

        <div className="employee-form-grid">
          <label>
            Department
            <input type="text" value={form.department} onChange={updateField("department")} list="edit-employee-departments" required />
            <datalist id="edit-employee-departments">
              {departments.map((department) => (
                <option key={department} value={department} />
              ))}
            </datalist>
          </label>

          <label>
            Position
            <input type="text" value={form.position} onChange={updateField("position")} list="edit-employee-positions" required />
            <datalist id="edit-employee-positions">
              {positions.map((position) => (
                <option key={position} value={position} />
              ))}
            </datalist>
          </label>
        </div>

        <div className="employee-form-grid single-field">
          <label>
            Hire Date
            <input type="date" value={form.hireDate} onChange={updateField("hireDate")} />
          </label>
        </div>

        {error && <p className="employee-form-error">{error}</p>}

        <div className="employee-form-actions">
          <button type="button" className="outline-button" onClick={onClose} disabled={isSaving}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={isSaving}>
            {isSaving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </form>
    </EmployeeModal>
  );
}

function ViewEmployeeModal({
  employee,
  onClose,
  onEdit,
  onArchive,
  canWrite,
}: {
  employee: Employee;
  onClose: () => void;
  onEdit: () => void;
  onArchive: () => void;
  canWrite: boolean;
}) {
  return (
    <EmployeeModal title="Employee Details" description={getEmployeeName(employee)} onClose={onClose}>
      <div className="employee-detail-grid">
        <div>
          <span>Employee No.</span>
          <strong>{employee.employeeNo}</strong>
        </div>
        <div>
          <span>Email</span>
          <strong>{employee.user?.email ?? "Unassigned"}</strong>
        </div>
        <div>
          <span>Department</span>
          <strong>{employee.department.name}</strong>
        </div>
        <div>
          <span>Position</span>
          <strong>{employee.position.title}</strong>
        </div>
        <div>
          <span>Status</span>
          {/* FIX 1: Show archiveType instead of "SEPARATED" */}
          <Badge tone={getStatusTone(employee.employmentStatus)}>
            {getStatusLabel(employee)}
          </Badge>
        </div>
      </div>

      {/* FIX 2: Always show archive details block for SEPARATED employees */}
      {employee.employmentStatus === "SEPARATED" && (
        <div className="employee-archive-details">
          <h3>Archive Details</h3>
          <div className="employee-detail-grid">
            {employee.archiveType && (
              <div>
                <span>Type</span>
                <strong>{employee.archiveType}</strong>
              </div>
            )}
            {employee.archiveDate && (
              <div>
                <span>Effective Date</span>
                <strong>{formatArchiveDate(employee.archiveDate)}</strong>
              </div>
            )}
          </div>
          {employee.archiveReason ? (
            <p className="employee-archive-remarks">{employee.archiveReason}</p>
          ) : (
            <p className="employee-archive-remarks" style={{ color: "#9aabbc", fontStyle: "italic" }}>
              No remarks provided.
            </p>
          )}
        </div>
      )}

      <div className="employee-detail-actions">
        {canWrite && employee.employmentStatus !== "SEPARATED" && (
          <button type="button" className="employee-archive-action" onClick={onArchive}>
            <Archive size={14} />
            Archive Employee
          </button>
        )}
        <button type="button" className="outline-button" onClick={onClose}>
          Close
        </button>
        {canWrite && (
          <button type="button" className="primary-button" onClick={onEdit}>
            <Pencil size={14} />
            Edit Employee
          </button>
        )}
      </div>
    </EmployeeModal>
  );
}

function ArchiveEmployeeModal({
  employee,
  onClose,
  onArchived,
}: {
  employee: Employee;
  onClose: () => void;
  onArchived: (employee: Employee) => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [archiveType, setArchiveType] = useState("Resigned");
  const [effectiveDate, setEffectiveDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  const handleArchive = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSaving(true);
    setError("");

    try {
      const archived = await apiRequest<Employee>(`/employees/${employee.id}/archive`, {
        method: "PATCH",
        body: JSON.stringify({ archiveType, effectiveDate, reason }),
      });
      onArchived(archived);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to archive employee.");
    } finally {
      setIsSaving(false);
    }
  };

  // Step 1: Confirmation dialog
  if (!confirmed) {
    return (
      <EmployeeModal title="" onClose={onClose}>
        <div className="employee-confirm-body">
          <div className="employee-confirm-icon">
            <AlertTriangle size={28} />
          </div>
          <h2 className="employee-confirm-title">Archive Employee</h2>
          <p className="employee-confirm-message">
            Are you sure you want to archive{" "}
            <strong>{getEmployeeName(employee)}</strong>?
            <br />
            Their login will be deactivated.
          </p>
          <div className="employee-confirm-actions">
            <button type="button" className="outline-button" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="employee-archive-action" onClick={() => setConfirmed(true)}>
              Archive Employee
            </button>
          </div>
        </div>
      </EmployeeModal>
    );
  }

  // Step 2: Archive details form
  return (
    <EmployeeModal title="Archive Employee" description={getEmployeeName(employee)} onClose={onClose}>
      <form className="employee-form" onSubmit={handleArchive}>
        <div className="employee-form-grid">
          <label>
            Archive Type
            <select value={archiveType} onChange={(event) => setArchiveType(event.target.value)}>
              <option value="Resigned">Resigned</option>
              <option value="Retired">Retired</option>
              <option value="End of Contract">End of Contract</option>
              <option value="Separated">Separated</option>
            </select>
          </label>
          <label>
            Effective Date
            <input
              type="date"
              value={effectiveDate}
              onChange={(event) => setEffectiveDate(event.target.value)}
              required
            />
          </label>
        </div>
        <label className="employee-full-field">
          Reason / Remarks
          <textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason for resignation, retirement, or separation" />
        </label>
        {error && <p className="employee-form-error">{error}</p>}
        <div className="employee-form-actions">
          <button type="button" className="outline-button" onClick={onClose} disabled={isSaving}>
            Cancel
          </button>
          <button type="submit" className="employee-archive-action" disabled={isSaving}>
            {isSaving ? "Archiving..." : "Archive Employee"}
          </button>
        </div>
      </form>
    </EmployeeModal>
  );
}

export function EmployeesPage({ user }: { user?: { permissions: PermissionCode[] } }) {
  const canWrite = user?.permissions.includes(permissions.employeesWrite) ?? true;
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departmentFilter, setDepartmentFilter] = useState("ALL");
  const [showArchivedOnly, setShowArchivedOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [viewEmployee, setViewEmployee] = useState<Employee | null>(null);
  const [editEmployee, setEditEmployee] = useState<Employee | null>(null);
  const [archiveEmployee, setArchiveEmployee] = useState<Employee | null>(null);
  const [notification, setNotification] = useState<Notification>(null);

  const loadEmployees = () => {
    apiRequest<Employee[]>("/employees").then(setEmployees).catch(() => undefined);
  };

  useEffect(loadEmployees, []);

  useEffect(() => {
    if (!notification) return;

    const timeoutId = window.setTimeout(() => setNotification(null), 3500);
    return () => window.clearTimeout(timeoutId);
  }, [notification]);

  const departments = Array.from(new Set(employees.map((employee) => employee.department.name))).sort();
  const positions = Array.from(new Set(employees.map((employee) => employee.position.title))).sort();
  const activeEmployeeCount = employees.filter((employee) => employee.employmentStatus !== "SEPARATED").length;
  const visibleEmployees = employees.filter((employee) => {
    if (departmentFilter !== "ALL" && employee.department.name !== departmentFilter) return false;
    if (showArchivedOnly) {
      if (employee.employmentStatus !== "SEPARATED") return false;
    } else {
      if (employee.employmentStatus === "SEPARATED") return false;
    }
    if (!matchesSearch(employee, searchQuery)) return false;
    return true;
  });

  const handleEmployeeCreated = (employee: Employee) => {
    setEmployees((current) => [...current, employee].sort((a, b) => a.lastName.localeCompare(b.lastName)));
    setIsAddOpen(false);
    setNotification({ type: "success", message: "Employee was added successfully." });
  };

  const handleEmployeeUpdated = (employee: Employee) => {
    setEmployees((current) =>
      current.map((item) => (item.id === employee.id ? employee : item)).sort((a, b) => a.lastName.localeCompare(b.lastName)),
    );
    setViewEmployee((current) => (current?.id === employee.id ? employee : current));
    setEditEmployee(null);
    setNotification({ type: "success", message: "Employee was updated successfully." });
  };

  const handleEmployeeArchived = (employee: Employee) => {
    setEmployees((current) => current.map((item) => (item.id === employee.id ? employee : item)));
    setViewEmployee((current) => (current?.id === employee.id ? employee : current));
    setArchiveEmployee(null);
    setNotification({ type: "success", message: "Employee was archived and their login was deactivated." });
  };

  const openEditEmployee = (employee: Employee) => {
    setViewEmployee(null);
    setEditEmployee(employee);
  };

  return (
    <>
      {notification && (
        <div className={`employees-notification ${notification.type}`} role="status">
          {notification.type === "success" ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
          <span>{notification.message}</span>
        </div>
      )}

      <div className="employees-toolbar">
        <div className="filter-tabs">
          <button
            className={!showArchivedOnly ? "active" : ""}
            onClick={() => setShowArchivedOnly(false)}
          >
            All Employees ({activeEmployeeCount})
          </button>

          <select
            className="department-select"
            value={departmentFilter}
            onChange={(event) => setDepartmentFilter(event.target.value)}
            aria-label="Filter employees by department"
          >
            <option value="ALL">All Departments</option>
            {departments.map((department) => (
              <option key={department} value={department}>
                {department}
              </option>
            ))}
          </select>

          <button
            className={showArchivedOnly ? "active" : ""}
            onClick={() => setShowArchivedOnly(true)}
          >
            Archived Employees
          </button>
        </div>

        <div className="employees-toolbar-actions">
          <div className="employee-search">
            <Search size={14} className="employee-search-icon" />
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search employees..."
              aria-label="Search employees"
            />
            {searchQuery && (
              <button
                type="button"
                className="employee-search-clear"
                onClick={() => setSearchQuery("")}
                aria-label="Clear search"
              >
                <X size={13} />
              </button>
            )}
          </div>

          {canWrite && (
            <button className="add-employee-button" onClick={() => setIsAddOpen(true)}>
              <Plus size={15} />
              Add Employee
            </button>
          )}
        </div>
      </div>

      <section className="table-card employees-table-card">
        <table>
          <thead>
            <tr>
              <th>Employee No.</th>
              <th>Name</th>
              <th>Email</th>
              <th>Department</th>
              <th>Position</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {visibleEmployees.length === 0 ? (
              <tr>
                <td colSpan={7} className="employees-empty-state">
                  No employees found.
                </td>
              </tr>
            ) : (
              visibleEmployees.map((employee) => (
                <tr key={employee.id}>
                  <td data-label="Employee No.">{employee.employeeNo}</td>
                  <td data-label="Name">{getEmployeeName(employee)}</td>
                  <td data-label="Email">{employee.user?.email ?? "Unassigned"}</td>
                  <td data-label="Department">{employee.department.name}</td>
                  <td data-label="Position">{employee.position.title}</td>
                  <td data-label="Status" className="employee-status-cell">
                    {/* FIX 1: Use getStatusLabel to show archiveType instead of "SEPARATED" */}
                    <Badge tone={getStatusTone(employee.employmentStatus)}>
                      {getStatusLabel(employee)}
                    </Badge>
                  </td>
                  <td data-label="Action">
                    <div className="employee-action-group">
                      <button className="employee-view-button" onClick={() => setViewEmployee(employee)}>
                        <Eye size={14} />
                        View
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      {viewEmployee && (
        <ViewEmployeeModal
          employee={viewEmployee}
          onClose={() => setViewEmployee(null)}
          onEdit={() => openEditEmployee(viewEmployee)}
          onArchive={() => {
            setArchiveEmployee(viewEmployee);
            setViewEmployee(null);
          }}
          canWrite={canWrite}
        />
      )}

      {editEmployee && (
        <EditEmployeeModal
          employee={editEmployee}
          departments={departments}
          positions={positions}
          onClose={() => setEditEmployee(null)}
          onUpdated={handleEmployeeUpdated}
        />
      )}

      {isAddOpen && (
        <AddEmployeeModal
          departments={departments}
          positions={positions}
          onClose={() => setIsAddOpen(false)}
          onCreated={handleEmployeeCreated}
        />
      )}

      {archiveEmployee && (
        <ArchiveEmployeeModal
          employee={archiveEmployee}
          onClose={() => setArchiveEmployee(null)}
          onArchived={handleEmployeeArchived}
        />
      )}
    </>
  );
}