import axios from "axios";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AlertTriangle, Archive, ChevronsUpDown, CheckCircle2, Eye, Pencil, Plus, RotateCcw, ScanFace, Search, UserCheck, X } from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { DropdownFilter } from "../../components/ui/DropdownFilter";
import { FormSelectDropdown } from "../../components/ui/FormSelectDropdown";
import { EvaluationViewModal } from "../evaluations/EvaluationViewModal";
import { apiRequest } from "../../lib/api";
import { CACHE_KEYS, revalidateCached, useCachedData } from "../../lib/dataCache";
import { useActiveDepartments } from "../../lib/departments";
import {
  type AttendanceModeOption,
  formatAttendanceMode as getAttendanceModeLabel,
  useAttendanceModeOptions,
} from "../../lib/attendanceModes";
import { PermissionCode, permissions } from "../../types/rbac";
import { EMPLOYMENT_STATUS_LABELS, SELECTABLE_EMPLOYMENT_STATUSES } from "../../types/employment";
import "./EmployeesPage.css";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001/api/v1";

const EMPLOYEES_PAGE_SIZE = 10;

// NestJS error responses are JSON bodies ({ statusCode, message, error }), not
// raw strings — message is a string[] when it comes from the validation
// pipe. Falls back to fallback when nothing usable is found.
function extractErrorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err) && err.response?.data) {
    const data = err.response.data;
    if (typeof data === "string") return data;
    if (data && typeof data === "object" && "message" in data) {
      const message = (data as { message?: unknown }).message;
      if (typeof message === "string") return message;
      if (Array.isArray(message) && message.every((item) => typeof item === "string")) {
        return message.join(" ");
      }
    }
  }
  if (err instanceof Error) return err.message;
  return fallback;
}

type Employee = {
  id: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
  employmentStatus: "REGULAR" | "PROBATIONARY" | "PERMANENT_SEASONAL" | "PROBATIONARY_SEASONAL" | "SEPARATED";
  soloParentStatus: "NOT_APPLICABLE" | "ELIGIBLE" | "INELIGIBLE";
  civilStatus?: "SINGLE" | "MARRIED" | "WIDOWED" | "SEPARATED" | "ANNULLED";
  spouseEmployerName?: string | null;
  spouseUnemployed?: boolean;
  sex?: "MALE" | "FEMALE" | null;
  attendanceMode: AttendanceMode;
  hireDate?: string;
  archiveType?: string;
  archiveReason?: string;
  archiveDate?: string;
  user?: { email: string } | null;
  department: { name: string; attendanceMode: string };
  position: { title: string };
  supervisor?: { id: string; firstName: string; lastName: string } | null;
  faceConsentAcceptedAt?: string | null;
  requiresFaceConsent?: boolean;
};


type AttendanceMode = string;
type DepartmentAttendanceMode = string;

type DepartmentOption = { name: string; attendanceMode: DepartmentAttendanceMode };

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
  position: string;
  hireDate: string;
  employmentStatus: "REGULAR" | "PROBATIONARY" | "PERMANENT_SEASONAL" | "PROBATIONARY_SEASONAL";
  attendanceMode: AttendanceMode;
  soloParentStatus: "NOT_APPLICABLE" | "ELIGIBLE" | "INELIGIBLE";
  civilStatus: "SINGLE" | "MARRIED" | "WIDOWED" | "SEPARATED" | "ANNULLED";
  spouseEmployerName: string;
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
  civilStatus: "SINGLE",
  spouseEmployerName: "",
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

const PROBATION_MILESTONE_MONTHS = 6;


function getTenure(hireDate?: string) {
  if (!hireDate) return null;
  const hired = new Date(hireDate);
  if (Number.isNaN(hired.getTime())) return null;

  const now = new Date();
  let months = (now.getFullYear() - hired.getFullYear()) * 12 + (now.getMonth() - hired.getMonth());
  const monthAnchor = new Date(hired);
  monthAnchor.setMonth(monthAnchor.getMonth() + months);
  if (monthAnchor > now) months -= 1;

  const dayAnchor = new Date(hired);
  dayAnchor.setMonth(dayAnchor.getMonth() + months);
  const days = Math.max(0, Math.round((now.getTime() - dayAnchor.getTime()) / (1000 * 60 * 60 * 24)));

  return { months, days };
}

// What a PROBATIONARY-track employee graduates into once eligible — mirrors
// backend/src/modules/employees/employees.service.ts's REGULARIZATION_TARGET_STATUS.
// Only these two source statuses are gated by the probation period.
const REGULARIZATION_TARGET_STATUS: Partial<Record<Employee["employmentStatus"], Employee["employmentStatus"]>> = {
  PROBATIONARY: "REGULAR",
  PROBATIONARY_SEASONAL: "PERMANENT_SEASONAL",
};

// Single source of truth for "can this employee be promoted off probation
// yet" — used both for the disabled dropdown option in Edit Employee and for
// the "due for regularization review" banner, so the two never disagree.
function getRegularizationEligibility(employee: Employee) {
  const targetStatus = REGULARIZATION_TARGET_STATUS[employee.employmentStatus] ?? null;
  if (!targetStatus) return { targetStatus: null as Employee["employmentStatus"] | null, isEligible: true, eligibleDate: null as Date | null };

  const tenure = getTenure(employee.hireDate);
  const isEligible = Boolean(tenure && tenure.months >= PROBATION_MILESTONE_MONTHS);

  let eligibleDate: Date | null = null;
  if (employee.hireDate) {
    eligibleDate = new Date(employee.hireDate);
    eligibleDate.setMonth(eligibleDate.getMonth() + PROBATION_MILESTONE_MONTHS);
  }

  return { targetStatus, isEligible, eligibleDate };
}

