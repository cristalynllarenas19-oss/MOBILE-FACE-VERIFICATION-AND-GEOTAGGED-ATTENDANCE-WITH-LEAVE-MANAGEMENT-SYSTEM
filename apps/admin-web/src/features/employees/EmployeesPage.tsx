import axios from "axios";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { AlertTriangle, Archive, CheckCircle2, Eye, Pencil, Plus, Search, X } from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { DropdownFilter } from "../../components/ui/DropdownFilter";
import { apiRequest } from "../../lib/api";
import { useCachedData } from "../../lib/dataCache";
import { PermissionCode, permissions } from "../../types/rbac";
import "./EmployeesPage.css";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001/api/v1";

type Employee = {
  id: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
  employmentStatus: "REGULAR" | "CONTRACTUAL_SEASONAL" | "PIECE_RATE" | "SEPARATED";
  soloParentStatus: "NOT_APPLICABLE" | "ELIGIBLE" | "INELIGIBLE";
  sex?: "MALE" | "FEMALE" | null;
  attendanceMode: "FIXED" | "FIELD";
  hireDate?: string;
  archiveType?: string;
  archiveReason?: string;
  archiveDate?: string;
  user?: { email: string } | null;
  department: { name: string };
  position: { title: string };
  supervisor?: { id: string; firstName: string; lastName: string } | null;
};

type SupervisorOption = {
  id: string;
  firstName: string;
  lastName: string;
  employeeNo?: string;
  department: { name: string };
};

type EmployeeForm = {
  firstName: string;
  lastName: string;
  email: string;
  department: string;
  // Kept here (rather than split into two types) because EditEmployeeForm
  // reuses this shape and Edit still collects a position — only the Add
  // form no longer asks for or sends it.
  position: string;
  hireDate: string;
  employmentStatus: "REGULAR" | "CONTRACTUAL_SEASONAL" | "PIECE_RATE";
  attendanceMode: "FIXED" | "FIELD";
  soloParentStatus: "NOT_APPLICABLE" | "ELIGIBLE" | "INELIGIBLE";
  sex: "MALE" | "FEMALE";
  // "" = no supervisor assigned.
  supervisorId: string;
};

type EditEmployeeForm = EmployeeForm;

type Notification = { type: "success" | "error"; message: string } | null;

const initialForm: EmployeeForm = {
  firstName: "",
  lastName: "",
  email: "",
  department: "",
  position: "",
  hireDate: "",
  employmentStatus: "REGULAR",
  attendanceMode: "FIXED",
  soloParentStatus: "NOT_APPLICABLE",
  sex: "MALE",
  supervisorId: "",
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

  return relative ? `${exact} · ${relative}` : exact;
}

function getStatusTone(status: Employee["employmentStatus"]) {
  if (status === "REGULAR") return "success";
  if (status === "SEPARATED") return "danger";
  return "warning";
}

function getAttendanceModeTone(mode: Employee["attendanceMode"]) {
  return mode === "FIELD" ? "role" : "neutral";
}

function getAttendanceModeLabel(mode: Employee["attendanceMode"], short = false) {
  if (mode === "FIELD") return short ? "Field" : "Field Technician";
  return "Fixed";
}

const EMPLOYMENT_STATUS_LABELS: Record<Employee["employmentStatus"], string> = {
  REGULAR: "Regular Employee",
  CONTRACTUAL_SEASONAL: "Contractual Employee (Seasonal)",
  PIECE_RATE: "Piece-rate (Pakyawan) Worker",
  SEPARATED: "Separated",
};

function getStatusLabel(employee: Employee) {
  if (employee.employmentStatus === "SEPARATED" && employee.archiveType) {
    return employee.archiveType;
  }
  return EMPLOYMENT_STATUS_LABELS[employee.employmentStatus];
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
  small,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  small?: boolean;
}) {
  return (
    <div className="employee-modal-backdrop" role="presentation">
      <section
        className={`employee-modal${small ? " employee-modal--archive" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="employee-modal-title"
      >
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
  supervisors,
  lockedDepartmentName,
  onClose,
  onCreated,
}: {
  departments: string[];
  supervisors: SupervisorOption[];
  lockedDepartmentName?: string;
  onClose: () => void;
  onCreated: (employee: Employee) => void;
}) {
  const [form, setForm] = useState(() => ({
    ...initialForm,
    department: lockedDepartmentName ?? initialForm.department,
  }));
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  // Supervisor is auto-assigned from the chosen department (first supervisor
  // registered for it); the Add form no longer exposes a supervisor picker.
  const autoSupervisor = supervisors.find(
    (supervisor) => supervisor.department.name === form.department.trim(),
  );

  const updateField =
    (field: keyof EmployeeForm) =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setForm((current) => ({ ...current, [field]: event.target.value }));
    };

  const validateForm = () => {
    if (!form.firstName.trim() || !form.lastName.trim()) return "Employee name is required.";
    if (!form.email.trim()) return "Email is required.";
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) return "Enter a valid email address.";
    if (!form.department.trim()) return "Department is required.";
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
          department: form.department.trim(),
          employmentStatus: form.employmentStatus,
          attendanceMode: form.attendanceMode,
          sex: form.sex,
          soloParentStatus: form.soloParentStatus,
          ...(form.hireDate ? { hireDate: form.hireDate } : {}),
          ...(autoSupervisor ? { supervisorId: autoSupervisor.id } : {}),
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
    <EmployeeModal
      title="Add Employee"
      description="Create an employee profile. They'll set their own password on first login."
      onClose={onClose}
    >
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
            Department
            {lockedDepartmentName ? (
              <input type="text" value={lockedDepartmentName} disabled readOnly />
            ) : (
              <>
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
              </>
            )}
          </label>
          {form.department.trim() && (
            <label>
              Supervisor
              <input
                type="text"
                value={autoSupervisor ? `${autoSupervisor.firstName} ${autoSupervisor.lastName}` : ""}
                placeholder="No supervisor registered for this department yet."
                disabled
                readOnly
              />
            </label>
          )}
        </div>

        <div className="employee-form-grid">
          <label>
            Employment Status
            <select value={form.employmentStatus} onChange={updateField("employmentStatus")}>
              <option value="REGULAR">Regular Employee</option>
              <option value="CONTRACTUAL_SEASONAL">Contractual Employee (Seasonal)</option>
              <option value="PIECE_RATE">Piece-rate (Pakyawan) Worker</option>
            </select>
          </label>
          <label>
            Sex/Gender
            <select value={form.sex} onChange={updateField("sex")}>
              <option value="MALE">Male</option>
              <option value="FEMALE">Female</option>
            </select>
          </label>
        </div>

        <div className="employee-form-grid">
          <label>
            Hire Date
            <input type="date" value={form.hireDate} onChange={updateField("hireDate")} />
          </label>
          <label>
            Attendance Mode
            <select value={form.attendanceMode} onChange={updateField("attendanceMode")}>
              <option value="FIXED">Fixed (office/site)</option>
              <option value="FIELD">Field Technician (multi-site)</option>
            </select>
          </label>
        </div>

        {error && <p className="employee-form-error">{error}</p>}

        <div className="employee-form-actions">
          <button type="submit" className="primary-button" disabled={isSaving}>
            {isSaving ? "Adding..." : "Add Employee"}
          </button>
          <button type="button" className="outline-button" onClick={onClose} disabled={isSaving}>
            Cancel
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
  supervisors,
  lockedDepartmentName,
  onClose,
  onUpdated,
}: {
  employee: Employee;
  departments: string[];
  positions: string[];
  supervisors: SupervisorOption[];
  lockedDepartmentName?: string;
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
    attendanceMode: employee.attendanceMode ?? "FIXED",
    soloParentStatus: employee.soloParentStatus ?? "NOT_APPLICABLE",
    sex: employee.sex === "FEMALE" ? "FEMALE" : "MALE",
    supervisorId: employee.supervisor?.id ?? "",
  });
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const [leaveAllocation, setLeaveAllocation] = useState("");
  const [isAllocationLoading, setIsAllocationLoading] = useState(false);

  // Admin-grant-only leave types (Solo Parent, Study Leave, Added Paternity
  // Leave) — checking one here grants that type's default day allotment to
  // this employee; unchecking revokes it. Until granted, employees can't
  // select these when applying for leave.
  const [adminGrantTypes, setAdminGrantTypes] = useState<{ id: string; name: string; defaultDays: string }[]>([]);
  const [grantedTypeIds, setGrantedTypeIds] = useState<Set<string>>(new Set());
  const [initialGrantedTypeIds, setInitialGrantedTypeIds] = useState<Set<string>>(new Set());
  const [isGrantsLoading, setIsGrantsLoading] = useState(false);

  const availableSupervisors = supervisors.filter(
    (supervisor) => supervisor.id !== employee.id && supervisor.department.name === form.department.trim(),
  );

  const genderLeaveLabel =
    employee.sex === "MALE"
      ? "Paternity Leave Allocation (days)"
      : employee.sex === "FEMALE"
        ? "Maternity Leave Allocation (days)"
        : null;

  useEffect(() => {
    if (!employee.sex) return;
    const leaveTypeName = employee.sex === "MALE" ? "Paternity Leave" : "Maternity Leave";

    setIsAllocationLoading(true);
    apiRequest<{ leaveTypeName: string; earnedDays: number }[]>(`/leave-balances/${employee.id}`)
      .then((balances) => {
        const match = balances.find((balance) => balance.leaveTypeName === leaveTypeName);
        setLeaveAllocation(match ? String(match.earnedDays) : "");
      })
      .catch(() => undefined)
      .finally(() => setIsAllocationLoading(false));
  }, [employee.id, employee.sex]);

  useEffect(() => {
    setIsGrantsLoading(true);
    Promise.all([
      apiRequest<{ id: string; name: string; defaultDays: string; requiresAdminGrant: boolean; isActive: boolean }[]>(
        "/leave-types",
      ),
      apiRequest<{ leaveTypeId: string; earnedDays: number }[]>(`/leave-balances/${employee.id}`),
    ])
      .then(([types, balances]) => {
        // Added Paternity Leave (the extra days a mother transfers from her
        // own Maternity Leave) only ever applies to a male employee — hide
        // the checkbox for anyone else so it can't be granted where it
        // doesn't make sense.
        const grantTypes = types.filter((t) => {
          if (!t.requiresAdminGrant || !t.isActive) return false;
          if (t.name === "Added Paternity Leave" && employee.sex !== "MALE") return false;
          return true;
        });
        setAdminGrantTypes(grantTypes);
        const granted = new Set(
          balances
            .filter((b) => b.earnedDays > 0 && grantTypes.some((t) => t.id === b.leaveTypeId))
            .map((b) => b.leaveTypeId),
        );
        setGrantedTypeIds(granted);
        setInitialGrantedTypeIds(granted);
      })
      .catch(() => undefined)
      .finally(() => setIsGrantsLoading(false));
  }, [employee.id]);

  const toggleGrantedType = (typeId: string) => {
    setGrantedTypeIds((current) => {
      const next = new Set(current);
      if (next.has(typeId)) next.delete(typeId);
      else next.add(typeId);
      return next;
    });
  };

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
          attendanceMode: form.attendanceMode,
          soloParentStatus: form.soloParentStatus,
          supervisorId: form.supervisorId,
          ...(form.hireDate ? { hireDate: form.hireDate } : {}),
          ...(employee.sex && leaveAllocation !== "" ? { leaveAllocationDays: Number(leaveAllocation) } : {}),
        },
        {
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
      );

      // Grant/revoke access to the admin-grant-only leave types whose
      // checkbox state changed — checking grants that type's default day
      // allotment, unchecking zeroes it back out (findForEmployee treats a
      // 0-day admin-grant balance as "not granted").
      const changedTypeIds = adminGrantTypes
        .filter((t) => grantedTypeIds.has(t.id) !== initialGrantedTypeIds.has(t.id))
        .map((t) => t.id);

      if (changedTypeIds.length > 0) {
        await Promise.all(
          changedTypeIds.map((typeId) => {
            const type = adminGrantTypes.find((t) => t.id === typeId)!;
            const isGranted = grantedTypeIds.has(typeId);
            return apiRequest(`/leave-balances/${employee.id}/grant`, {
              method: "POST",
              body: JSON.stringify({
                leaveTypeId: typeId,
                earnedDays: isGranted ? Number(type.defaultDays) : 0,
              }),
            });
          }),
        );
      }

      onUpdated(response.data);
    } catch (err) {
      const message =
        axios.isAxiosError(err) && err.response?.data
          ? typeof err.response.data === "string"
            ? err.response.data
            : "Unable to update employee."
          : err instanceof Error
            ? err.message
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
              <option value="REGULAR">Regular Employee</option>
              <option value="CONTRACTUAL_SEASONAL">Contractual Employee (Seasonal)</option>
              <option value="PIECE_RATE">Piece-rate (Pakyawan) Worker</option>
            </select>
          </label>
        </div>

        <div className="employee-form-grid">
          <label>
            Department
            {lockedDepartmentName ? (
              <input type="text" value={lockedDepartmentName} disabled readOnly />
            ) : (
              <>
                <input
                  type="text"
                  value={form.department}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, department: event.target.value, supervisorId: "" }))
                  }
                  list="edit-employee-departments"
                  required
                />
                <datalist id="edit-employee-departments">
                  {departments.map((department) => (
                    <option key={department} value={department} />
                  ))}
                </datalist>
              </>
            )}
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

        <div className="employee-form-grid">
          <label>
            Hire Date
            <input type="date" value={form.hireDate} onChange={updateField("hireDate")} />
          </label>
          <label>
            Attendance Mode
            <select value={form.attendanceMode} onChange={updateField("attendanceMode")}>
              <option value="FIXED">Fixed (office/site)</option>
              <option value="FIELD">Field Technician (multi-site)</option>
            </select>
          </label>
        </div>

        <div className="employee-form-grid">
          <label>
            Supervisor
            <select value={form.supervisorId} onChange={updateField("supervisorId")}>
              <option value="">No supervisor assigned</option>
              {availableSupervisors.map((supervisor) => (
                <option key={supervisor.id} value={supervisor.id}>
                  {supervisor.firstName} {supervisor.lastName}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="employee-form-grid">
          <label>
            Solo Parent Status
            <select value={form.soloParentStatus} onChange={updateField("soloParentStatus")}>
              <option value="NOT_APPLICABLE">Not Applicable</option>
              <option value="ELIGIBLE">Eligible</option>
              <option value="INELIGIBLE">Ineligible</option>
            </select>
          </label>
        </div>

        {genderLeaveLabel && (
          <div className="employee-form-grid">
            <label>
              {genderLeaveLabel}
              <input
                type="number"
                min={0}
                step={1}
                value={leaveAllocation}
                onChange={(event) => setLeaveAllocation(event.target.value)}
                placeholder={isAllocationLoading ? "Loading..." : "0"}
                disabled={isAllocationLoading}
              />
            </label>
          </div>
        )}

        {adminGrantTypes.length > 0 && (
          <div className="employee-leave-grants">
            <p className="employee-leave-grants-title">
              Additional Leave Types{isGrantsLoading ? " (loading…)" : ""}
            </p>
            <p className="employee-leave-grants-hint">
              These leave types are only available to an employee once granted here. Checking one grants its default
              day allotment; unchecking revokes it.
            </p>
            {adminGrantTypes.map((type) => (
              <label key={type.id} className="employee-leave-grant-row">
                <input
                  type="checkbox"
                  checked={grantedTypeIds.has(type.id)}
                  disabled={isGrantsLoading}
                  onChange={() => toggleGrantedType(type.id)}
                />
                <span>
                  {type.name} <span className="grant-days">({type.defaultDays} day{Number(type.defaultDays) === 1 ? "" : "s"})</span>
                </span>
              </label>
            ))}
          </div>
        )}

        {error && <p className="employee-form-error">{error}</p>}

        <div className="employee-form-actions">
          <button type="submit" className="primary-button" disabled={isSaving}>
            {isSaving ? "Saving..." : "Save Changes"}
          </button>
          <button type="button" className="outline-button" onClick={onClose} disabled={isSaving}>
            Cancel
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
          <span>Supervisor</span>
          <strong>
            {employee.supervisor ? `${employee.supervisor.firstName} ${employee.supervisor.lastName}` : "Unassigned"}
          </strong>
        </div>
        <div>
          <span>Status</span>
          <Badge tone={getStatusTone(employee.employmentStatus)}>
            {getStatusLabel(employee)}
          </Badge>
        </div>
        <div>
          <span>Attendance Mode</span>
          <Badge tone={getAttendanceModeTone(employee.attendanceMode)}>
            {getAttendanceModeLabel(employee.attendanceMode)}
          </Badge>
        </div>
        {employee.soloParentStatus && employee.soloParentStatus !== "NOT_APPLICABLE" && (
          <div>
            <span>Solo Parent Status</span>
            <Badge tone={employee.soloParentStatus === "ELIGIBLE" ? "success" : "danger"}>
              {employee.soloParentStatus === "ELIGIBLE" ? "Eligible" : "Ineligible"}
            </Badge>
          </div>
        )}
      </div>

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
        {canWrite && (
          <button type="button" className="primary-button" onClick={onEdit}>
            <Pencil size={14} />
            Edit Employee
          </button>
        )}
        <button type="button" className="outline-button" onClick={onClose}>
          Close
        </button>
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

  if (!confirmed) {
    return (
      <EmployeeModal title="" onClose={onClose} small>
        <div className="employee-confirm-body">
          <div className="employee-confirm-icon">
            <AlertTriangle size={24} />
          </div>
          <h2 className="employee-confirm-title">Archive Employee</h2>
          <p className="employee-confirm-message">
            Are you sure you want to archive{" "}
            <strong>{getEmployeeName(employee)}</strong>?
            <br />
            Their login will be deactivated.
          </p>
          <div className="employee-confirm-actions">
            <button type="button" className="employee-archive-action" onClick={() => setConfirmed(true)}>
              Archive Employee
            </button>
            <button type="button" className="outline-button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      </EmployeeModal>
    );
  }

  return (
    <EmployeeModal title="Archive Employee" description={getEmployeeName(employee)} onClose={onClose} small>
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
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Reason for resignation, retirement, or separation"
          />
        </label>
        {error && <p className="employee-form-error">{error}</p>}
        <div className="employee-form-actions">
          <button type="submit" className="employee-archive-action" disabled={isSaving}>
            {isSaving ? "Archiving..." : "Archive Employee"}
          </button>
          <button type="button" className="outline-button" onClick={onClose} disabled={isSaving}>
            Cancel
          </button>
        </div>
      </form>
    </EmployeeModal>
  );
}

export function EmployeesPage({
  user,
  onEmployeeCreated,
}: {
  user?: { permissions: PermissionCode[]; roles?: string[]; departmentId?: string; department?: string };
  // When provided, a successful Add Employee hands the new employee to the
  // parent (which redirects straight into Face Registration) instead of
  // showing the local success toast.
  onEmployeeCreated?: (employee: Employee) => void;
}) {
  const canWrite = user?.permissions.includes(permissions.employeesWrite) ?? true;
  // Mirrors the backend's getSupervisorDepartmentScope: a Supervisor who is
  // also an Admin (or not a Supervisor at all) gets full, unscoped access.
  const roles = user?.roles ?? [];
  const isDepartmentLocked = roles.includes("SUPERVISOR") && !roles.includes("ADMIN");
  const lockedDepartmentName = isDepartmentLocked ? user?.department : undefined;

  const [departmentFilter, setDepartmentFilter] = useState("ALL");
  const [showArchivedOnly, setShowArchivedOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [viewEmployee, setViewEmployee] = useState<Employee | null>(null);
  const [editEmployee, setEditEmployee] = useState<Employee | null>(null);
  const [archiveEmployee, setArchiveEmployee] = useState<Employee | null>(null);
  const [notification, setNotification] = useState<Notification>(null);

  // Same "employees" cache key as AttendancePage — both read GET /employees,
  // so one fetched copy serves both pages.
  const employeesCache = useCachedData<Employee[]>("employees", () => apiRequest<Employee[]>("/employees"));
  const employees = employeesCache.data ?? [];

  const supervisorsCache = useCachedData<SupervisorOption[]>("supervisors", () =>
    apiRequest<SupervisorOption[]>("/employees/supervisors"),
  );
  const supervisors = supervisorsCache.data ?? [];

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
    // Newest employee goes to the top (LIFO), matching the backend's createdAt-desc order.
    employeesCache.setData([employee, ...employees]);
    setIsAddOpen(false);
    if (onEmployeeCreated) {
      onEmployeeCreated(employee);
      return;
    }
    setNotification({ type: "success", message: "Employee was added successfully." });
  };

  const handleEmployeeUpdated = (employee: Employee) => {
    employeesCache.setData(employees.map((item) => (item.id === employee.id ? employee : item)));
    setViewEmployee((current) => (current?.id === employee.id ? employee : current));
    setEditEmployee(null);
    setNotification({ type: "success", message: "Employee was updated successfully." });
  };

  const handleEmployeeArchived = (employee: Employee) => {
    employeesCache.setData(employees.map((item) => (item.id === employee.id ? employee : item)));
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

      <div className="employees-filter-bar">
        {/* VIEW — Active employees tab */}
        <div className="employees-filter-group">
          <span className="employees-filter-label">View</span>
          <div className="filter-tabs">
            <button
              className={!showArchivedOnly ? "active" : ""}
              onClick={() => setShowArchivedOnly(false)}
            >
              All Employees ({activeEmployeeCount})
            </button>
          </div>
        </div>

        {/* ARCHIVE — Archived employees tab */}
        <div className="employees-filter-group">
          <span className="employees-filter-label">Archive</span>
          <div className="filter-tabs">
            <button
              className={showArchivedOnly ? "active" : ""}
              onClick={() => setShowArchivedOnly(true)}
            >
              Archived Employees
            </button>
          </div>
        </div>

        {!isDepartmentLocked && (
          <div className="employees-filter-group">
            <label className="employees-filter-label">Department</label>
            <DropdownFilter
              className="department-select"
              value={departmentFilter}
              onChange={setDepartmentFilter}
              options={departments.map((department) => ({ value: department, label: department }))}
              allLabel="All Departments"
              menuLabel="Filter by department"
              ariaLabel="Filter employees by department"
            />
          </div>
        )}

        <div className="employees-filter-group employees-filter-search-group">
          <label className="employees-filter-label">Search</label>
          <div className="employee-search">
            <Search size={14} className="employee-search-icon" />
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search employees..."
              aria-label="Search employees"
            />
            <button
              type="button"
              className="employee-search-clear"
              onClick={() => setSearchQuery("")}
              aria-label="Clear search"
            >
              <X size={13} />
            </button>
          </div>
        </div>

        <div className="employees-filter-actions">
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
              <th>EMPLOYEE NO.</th>
              <th>NAME</th>
              <th>EMAIL</th>
              <th>DEPARTMENT</th>
              <th>POSITION</th>
              <th>STATUS</th>
              <th>MODE</th>
              <th>ACTION</th>
            </tr>
          </thead>
          <tbody>
            {visibleEmployees.length === 0 ? (
              <tr>
                <td colSpan={8} className="employees-empty-state">
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
                    <Badge tone={getStatusTone(employee.employmentStatus)}>
                      {getStatusLabel(employee)}
                    </Badge>
                  </td>
                  <td data-label="Mode" className="employee-status-cell">
                    <Badge tone="neutral">
                      {getAttendanceModeLabel(employee.attendanceMode, true)}
                    </Badge>
                  </td>
                  <td data-label="Action">
                    <div className="employee-action-group">
                      <button
                        className="employee-view-button"
                        onClick={() => setViewEmployee(employee)}
                      >
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
          supervisors={supervisors}
          lockedDepartmentName={lockedDepartmentName}
          onClose={() => setEditEmployee(null)}
          onUpdated={(updatedEmployee) => {
            handleEmployeeUpdated(updatedEmployee);
            supervisorsCache.refresh().catch(() => undefined);
          }}
        />
      )}

      {isAddOpen && (
        <AddEmployeeModal
          departments={departments}
          supervisors={supervisors}
          lockedDepartmentName={lockedDepartmentName}
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