function isDueForRegularizationReview(employee: Employee) {
  const { targetStatus, isEligible } = getRegularizationEligibility(employee);
  return Boolean(targetStatus) && isEligible;
}

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
  attendanceModeOptions,
  supervisors,
  lockedDepartmentName,
  onClose,
  onCreated,
}: {
  departments: DepartmentOption[];
  attendanceModeOptions: AttendanceModeOption[];
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

  
  const autoSupervisor = supervisors.find(
    (supervisor) => supervisor.department.name === form.department.trim(),
  );

  
  const departmentMode = departments.find((department) => department.name === form.department.trim())?.attendanceMode;
  const isModeLocked = !!departmentMode && departmentMode !== "BOTH";

  useEffect(() => {
    if (isModeLocked && departmentMode && form.attendanceMode !== departmentMode) {
      setForm((current) => ({ ...current, attendanceMode: departmentMode }));
    }
  }, [isModeLocked, departmentMode]);

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
      setError(extractErrorMessage(err, "Unable to add employee."));
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
              <FormSelectDropdown
                value={form.department}
                onChange={(value) => setForm((current) => ({ ...current, department: value }))}
                options={departments.map((department) => ({ value: department.name, label: department.name }))}
                placeholder="Select a department…"
                ariaLabel="Department"
              />
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
            <FormSelectDropdown
              value={form.employmentStatus}
              onChange={(value) => setForm((current) => ({ ...current, employmentStatus: value as EmployeeForm["employmentStatus"] }))}
              options={SELECTABLE_EMPLOYMENT_STATUSES.map((status) => ({ value: status, label: EMPLOYMENT_STATUS_LABELS[status] }))}
              placeholder="Select employment status…"
              ariaLabel="Employment Status"
            />
          </label>
          <label>
            Sex/Gender
            <FormSelectDropdown
              value={form.sex}
              onChange={(value) => setForm((current) => ({ ...current, sex: value as EmployeeForm["sex"] }))}
              options={[
                { value: "MALE", label: "Male" },
                { value: "FEMALE", label: "Female" },
              ]}
              placeholder="Select sex/gender…"
              ariaLabel="Sex/Gender"
            />
          </label>
        </div>

        <div className="employee-form-grid">
          <label>
            Hire Date
            <input type="date" value={form.hireDate} onChange={updateField("hireDate")} />
          </label>
          <label>
            Attendance Mode
            <FormSelectDropdown
              value={form.attendanceMode}
              onChange={(value) => setForm((current) => ({ ...current, attendanceMode: value }))}
              options={attendanceModeOptions.map((option) => ({ value: option.code, label: option.label }))}
              placeholder="Select attendance mode…"
              ariaLabel="Attendance Mode"
              disabled={isModeLocked || attendanceModeOptions.length === 0}
            />
            {!isModeLocked && attendanceModeOptions.length === 0 && (
              <span className="employee-form-hint">Unable to load attendance modes.</span>
            )}
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
  attendanceModeOptions,
  positions,
  supervisors,
  lockedDepartmentName,
  onClose,
  onUpdated,
  onSynced,
  onSaveFailed,
}: {
  employee: Employee;
  departments: DepartmentOption[];
  attendanceModeOptions: AttendanceModeOption[];
  positions: string[];
  supervisors: SupervisorOption[];
  lockedDepartmentName?: string;
  onClose: () => void;
  onUpdated: (employee: Employee) => void;
  onSynced: (employee: Employee) => void;
  onSaveFailed: (message: string) => void;
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
    civilStatus: employee.civilStatus ?? "SINGLE",
    spouseEmployerName: employee.spouseEmployerName ?? "",
    sex: employee.sex === "FEMALE" ? "FEMALE" : "MALE",
    supervisorId: employee.supervisor?.id ?? "",
  });
  const [error, setError] = useState("");
  const [spouseWorksElsewhere, setSpouseWorksElsewhere] = useState(Boolean(employee.spouseEmployerName));
  const [spouseUnemployed, setSpouseUnemployed] = useState(Boolean(employee.spouseUnemployed));

 
  const departmentMode = departments.find((department) => department.name === form.department.trim())?.attendanceMode;
  const isModeLocked = !!departmentMode && departmentMode !== "BOTH";

  useEffect(() => {
    if (isModeLocked && departmentMode && form.attendanceMode !== departmentMode) {
      setForm((current) => ({ ...current, attendanceMode: departmentMode }));
    }
  }, [isModeLocked, departmentMode]);
  const [leaveAllocation, setLeaveAllocation] = useState("");
  const [grantedTypeIds, setGrantedTypeIds] = useState<Set<string>>(new Set());
  const [initialGrantedTypeIds, setInitialGrantedTypeIds] = useState<Set<string>>(new Set());

  const availableSupervisors = supervisors.filter(
    (supervisor) => supervisor.id !== employee.id && supervisor.department.name === form.department.trim(),
  );

  const genderLeaveLabel =
    employee.sex === "MALE"
      ? "Paternity Leave Allocation (days)"
      : employee.sex === "FEMALE"
        ? "Maternity Leave Allocation (days)"
        : null;

  // The allocation field and the admin-grant checklist both read the same
  // two endpoints — routing them through the shared stale-while-revalidate
  // cache means any employee this modal (or LeavePage) has already fetched
  // renders instantly instead of showing "Loading..." again, and a cold open
  // only fires 2 requests total instead of 4.
  type LeaveTypeRow = {
    id: string;
    name: string;
    defaultDays: string;
    requiresAdminGrant: boolean;
    isActive: boolean;
    isTransferable: boolean;
    kind: "GENERAL" | "MATERNITY" | "PATERNITY";
    applicableStatuses: string[];
  };
  const leaveTypesCache = useCachedData<LeaveTypeRow[]>(CACHE_KEYS.leaveTypes, () =>
    apiRequest<LeaveTypeRow[]>("/leave-types"),
  );
  const balancesCache = useCachedData<{ leaveTypeId: string; earnedDays: number }[]>(
    CACHE_KEYS.leaveBalances(employee.id),
    () => apiRequest(`/leave-balances/${employee.id}`),
  );

  const isAllocationLoading = leaveTypesCache.isLoading || balancesCache.isLoading;
  const isGrantsLoading = leaveTypesCache.isLoading || balancesCache.isLoading;

  const genderLeaveType = useMemo(() => {
    if (!employee.sex || !leaveTypesCache.data) return null;
    const wantedKind = employee.sex === "MALE" ? "PATERNITY" : "MATERNITY";
    return leaveTypesCache.data.find((t) => t.kind === wantedKind && t.isActive) ?? null;
  }, [employee.sex, leaveTypesCache.data]);
  const genderLeaveTypeId = genderLeaveType?.id ?? null;

  // Spouse details exist to document Paternity/Maternity eligibility, so
  // they're only offered to employees actually entitled to that leave type
  // — driven by whatever employment statuses HR has configured under
  // Utilities → Leave Types (Maternity/Paternity Leave's Applicable
  // Statuses), not a hardcoded list. Reacts to the form's own
  // employmentStatus so switching it in this same modal updates immediately.
  const isEntitledToParentalLeave = Boolean(
    genderLeaveType?.applicableStatuses.includes(form.employmentStatus),
  );

  const adminGrantTypes = useMemo(() => {
    if (!leaveTypesCache.data) return [];
    return leaveTypesCache.data.filter((t) => {
      if (!t.requiresAdminGrant || !t.isActive) return false;
      if (t.isTransferable && employee.sex !== "MALE") return false;
      return true;
    });
  }, [leaveTypesCache.data, employee.sex]);

  // Seeds the editable local state exactly once, the first time both caches
  // have data — which, on a warm cache, is the very first render. A later
  // background revalidation must never clobber whatever the admin has
  // already checked or typed in this open modal.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    if (!leaveTypesCache.data || !balancesCache.data) return;
    seededRef.current = true;

    if (genderLeaveTypeId) {
      const match = balancesCache.data.find((b) => b.leaveTypeId === genderLeaveTypeId);
      setLeaveAllocation(match ? String(match.earnedDays) : "");
    }

    const granted = new Set(
      balancesCache.data
        .filter((b) => b.earnedDays > 0 && adminGrantTypes.some((t) => t.id === b.leaveTypeId))
        .map((b) => b.leaveTypeId),
    );
    setGrantedTypeIds(granted);
    setInitialGrantedTypeIds(granted);
  }, [leaveTypesCache.data, balancesCache.data, genderLeaveTypeId, adminGrantTypes]);

  const toggleGrantedType = (typeId: string) => {
    setGrantedTypeIds((current) => {
      const next = new Set(current);
      if (next.has(typeId)) next.delete(typeId);
      else next.add(typeId);
      return next;
    });
  };

  // Solo Parent Leave and Added Paternity Leave both presume a spouse
  // exists, so switching Civil Status to Single revokes either one if it
  // was already granted — not just greying out the checkbox, which would
  // otherwise leave a stale grant checked-but-disabled.
  useEffect(() => {
    if (form.civilStatus !== "SINGLE") return;
    const requiresSpouseIds = adminGrantTypes
      .filter((t) => t.name === "Solo Parent Leave" || t.isTransferable)
      .map((t) => t.id);
    if (requiresSpouseIds.some((id) => grantedTypeIds.has(id))) {
      setGrantedTypeIds((current) => {
        const next = new Set(current);
        requiresSpouseIds.forEach((id) => next.delete(id));
        return next;
      });
    }
    setForm((current) => (current.soloParentStatus === "NOT_APPLICABLE" ? current : { ...current, soloParentStatus: "NOT_APPLICABLE" }));
  }, [form.civilStatus, adminGrantTypes]);

  // Spouse checkbox state is only offered while the employee is entitled to
  // Paternity/Maternity leave (see isEntitledToParentalLeave) — clears it if
  // employmentStatus changes away from an eligible status, rather than
  // leaving stale spouse data behind an unmounted section. Gated on
  // leaveTypesCache.data so this doesn't fire (and wipe the seeded values)
  // during the brief window before that cache has loaded, when
  // isEntitledToParentalLeave is still provisionally false.
  useEffect(() => {
    if (!leaveTypesCache.data || isEntitledToParentalLeave) return;
    setSpouseWorksElsewhere(false);
    setSpouseUnemployed(false);
    setForm((current) => (current.spouseEmployerName ? { ...current, spouseEmployerName: "" } : current));
  }, [isEntitledToParentalLeave, leaveTypesCache.data]);

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

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validationError = validateForm();

    if (validationError) {
      setError(validationError);
      return;
    }

    setError("");

    // The admin gets an instant result: the list/modal update with the
    // values just typed right away, and the actual writes continue in the
    // background. onSynced reconciles with the server's response when it
    // lands (e.g. server-resolved attendance mode); onSaveFailed surfaces a
    // toast and reverts the optimistic change if the write actually failed.
    const optimisticSupervisor = form.supervisorId
      ? (() => {
          const match = supervisors.find((supervisor) => supervisor.id === form.supervisorId);
          return match ? { id: match.id, firstName: match.firstName, lastName: match.lastName } : employee.supervisor;
        })()
      : null;

    // Both spouse fields are only meaningful while Civil Status is Married —
    // clears them on submit if the admin switched away without unchecking
    // the boxes themselves.
    const isMarried = form.civilStatus === "MARRIED";
    const effectiveSpouseEmployerName = isMarried && spouseWorksElsewhere ? form.spouseEmployerName.trim() : "";
    const effectiveSpouseUnemployed = isMarried && spouseUnemployed;

    onUpdated({
      ...employee,
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      user: employee.user ? { ...employee.user, email: form.email.trim() } : employee.user,
      department: { name: form.department.trim(), attendanceMode: departmentMode ?? employee.department.attendanceMode },
      position: { title: form.position.trim() },
      employmentStatus: form.employmentStatus,
      attendanceMode: form.attendanceMode,
      soloParentStatus: form.soloParentStatus,
      civilStatus: form.civilStatus,
      spouseEmployerName: effectiveSpouseEmployerName,
      spouseUnemployed: effectiveSpouseUnemployed,
      supervisor: optimisticSupervisor ?? null,
      hireDate: form.hireDate || employee.hireDate,
    });

    const token = localStorage.getItem("accessToken");
    const patchPromise = axios.patch<Employee>(
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
        civilStatus: form.civilStatus,
        spouseEmployerName: effectiveSpouseEmployerName,
        spouseUnemployed: effectiveSpouseUnemployed,
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

    const changedTypeIds = adminGrantTypes
      .filter((t) => grantedTypeIds.has(t.id) !== initialGrantedTypeIds.has(t.id))
      .map((t) => t.id);

    // Independent writes (employee fields vs. leave-balance grants) fire
    // concurrently instead of one-after-another.
    const grantsPromise =
      changedTypeIds.length > 0
        ? Promise.all(
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
          )
        : Promise.resolve(null);

    Promise.all([patchPromise, grantsPromise])
      .then(([response]) => {
        onSynced(response.data);
        // The grant POST above writes straight to the server, bypassing the
        // shared leave-balances cache — without this, reopening Edit
        // Employee (or the employee's own Leave page) would keep reading the
        // pre-grant snapshot and show the checkbox unchecked even though
        // soloParentStatus already says Eligible.
        if (changedTypeIds.length > 0) {
          revalidateCached(CACHE_KEYS.leaveBalances(employee.id), () =>
            apiRequest(`/leave-balances/${employee.id}`),
          ).catch(() => undefined);
        }
      })
      .catch((err) => onSaveFailed(extractErrorMessage(err, "Unable to update employee.")));
  };

  const regularization = getRegularizationEligibility(employee);
  const restrictedStatus = regularization.targetStatus && !regularization.isEligible ? regularization.targetStatus : null;

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
            <FormSelectDropdown
              value={form.employmentStatus}
              onChange={(value) => setForm((current) => ({ ...current, employmentStatus: value as EmployeeForm["employmentStatus"] }))}
              options={SELECTABLE_EMPLOYMENT_STATUSES.map((status) => ({
                value: status,
                label: EMPLOYMENT_STATUS_LABELS[status],
                disabled: status === restrictedStatus,
              }))}
              placeholder="Select employment status…"
              ariaLabel="Employment Status"
            />
          </label>
        </div>

        <div className="employee-form-grid">
          <label>
            Department
            {lockedDepartmentName ? (
              <input type="text" value={lockedDepartmentName} disabled readOnly />
            ) : (
              <FormSelectDropdown
                value={form.department}
                onChange={(value) => setForm((current) => ({ ...current, department: value, supervisorId: "" }))}
                options={[
                  // Kept even if since archived so the currently-assigned department still displays correctly.
                  ...(!departments.some((department) => department.name === employee.department.name)
                    ? [{ value: employee.department.name, label: `${employee.department.name} (archived)` }]
                    : []),
                  ...departments.map((department) => ({ value: department.name, label: department.name })),
                ]}
                placeholder="Select a department…"
                ariaLabel="Department"
              />
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
            <FormSelectDropdown
              value={form.attendanceMode}
              onChange={(value) => setForm((current) => ({ ...current, attendanceMode: value }))}
              options={attendanceModeOptions.map((option) => ({ value: option.code, label: option.label }))}
              placeholder="Select attendance mode…"
              ariaLabel="Attendance Mode"
              disabled={isModeLocked || attendanceModeOptions.length === 0}
            />
            {!isModeLocked && attendanceModeOptions.length === 0 && (
              <span className="employee-form-hint">Unable to load attendance modes.</span>
            )}
          </label>
        </div>

        <div className="employee-form-grid">
          <label>
            Supervisor
            <FormSelectDropdown
              value={form.supervisorId}
              onChange={(value) => setForm((current) => ({ ...current, supervisorId: value }))}
              options={[
                { value: "", label: "No supervisor assigned" },
                ...availableSupervisors.map((supervisor) => ({
                  value: supervisor.id,
                  label: `${supervisor.firstName} ${supervisor.lastName}`,
                })),
              ]}
              placeholder="Select a supervisor…"
              ariaLabel="Supervisor"
            />
          </label>
          {genderLeaveLabel && (isAllocationLoading || genderLeaveTypeId) && (
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
          )}
        </div>

        <div className="employee-form-grid">
          <label>
            Civil Status
            <FormSelectDropdown
              value={form.civilStatus}
              onChange={(value) => setForm((current) => ({ ...current, civilStatus: value as EmployeeForm["civilStatus"] }))}
              options={[
                { value: "SINGLE", label: "Single" },
                { value: "MARRIED", label: "Married" },
                { value: "WIDOWED", label: "Widowed" },
                { value: "SEPARATED", label: "Separated" },
                { value: "ANNULLED", label: "Annulled" },
              ]}
              placeholder="Select civil status…"
              ariaLabel="Civil Status"
            />
          </label>
          <label>
            Sex/Gender
            <input type="text" value={employee.sex === "FEMALE" ? "Female" : employee.sex === "MALE" ? "Male" : "Not set"} disabled readOnly />
          </label>
        </div>

        {form.civilStatus === "MARRIED" && isEntitledToParentalLeave && (
          <>
            <div className="employee-form-grid">
              <div
                className="employee-spouse-checkbox-row"
                onClick={() => {
                  const checked = !spouseWorksElsewhere;
                  setSpouseWorksElsewhere(checked);
                  if (checked) setSpouseUnemployed(false);
                  else setForm((current) => ({ ...current, spouseEmployerName: "" }));
                }}
              >
                <input type="checkbox" checked={spouseWorksElsewhere} readOnly />
                <span>Employee's spouse works at another company</span>
              </div>
              <div
                className="employee-spouse-checkbox-row"
                onClick={() => {
                  const checked = !spouseUnemployed;
                  setSpouseUnemployed(checked);
                  if (checked) {
                    setSpouseWorksElsewhere(false);
                    setForm((current) => ({ ...current, spouseEmployerName: "" }));
                  }
                }}
              >
                <input type="checkbox" checked={spouseUnemployed} readOnly />
                <span>Spouse is unemployed</span>
              </div>
            </div>
            <div className="employee-form-grid">
              <label>
                Spouse's Company
                <input
                  type="text"
                  value={form.spouseEmployerName}
                  onChange={updateField("spouseEmployerName")}
                  placeholder="Company name"
                  disabled={!spouseWorksElsewhere}
                />
              </label>
            </div>
          </>
        )}

        {/* Only a Regular employee is eligible for these admin-granted leave
            types — reacts to the form's own employmentStatus so toggling the
            dropdown in this same modal shows/hides it immediately, without
            requiring a save. Doesn't touch grant/allocation logic itself. */}
        {form.employmentStatus === "REGULAR" && adminGrantTypes.length > 0 && (
          <div className="employee-leave-grants">
            <p className="employee-leave-grants-title">
              Additional Leave Types{isGrantsLoading ? " (loading…)" : ""}
            </p>
            <p className="employee-leave-grants-hint">
              These leave types are only available to an employee once granted here. Checking one grants its default
              day allotment; unchecking revokes it.
            </p>
            {adminGrantTypes.map((type) => {
              const isSoloParentLeave = type.name === "Solo Parent Leave";
              // isTransferable identifies "Added Paternity Leave" — days
              // transferred from the spouse's unused maternity leave (RA
              // 11210) — which, like Solo Parent Leave, presumes a spouse
              // exists and so makes no sense while Civil Status is Single.
              const isAddedPaternityLeave = type.isTransferable;
              const requiresSpouse = isSoloParentLeave || isAddedPaternityLeave;
              const isCivilStatusSingle = form.civilStatus === "SINGLE";
              const isIneligible =
                (isSoloParentLeave && form.soloParentStatus === "INELIGIBLE") ||
                (requiresSpouse && isCivilStatusSingle);
              return (
                <div key={type.id} className="employee-leave-grant-line">
                  <label className="employee-leave-grant-row">
                    <input
                      type="checkbox"
                      checked={grantedTypeIds.has(type.id)}
                      disabled={isGrantsLoading || isIneligible}
                      onChange={() => {
                        const wasGranted = grantedTypeIds.has(type.id);
                        toggleGrantedType(type.id);
                        if (isSoloParentLeave) {
                          setForm((current) => ({
                            ...current,
                            soloParentStatus: wasGranted ? "NOT_APPLICABLE" : "ELIGIBLE",
                          }));
                        }
                      }}
                    />
                    <span>
                      {type.name} <span className="grant-days">({type.defaultDays} day{Number(type.defaultDays) === 1 ? "" : "s"})</span>
                    </span>
                  </label>
                  {isSoloParentLeave && !isCivilStatusSingle && (
                    <label className="employee-inline-checkbox employee-solo-parent-ineligible">
                      <input
                        type="checkbox"
                        checked={isIneligible}
                        disabled={isGrantsLoading}
                        onChange={(event) => {
                          const checked = event.target.checked;
                          setForm((current) => ({
                            ...current,
                            soloParentStatus: checked ? "INELIGIBLE" : "NOT_APPLICABLE",
                          }));
                          if (checked && grantedTypeIds.has(type.id)) {
                            toggleGrantedType(type.id);
                          }
                        }}
                      />
                      <span>Ineligible</span>
                    </label>
                  )}
                  {isSoloParentLeave && !isCivilStatusSingle && (
                    <span className={`employee-solo-parent-status employee-solo-parent-status--${form.soloParentStatus.toLowerCase()}`}>
                      {form.soloParentStatus === "ELIGIBLE"
                        ? "Eligible"
                        : form.soloParentStatus === "INELIGIBLE"
                          ? "Ineligible"
                          : "Not Applicable"}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {error && <p className="employee-form-error">{error}</p>}

        <div className="employee-form-actions">
          <button type="submit" className="primary-button">
            Save Changes
          </button>
          <button type="button" className="outline-button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </EmployeeModal>
  );
}

function ViewEmployeeModal({
  employee,
  attendanceModeOptions,
  onClose,
  onEdit,
  onArchive,
  onRestore,
  canWrite,
  canRegisterFace,
  onRegisterFace,
  canViewPerformance,
  onViewPerformance,
}: {
  employee: Employee;
  attendanceModeOptions: AttendanceModeOption[];
  onClose: () => void;
  onEdit: () => void;
  onArchive: () => void;
  onRestore: () => void;
  canWrite: boolean;
  canRegisterFace: boolean;
  onRegisterFace?: () => void;
  canViewPerformance: boolean;
  onViewPerformance: () => void;
}) {
  // Same condition the "Register Face" button below is hidden for — without
  // this banner, the button just silently isn't there with no indication of
  // why (see FaceRegistrationPage's own "Employee Consent Required" modal,
  // which explains the same wait to an admin already on that page).
  const consentPending = Boolean(
    employee.requiresFaceConsent && !employee.faceConsentAcceptedAt && employee.employmentStatus !== "SEPARATED",
  );

  return (
    <EmployeeModal title="Employee Details" description={getEmployeeName(employee)} onClose={onClose}>
      {consentPending && (
        <div className="employee-consent-banner" role="alert">
          <AlertTriangle size={22} className="employee-consent-banner-icon" />
          <div>
            <strong>Face consent pending</strong>
            <p>
              This employee hasn't accepted the face-data consent on the mobile app yet. Face registration is
              unavailable until they log in and accept it.
            </p>
          </div>
        </div>
      )}

      {isDueForRegularizationReview(employee) && (
        <div className="employee-regularization-banner" role="alert">
          <UserCheck size={22} className="employee-regularization-banner-icon" />
          <div>
            <strong>Regularization review recommended</strong>
            <p>
              This employee has completed six (6) months of probationary employment and is eligible for
              regularization review. Please review their performance and qualifications before converting their
              status to Regular.
            </p>
            {canViewPerformance && (
              <button type="button" className="outline-button" style={{ marginTop: 10 }} onClick={onViewPerformance}>
                View Performance
              </button>
            )}
          </div>
        </div>
      )}

      <div className="employee-detail-grid">
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
        {employee.hireDate && (
          <div>
            <span>Hire Date</span>
            <strong>
              {new Date(employee.hireDate).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
              {(() => {
                const tenure = getTenure(employee.hireDate);
                if (!tenure) return null;
                return ` · ${tenure.months} month${tenure.months === 1 ? "" : "s"}, ${tenure.days} day${tenure.days === 1 ? "" : "s"}`;
              })()}
            </strong>
          </div>
        )}
        <div>
          <span>Attendance Mode</span>
          <Badge tone={getAttendanceModeTone(employee.attendanceMode)}>
            {getAttendanceModeLabel(employee.attendanceMode, attendanceModeOptions)}
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
        {employee.civilStatus && employee.civilStatus !== "SINGLE" && (
          <div>
            <span>Civil Status</span>
            <strong>{employee.civilStatus.charAt(0) + employee.civilStatus.slice(1).toLowerCase()}</strong>
          </div>
        )}
        {employee.spouseEmployerName && (
          <div>
            <span>Spouse's Company</span>
            <strong>{employee.spouseEmployerName}</strong>
          </div>
        )}
        {employee.spouseUnemployed && (
          <div>
            <span>Spouse's Employment</span>
            <strong>Unemployed</strong>
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
        {canWrite && employee.employmentStatus === "SEPARATED" && (
          <button type="button" className="primary-button" onClick={onRestore}>
            <RotateCcw size={14} />
            Restore Employee
          </button>
        )}
        {canRegisterFace && onRegisterFace && (
          <button type="button" className="primary-button" onClick={onRegisterFace}>
            <ScanFace size={14} />
            Register Face
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
            <FormSelectDropdown
              value={archiveType}
              onChange={setArchiveType}
              options={[
                { value: "Resigned", label: "Resigned" },
                { value: "Retired", label: "Retired" },
                { value: "End of Contract", label: "End of Contract" },
                { value: "Separated", label: "Separated" },
              ]}
              placeholder="Select archive type…"
              ariaLabel="Archive Type"
            />
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
  onRegisterFace,
  initialFocusEmployeeId,
  onFocusHandled,
}: {
  user?: { permissions: PermissionCode[]; roles?: string[]; departmentId?: string; department?: string };
  
  onEmployeeCreated?: (employee: Employee) => void;
  onRegisterFace?: (employee: Employee) => void;
  
  initialFocusEmployeeId?: string;
  onFocusHandled?: () => void;
}) {
  const canWrite = user?.permissions.includes(permissions.employeesWrite) ?? true;
  const roles = user?.roles ?? [];
  const isDepartmentLocked = roles.includes("SUPERVISOR") && !roles.includes("ADMIN");
  // Gates the "View Performance" button — the admin-view evaluation endpoint
  // is Admin-only server-side, so a Supervisor never even sees the button
  // (they already have their own submitted-evaluation view via the
  // notification's "Evaluate Employee" action).
  const isAdmin = roles.includes("ADMIN");
  const lockedDepartmentName = isDepartmentLocked ? user?.department : undefined;

  const [departmentFilter, setDepartmentFilter] = useState("ALL");
  const [modeFilter, setModeFilter] = useState<"ALL" | "FIELD" | "NON_FIELD" | "BOTH">("ALL");
  const [nameSort, setNameSort] = useState<"asc" | "desc" | null>(null);
  const [showArchivedOnly, setShowArchivedOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [viewEmployee, setViewEmployee] = useState<Employee | null>(null);
  const [viewingPerformanceEmployee, setViewingPerformanceEmployee] = useState<Employee | null>(null);
  const [editEmployee, setEditEmployee] = useState<Employee | null>(null);
  const [archiveEmployee, setArchiveEmployee] = useState<Employee | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<Employee | null>(null);
  const [notification, setNotification] = useState<Notification>(null);


  const employeesCache = useCachedData<Employee[]>("employees", () => apiRequest<Employee[]>("/employees"));
  const employees = employeesCache.data ?? [];

  const supervisorsCache = useCachedData<SupervisorOption[]>("supervisors", () =>
    apiRequest<SupervisorOption[]>("/employees/supervisors"),
  );
  const supervisors = supervisorsCache.data ?? [];

  
  const faceProfilesCache = useCachedData<{ employeeId: string }[]>(
    onRegisterFace ? "face-profiles" : null,
    () => apiRequest<{ employeeId: string }[]>("/face-profiles"),
  );
  const registeredFaceEmployeeIds = new Set((faceProfilesCache.data ?? []).map((p) => p.employeeId));

  const { departments: activeDepartments, departmentNames: departments } = useActiveDepartments();
  const { forEmployees: attendanceModeOptions, all: allAttendanceModeOptions } = useAttendanceModeOptions();

  useEffect(() => {
    if (!notification) return;
    const timeoutId = window.setTimeout(() => setNotification(null), 3500);
    return () => window.clearTimeout(timeoutId);
  }, [notification]);

  useEffect(() => {
    if (!initialFocusEmployeeId) return;
    const match = employees.find((employee) => employee.id === initialFocusEmployeeId);
    if (match) {
      setViewEmployee(match);
      onFocusHandled?.();
    }
  }, [initialFocusEmployeeId, employees, onFocusHandled]);

  const positions = Array.from(new Set(employees.map((employee) => employee.position.title))).sort();
  const activeEmployeeCount = employees.filter((employee) => employee.employmentStatus !== "SEPARATED").length;

  const visibleEmployees = employees.filter((employee) => {
    if (departmentFilter !== "ALL" && employee.department.name !== departmentFilter) return false;
    if (modeFilter === "FIELD" && (employee.department.attendanceMode === "BOTH" || employee.attendanceMode !== "FIELD")) return false;
    if (modeFilter === "NON_FIELD" && (employee.department.attendanceMode === "BOTH" || employee.attendanceMode === "FIELD")) return false;
    if (modeFilter === "BOTH" && employee.department.attendanceMode !== "BOTH") return false;
    if (showArchivedOnly) {
      if (employee.employmentStatus !== "SEPARATED") return false;
    } else {
      if (employee.employmentStatus === "SEPARATED") return false;
    }
    if (!matchesSearch(employee, searchQuery)) return false;
    return true;
  });

  const sortedVisibleEmployees = nameSort
    ? [...visibleEmployees].sort((a, b) => {
        const dir = nameSort === "asc" ? 1 : -1;
        return getEmployeeName(a).localeCompare(getEmployeeName(b)) * dir;
      })
    : visibleEmployees;

  const toggleNameSort = () => {
    setNameSort((current) => (current === "asc" ? "desc" : current === "desc" ? null : "asc"));
  };

  useEffect(() => setPage(1), [departmentFilter, modeFilter, showArchivedOnly, searchQuery, nameSort]);
  const pageCount = Math.max(1, Math.ceil(sortedVisibleEmployees.length / EMPLOYEES_PAGE_SIZE));
  const pageSafe = Math.min(page, pageCount);
  const pagedEmployees = sortedVisibleEmployees.slice(
    (pageSafe - 1) * EMPLOYEES_PAGE_SIZE,
    pageSafe * EMPLOYEES_PAGE_SIZE,
  );

  const handleEmployeeCreated = (employee: Employee) => {
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

  // Quietly reconciles the optimistic edit with the server's response once
  // the background save actually lands — no re-closing the modal (already
  // closed) and no second toast.
  const handleEmployeeSynced = (employee: Employee) => {
    employeesCache.setData(employees.map((item) => (item.id === employee.id ? employee : item)));
    setViewEmployee((current) => (current?.id === employee.id ? employee : current));
  };

  const handleEmployeeSaveFailed = (message: string) => {
    setNotification({ type: "error", message });
    employeesCache.refresh().catch(() => undefined);
  };

  const handleEmployeeArchived = (employee: Employee) => {
    employeesCache.setData(employees.map((item) => (item.id === employee.id ? employee : item)));
    setViewEmployee((current) => (current?.id === employee.id ? employee : current));
    setArchiveEmployee(null);
    setNotification({ type: "success", message: "Employee was archived and their login was deactivated." });
  };

  const handleRestoreEmployee = async (employee: Employee) => {
    try {
      const restored = await apiRequest<Employee>(`/employees/${employee.id}/restore`, { method: "PATCH" });
      employeesCache.setData(employees.map((item) => (item.id === restored.id ? restored : item)));
      setViewEmployee((current) => (current?.id === restored.id ? restored : current));
      setNotification({ type: "success", message: "Employee was restored and their login was reactivated." });
    } catch (err) {
      setNotification({
        type: "error",
        message: err instanceof Error ? err.message : "Unable to restore employee.",
      });
    }
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

        {/* MODE — Field / Non-field, matching the wording used in the MODE column */}
        <div className="employees-filter-group">
          <label className="employees-filter-label">Mode</label>
          <DropdownFilter
            className="department-select"
            value={modeFilter}
            onChange={(value) => setModeFilter(value as "ALL" | "FIELD" | "NON_FIELD" | "BOTH")}
            options={[
              { value: "NON_FIELD", label: "Non-field" },
              { value: "FIELD", label: "Field" },
              { value: "BOTH", label: "Both" },
            ]}
            allLabel="Non-field & Field"
            menuLabel="Filter by attendance mode"
            ariaLabel="Filter employees by attendance mode"
          />
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
        <div className="employees-table-scroll">
        <table>
          <thead>
            <tr>
              <th>
                <button type="button" className="employees-sort-th" onClick={toggleNameSort}>
                  NAME
                  {nameSort === "asc" ? "▲" : nameSort === "desc" ? "▼" : <ChevronsUpDown size={12} />}
                </button>
              </th>
              <th>EMAIL</th>
              <th>DEPARTMENT</th>
              <th>POSITION</th>
              <th>EMPLOYEE TYPE</th>
              <th>MODE</th>
              <th>ACTION</th>
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
              pagedEmployees.map((employee) => (
                <tr key={employee.id}>
                  <td data-label="Name">{getEmployeeName(employee)}</td>
                  <td data-label="Email">{employee.user?.email ?? "Unassigned"}</td>
                  <td data-label="Department">{employee.department.name}</td>
                  <td data-label="Position">{employee.position.title}</td>
                  <td data-label="Employee Type" className="employee-type-cell">
                    {getStatusLabel(employee)}
                  </td>
                  <td data-label="Mode" className="employee-status-cell">
                    <Badge tone="neutral">
                      {employee.department.attendanceMode === "BOTH"
                        ? getAttendanceModeLabel("BOTH", allAttendanceModeOptions)
                        : getAttendanceModeLabel(employee.attendanceMode, attendanceModeOptions)}
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
        </div>
        {pageCount > 1 && (
          <div className="employees-pagination">
            <button type="button" className="outline-button" disabled={pageSafe <= 1} onClick={() => setPage(pageSafe - 1)}>
              Previous
            </button>
            <span>Page {pageSafe} of {pageCount}</span>
            <button type="button" className="outline-button" disabled={pageSafe >= pageCount} onClick={() => setPage(pageSafe + 1)}>
              Next
            </button>
          </div>
        )}
      </section>

      {viewEmployee && (
        <ViewEmployeeModal
          employee={viewEmployee}
          attendanceModeOptions={attendanceModeOptions}
          onClose={() => setViewEmployee(null)}
          onEdit={() => openEditEmployee(viewEmployee)}
          onArchive={() => {
            setArchiveEmployee(viewEmployee);
            setViewEmployee(null);
          }}
          onRestore={() => {
            setRestoreTarget(viewEmployee);
            setViewEmployee(null);
          }}
          canWrite={canWrite}
          canRegisterFace={Boolean(
            onRegisterFace &&
              !(viewEmployee.requiresFaceConsent && !viewEmployee.faceConsentAcceptedAt) &&
              !registeredFaceEmployeeIds.has(viewEmployee.id) &&
              viewEmployee.employmentStatus !== "SEPARATED",
          )}
          onRegisterFace={onRegisterFace ? () => onRegisterFace(viewEmployee) : undefined}
          canViewPerformance={isAdmin}
          onViewPerformance={() => setViewingPerformanceEmployee(viewEmployee)}
        />
      )}

      {viewingPerformanceEmployee && (
        <EvaluationViewModal
          employeeId={viewingPerformanceEmployee.id}
          employeeName={getEmployeeName(viewingPerformanceEmployee)}
          onClose={() => setViewingPerformanceEmployee(null)}
          onApproved={handleEmployeeUpdated}
        />
      )}

      {editEmployee && (
        <EditEmployeeModal
          employee={editEmployee}
          departments={activeDepartments}
          attendanceModeOptions={attendanceModeOptions}
          positions={positions}
          supervisors={supervisors}
          lockedDepartmentName={lockedDepartmentName}
          onClose={() => setEditEmployee(null)}
          onUpdated={(updatedEmployee) => {
            handleEmployeeUpdated(updatedEmployee);
            supervisorsCache.refresh().catch(() => undefined);
          }}
          onSynced={handleEmployeeSynced}
          onSaveFailed={handleEmployeeSaveFailed}
        />
      )}

      {isAddOpen && (
        <AddEmployeeModal
          departments={activeDepartments}
          attendanceModeOptions={attendanceModeOptions}
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

      {restoreTarget && (
        <ConfirmDialog
          config={{
            title: "Restore Employee",
            description: `${getEmployeeName(restoreTarget)} will be reactivated and can log in again. They'll reappear in the active employee list.`,
            confirmLabel: "Restore Employee",
            tone: "primary",
            onConfirm: () => handleRestoreEmployee(restoreTarget),
          }}
          onCancel={() => setRestoreTarget(null)}
        />
      )}
    </>
  );
}