import axios from "axios";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  Archive,
  Briefcase,
  CalendarDays,
  ChevronsUpDown,
  Download,
  Eye,
  FileUp,
  Info,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  ScanFace,
  Search,
  UserCheck,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { DropdownFilter } from "../../components/ui/DropdownFilter";
import { FormSelectDropdown } from "../../components/ui/FormSelectDropdown";
import { NotificationModal, type NotificationConfig } from "../../components/ui/NotificationModal";
import { apiRequest, SessionExpiredError } from "../../lib/api";
import { CACHE_KEYS, cacheGet, revalidateCached, useCachedData } from "../../lib/dataCache";
import { useActiveDepartments } from "../../lib/departments";
import {
  type AttendanceModeOption,
  formatAttendanceMode as getAttendanceModeLabel,
  useAttendanceModeOptions,
} from "../../lib/attendanceModes";
import { PermissionCode, permissions } from "../../types/rbac";
import { useEmployeeTypes } from "../../lib/employeeTypes";
import { useAvailablePositions, usePositions } from "../../lib/positions";
import type { EmploymentStatus } from "../../types/employment";
import { downloadImportTemplate, type ImportReference } from "./employeeImport";
import { ImportEmployeesModal } from "./ImportEmployeesModal";
import "./EmployeesPage.css";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001/api/v1";

const EMPLOYEES_PAGE_SIZE = 10;

// Upper bound on the Add Employee request. The backend answers within ~15s
// even when Gmail is unreachable, so this only trips if the server itself
// stops responding — the spinner can never run forever.
const CREATE_EMPLOYEE_TIMEOUT_MS = 45_000;


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
  // null (not "") when the employee has none.
  middleName?: string | null;
  lastName: string;
  // Existing Employment Status, set server-side from employeeType.
  employmentStatus: EmploymentStatus;
  employeeTypeId: string;
  employeeType?: { id: string; name: string; employmentStatus: EmploymentStatus; isActive: boolean } | null;
  soloParentStatus: "NOT_APPLICABLE" | "ELIGIBLE" | "INELIGIBLE";
  civilStatus?: "SINGLE" | "MARRIED" | "WIDOWED" | "SEPARATED" | "ANNULLED";
  spouseEmployerName?: string | null;
  spouseUnemployed?: boolean;
  spouseEmployeeId?: string | null;
  spouseEmployee?: SpouseEmployeeRef | null;
  sex?: "MALE" | "FEMALE" | null;
  attendanceMode: AttendanceMode;
  hireDate?: string;
  archiveType?: string;
  archiveReason?: string;
  archiveDate?: string;
  user?: { email: string } | null;
  department: { name: string; attendanceMode: string };
  positionId: string;
  position: { title: string };
  supervisor?: { id: string; firstName: string; lastName: string } | null;
  faceConsentAcceptedAt?: string | null;
  requiresFaceConsent?: boolean;
};


type AttendanceMode = string;
type DepartmentAttendanceMode = string;

type DepartmentOption = { id: string; name: string; attendanceMode: DepartmentAttendanceMode };

type SupervisorOption = {
  id: string;
  firstName: string;
  lastName: string;
  employeeNo?: string;
  department: { name: string };
};

type SpouseEmployeeRef = { id: string; firstName: string; lastName: string; employeeNo: string };

type SpouseCandidate = SpouseEmployeeRef & { department: { name: string } };

// The spouse checkboxes on Add/Edit Employee are mutually exclusive, so
// they're modelled as one value. ULPI = the spouse is also an employee here.
type SpouseEmployment = "NONE" | "OTHER_COMPANY" | "ULPI" | "UNEMPLOYED";

type EmployeeForm = {
  firstName: string;
  // Optional — "" in the form, sent as null.
  middleName: string;
  lastName: string;
  email: string;
  department: string;
  // Edit Employee's Position dropdown (Add Employee keeps its own state).
  positionId: string;
  hireDate: string;
  // Id of a row from Utilities → Employee Types.
  employeeTypeId: string;
  attendanceMode: AttendanceMode;
  soloParentStatus: "NOT_APPLICABLE" | "ELIGIBLE" | "INELIGIBLE";
  // "" only on a fresh Add Employee form, until one is picked.
  civilStatus: "SINGLE" | "MARRIED" | "WIDOWED" | "SEPARATED" | "ANNULLED" | "";
  spouseEmployment: SpouseEmployment;
  spouseEmployerName: string;
  // "" = none picked yet; only meaningful while spouseEmployment is ULPI.
  spouseEmployeeId: string;
  sex: "MALE" | "FEMALE" | "";
  // "" = no supervisor assigned.
  supervisorId: string;
};

type EditEmployeeForm = EmployeeForm;

const initialForm: EmployeeForm = {
  firstName: "",
  middleName: "",
  lastName: "",
  email: "",
  department: "",
  positionId: "",
  hireDate: "",
  employeeTypeId: "",
  attendanceMode: "FIXED",
  soloParentStatus: "NOT_APPLICABLE",
  civilStatus: "",
  spouseEmployment: "NONE",
  spouseEmployerName: "",
  spouseEmployeeId: "",
  sex: "",
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
  return employee.employeeType?.name ?? "Unspecified";
}

// The middle name sits between first and last only when there is one, so
// a blank one never leaves a double space (or "null") in the name.
function getEmployeeName(employee: Employee) {
  return [employee.firstName, employee.middleName, employee.lastName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");
}

function matchesSearch(employee: Employee, query: string) {
  if (!query.trim()) return true;

  const needle = query.trim().toLowerCase();
  const haystacks = [
    employee.employeeNo,
    employee.firstName,
    employee.middleName ?? "",
    employee.lastName,
    // "Juan Dela Cruz" still finds Juan Santos Dela Cruz.
    `${employee.firstName} ${employee.lastName}`,
    getEmployeeName(employee),
    employee.user?.email ?? "",
    employee.department.name,
    employee.position.title,
    employee.employeeType?.name ?? "",
  ];

  return haystacks.some((value) => value.toLowerCase().includes(needle));
}

function EmployeeModal({
  title,
  description,
  children,
  onClose,
  small,
  split,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  small?: boolean;
  // Add/Edit Employee: details on the left, Additional Leave Types on the right.
  split?: boolean;
}) {
  return (
    <div className="employee-modal-backdrop" role="presentation">
      <section
        className={`employee-modal${small ? " employee-modal--archive" : ""}${split ? " employee-modal--split" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="employee-modal-title"
      >
        <div className="employee-modal-header">
          <div>
            {title && <h2 id="employee-modal-title">{title}</h2>}
            {description && <p>{description}</p>}
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

const CIVIL_STATUS_OPTIONS = [
  { value: "SINGLE", label: "Single" },
  { value: "MARRIED", label: "Married" },
  { value: "WIDOWED", label: "Widowed" },
  { value: "SEPARATED", label: "Separated" },
  { value: "ANNULLED", label: "Annulled" },
];

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

// Routed through the shared stale-while-revalidate cache, so any modal (or
// LeavePage) that already fetched it renders instantly.
function useLeaveTypes() {
  return useCachedData<LeaveTypeRow[]>(CACHE_KEYS.leaveTypes, () => apiRequest<LeaveTypeRow[]>("/leave-types"));
}

function findGenderLeaveType(leaveTypes: LeaveTypeRow[] | null | undefined, sex: Employee["sex"]) {
  if (!sex || !leaveTypes) return null;
  const wantedKind = sex === "MALE" ? "PATERNITY" : "MATERNITY";
  return leaveTypes.find((t) => t.kind === wantedKind && t.isActive) ?? null;
}

function getGenderLeaveLabel(sex: Employee["sex"]) {
  if (sex === "MALE") return "Paternity Leave Allocation (days)";
  if (sex === "FEMALE") return "Maternity Leave Allocation (days)";
  return null;
}

// isTransferable identifies "Added Paternity Leave" (days transferred from
// the spouse's unused maternity leave, RA 11210), so it's men-only. Maternity
// and Paternity Leave join this checklist once set to "Admin-grant only" in
// Utilities > Leave Types: offered for the matching sex, never pre-ticked.
function getAdminGrantTypes(leaveTypes: LeaveTypeRow[] | null | undefined, sex: Employee["sex"]) {
  if (!leaveTypes) return [];
  return leaveTypes.filter((t) => {
    if (!t.requiresAdminGrant || !t.isActive) return false;
    if (t.isTransferable && sex !== "MALE") return false;
    if (t.kind === "MATERNITY" && sex !== "FEMALE") return false;
    if (t.kind === "PATERNITY" && sex !== "MALE") return false;
    return true;
  });
}

const isGenderLeaveType = (type: LeaveTypeRow) => type.kind === "MATERNITY" || type.kind === "PATERNITY";

// Maternity/Paternity Leave can be granted to Regular and Permanent Seasonal
// employees (the same statuses the backend entitles to them); every other
// admin-granted type stays Regular-only.
const GENDER_LEAVE_GRANT_STATUSES = new Set(["REGULAR", "PERMANENT_SEASONAL"]);

function canGrantLeaveType(type: LeaveTypeRow, employmentStatus: string | undefined) {
  if (!employmentStatus) return false;
  return isGenderLeaveType(type) ? GENDER_LEAVE_GRANT_STATUSES.has(employmentStatus) : employmentStatus === "REGULAR";
}

// Added Paternity Leave is seeded with 0 default days; a grant gives the
// statutory 7 (RA 11210) instead — taken from the wife's Maternity Leave.
const ADDED_PATERNITY_LEAVE_DAYS = 7;

// Days a grant from the "Additional Leave Types" checklist gives (and shows).
function getGrantDays(type: LeaveTypeRow) {
  const days = Number(type.defaultDays);
  return type.isTransferable && days === 0 ? ADDED_PATERNITY_LEAVE_DAYS : days;
}

const isSoloParentLeaveType = (type: LeaveTypeRow) => type.name === "Solo Parent Leave";

// Solo Parent Leave and Added Paternity Leave both presume a spouse exists,
// so neither makes sense while Civil Status is Single.
const requiresSpouse = (type: LeaveTypeRow) => isSoloParentLeaveType(type) || type.isTransferable;

function getInitialSpouseEmployment(employee: Employee): SpouseEmployment {
  if (employee.spouseEmployeeId) return "ULPI";
  if (employee.spouseEmployerName) return "OTHER_COMPANY";
  if (employee.spouseUnemployed) return "UNEMPLOYED";
  return "NONE";
}

// The spouse fields as sent to the API. All of them are only meaningful while
// Civil Status is Married — cleared on submit if the admin switched away
// without unchecking the boxes themselves.
function getSpousePayload(form: EmployeeForm) {
  const mode = form.civilStatus === "MARRIED" ? form.spouseEmployment : "NONE";
  return {
    spouseEmployerName: mode === "OTHER_COMPANY" ? form.spouseEmployerName.trim() : "",
    spouseUnemployed: mode === "UNEMPLOYED",
    spouseEmployeeId: mode === "ULPI" ? form.spouseEmployeeId : "",
  };
}

function validateSpouse(form: EmployeeForm) {
  if (form.civilStatus === "MARRIED" && form.spouseEmployment === "ULPI" && !form.spouseEmployeeId) {
    return "Select the spouse from the ULPI employee list.";
  }
  // Without this, "Works at another company" with a blank name saved
  // nothing and quietly came back as "Not provided".
  if (form.civilStatus === "MARRIED" && form.spouseEmployment === "OTHER_COMPANY" && !form.spouseEmployerName.trim()) {
    return "Enter the spouse's company.";
  }
  return "";
}

// Keeps the spouse details and admin leave grants consistent while the form
// changes, for both Add and Edit Employee:
// - Civil Status → Single revokes any grant that presumes a spouse (not just
//   greying out its checkbox, which would leave a stale grant checked-but-disabled).
// - Civil Status → anything but Married clears the spouse details, rather
//   than leaving stale checked-but-disabled boxes in the spouse section.
function useSpouseDependentResets({
  civilStatus,
  spouseEmployment,
  adminGrantTypes,
  setGrantedTypeIds,
  setForm,
}: {
  civilStatus: EmployeeForm["civilStatus"];
  spouseEmployment: SpouseEmployment;
  adminGrantTypes: LeaveTypeRow[];
  setGrantedTypeIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setForm: React.Dispatch<React.SetStateAction<EmployeeForm>>;
}) {
  useEffect(() => {
    if (civilStatus !== "SINGLE") return;
    const requiresSpouseIds = adminGrantTypes.filter(requiresSpouse).map((t) => t.id);
    setGrantedTypeIds((current) =>
      requiresSpouseIds.some((id) => current.has(id))
        ? new Set([...current].filter((id) => !requiresSpouseIds.includes(id)))
        : current,
    );
    setForm((current) => (current.soloParentStatus === "NOT_APPLICABLE" ? current : { ...current, soloParentStatus: "NOT_APPLICABLE" }));
  }, [civilStatus, adminGrantTypes]);

  useEffect(() => {
    if (civilStatus === "MARRIED") return;
    setForm((current) =>
      current.spouseEmployment === "NONE" && !current.spouseEmployerName && !current.spouseEmployeeId
        ? current
        : { ...current, spouseEmployment: "NONE", spouseEmployerName: "", spouseEmployeeId: "" },
    );
  }, [civilStatus]);

  // Added Paternity Leave (isTransferable) is days transferred from a spouse
  // who also works at ULPI — unchecking "works at ULPI" revokes it. Only on an
  // actual change, never on open: an older grant on file without a ULPI
  // spouse recorded must not be silently revoked by an unrelated save.
  const previousSpouseEmployment = useRef(spouseEmployment);
  useEffect(() => {
    const wasUlpi = previousSpouseEmployment.current === "ULPI";
    previousSpouseEmployment.current = spouseEmployment;
    if (!wasUlpi || spouseEmployment === "ULPI") return;
    const transferableIds = adminGrantTypes.filter((t) => t.isTransferable).map((t) => t.id);
    setGrantedTypeIds((current) =>
      transferableIds.some((id) => current.has(id))
        ? new Set([...current].filter((id) => !transferableIds.includes(id)))
        : current,
    );
  }, [spouseEmployment]);
}

const SPOUSE_EMPLOYMENT_OPTIONS = [
  { value: "NONE", label: "Not provided" },
  { value: "OTHER_COMPANY", label: "Works at another company" },
  { value: "ULPI", label: "Works at ULPI" },
  { value: "UNEMPLOYED", label: "Unemployed" },
];

// The red * after a required field's label.
function RequiredMark() {
  return (
    <span className="employee-form-required" aria-hidden="true">
      *
    </span>
  );
}

// A titled group of fields on Add Employee (Personal Information, …).
function FormSection({ icon: Icon, title, children }: { icon: typeof UserRound; title: string; children: ReactNode }) {
  return (
    <section className="employee-form-section">
      <h3 className="employee-form-section-title">
        <Icon size={15} /> {title}
      </h3>
      <div className="employee-form-section-body">{children}</div>
    </section>
  );
}

// The same role grant as User Management → Add User (HR Admin or
// Supervisor on the employee's existing login), offered from Add/Edit
// Employee too. Saved through the same /users endpoints.
type SystemRoleCode = "ADMIN" | "SUPERVISOR";

type RoleAssignment = { enabled: boolean; role: SystemRoleCode };

type RoleUserRow = {
  id: string;
  email: string;
  status: string;
  userRoles: { role: { code: string } }[];
};

const SYSTEM_ROLE_OPTIONS = [
  { value: "ADMIN", label: "HR Admin" },
  { value: "SUPERVISOR", label: "Supervisor" },
];

function getSystemRoleCode(user: RoleUserRow): SystemRoleCode | null {
  const codes = user.userRoles.map((userRole) => userRole.role.code);
  if (codes.includes("ADMIN")) return "ADMIN";
  if (codes.includes("SUPERVISOR")) return "SUPERVISOR";
  return null;
}

// /users only lists ADMIN/SUPERVISOR accounts — loaded once per open modal.
function useRoleUsers(enabled: boolean) {
  return useCachedData<RoleUserRow[]>(enabled ? "users" : null, () => apiRequest<RoleUserRow[]>("/users"));
}

function SystemRoleFields({
  value,
  onChange,
  roleUsers,
  employeeEmail,
  inactiveRole,
}: {
  value: RoleAssignment;
  onChange: (value: RoleAssignment) => void;
  roleUsers: RoleUserRow[];
  employeeEmail?: string;
  // Edit Employee: a role that was deactivated in User Management.
  inactiveRole?: SystemRoleCode | null;
}) {
  // Same rule as User Management: only one HR Admin is active at a time, and
  // the current one loses it once this employee first logs in.
  const replacesAdmin =
    value.enabled &&
    value.role === "ADMIN" &&
    roleUsers.some(
      (user) =>
        user.email.toLowerCase() !== employeeEmail?.trim().toLowerCase() &&
        getSystemRoleCode(user) === "ADMIN",
    );

  // A whole section of its own: the checkbox sits in the heading, and the
  // Role dropdown is always shown but locked until it's ticked.
  return (
    <section className="employee-form-section">
      <h3 className="employee-form-section-title">
        <label className="employee-role-toggle">
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
          />
          Assign a Role
        </label>
      </h3>
      <div className="employee-form-section-body">
        <label>
          Role
          <FormSelectDropdown
            value={value.role}
            onChange={(role) => onChange({ ...value, role: role as SystemRoleCode })}
            options={SYSTEM_ROLE_OPTIONS}
            placeholder="Select a role"
            ariaLabel="Role"
            disabled={!value.enabled}
          />
          {inactiveRole && !value.enabled && (
            <span className="employee-form-hint">
              {inactiveRole === "ADMIN" ? "HR Admin" : "Supervisor"} access is deactivated. Tick to reactivate it.
            </span>
          )}
          {replacesAdmin && (
            <span className="employee-form-hint employee-form-hint--error">
              Only one HR Admin is active at a time — the current HR Admin loses access once this employee logs in.
            </span>
          )}
        </label>
      </div>
    </section>
  );
}

// Spouse's Employment (one dropdown) plus the detail field that choice
// needs. Always shown, and disabled (not removed) unless Married, so
// changing Civil Status never resizes the modal. Same stored fields as
// before — Not provided = nothing recorded (unknown, never "unemployed").
function SpouseFields({
  form,
  setForm,
  employeeSex,
  currentSpouse,
  disabled,
}: {
  form: EmployeeForm;
  setForm: React.Dispatch<React.SetStateAction<EmployeeForm>>;
  // "" while Add Employee's Sex/Gender is still unpicked (fields disabled then).
  employeeSex: "MALE" | "FEMALE" | "";
  // Edit Employee's saved spouse — kept selectable even if since archived.
  currentSpouse?: SpouseEmployeeRef | null;
  disabled?: boolean;
}) {
  const isUlpi = form.spouseEmployment === "ULPI";
  const candidateSex = employeeSex === "MALE" ? "FEMALE" : "MALE";
  const candidatesCache = useCachedData<SpouseCandidate[]>(
    isUlpi && employeeSex ? `spouse-candidates:${candidateSex}` : null,
    () => apiRequest<SpouseCandidate[]>(`/employees/spouse-candidates?sex=${candidateSex}`),
  );
  const candidates = candidatesCache.data ?? [];
  const spouseOptions = [
    ...(currentSpouse && !candidates.some((candidate) => candidate.id === currentSpouse.id)
      ? [{ value: currentSpouse.id, label: `${currentSpouse.firstName} ${currentSpouse.lastName}` }]
      : []),
    ...candidates.map((candidate) => ({
      value: candidate.id,
      label: `${candidate.firstName} ${candidate.lastName}`,
    })),
  ];

  // One choice instead of three look-alike checkboxes; switching clears the
  // detail field the previous choice used.
  const chooseEmployment = (mode: SpouseEmployment) =>
    setForm((current) => ({
      ...current,
      spouseEmployment: mode,
      spouseEmployerName: mode === "OTHER_COMPANY" ? current.spouseEmployerName : "",
      spouseEmployeeId: mode === "ULPI" ? current.spouseEmployeeId : "",
    }));
  const isOtherCompany = form.spouseEmployment === "OTHER_COMPANY";

  // All three fields always shown, stacked; the detail fields stay disabled
  // until their choice is picked, so the column never changes size.
  return (
    <div className="employee-form-stack">
      <label>
        Spouse's Employment
        <FormSelectDropdown
          value={form.spouseEmployment}
          onChange={(value) => chooseEmployment(value as SpouseEmployment)}
          options={SPOUSE_EMPLOYMENT_OPTIONS}
          placeholder="Not provided"
          ariaLabel="Spouse's Employment"
          disabled={disabled}
        />
        {disabled && <span className="employee-form-hint">Available when Civil Status is Married.</span>}
      </label>
      <label>
        <span>
          Spouse's Company {isOtherCompany && !disabled && <RequiredMark />}
        </span>
        <input
          type="text"
          value={form.spouseEmployerName}
          onChange={(event) => setForm((current) => ({ ...current, spouseEmployerName: event.target.value }))}
          placeholder="e.g. ABC Company"
          disabled={disabled || !isOtherCompany}
        />
      </label>
      <label>
        <span>
          Spouse (ULPI Employee) {isUlpi && !disabled && <RequiredMark />}
        </span>
        <FormSelectDropdown
          value={form.spouseEmployeeId}
          onChange={(value) => setForm((current) => ({ ...current, spouseEmployeeId: value }))}
          options={spouseOptions}
          placeholder={isUlpi && candidatesCache.isLoading && spouseOptions.length === 0 ? "Loading" : "Select a spouse"}
          ariaLabel="Spouse (ULPI Employee)"
          disabled={disabled || !isUlpi || spouseOptions.length === 0}
          searchable
          menuVariant="employee"
        />
        {isUlpi && !candidatesCache.isLoading && spouseOptions.length === 0 && (
          <span className="employee-form-hint">
            No active {candidateSex === "FEMALE" ? "female" : "male"} employees found.
          </span>
        )}
      </label>
    </div>
  );
}

// The "Additional Leave Types" checklist — admin-grant-only leave types an
// employee can't file until granted here. Only offered to Regular employees.
// Always rendered (it's the right-hand column of Add/Edit Employee), so it
// explains itself instead of vanishing when nothing can be granted — keeps
// the layout from jumping as the Employee Type changes.
function AdditionalLeaveGrants({
  types,
  grantedTypeIds,
  setGrantedTypeIds,
  form,
  setForm,
  isLoading,
  employmentStatus,
}: {
  types: LeaveTypeRow[];
  grantedTypeIds: Set<string>;
  setGrantedTypeIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  form: EmployeeForm;
  setForm: React.Dispatch<React.SetStateAction<EmployeeForm>>;
  isLoading: boolean;
  // The Employee Type's status, which decides which types can be ticked.
  employmentStatus: string | undefined;
}) {
  if (types.length === 0) {
    return (
      <div className="employee-leave-grants">
        <p className="employee-leave-grants-title">
          <Info size={14} aria-hidden="true" /> Additional Leave Types{isLoading ? " (loading)" : ""}
        </p>
        {!isLoading && (
          <p className="employee-leave-grants-hint">No admin-granted leave types are set up yet (Utilities → Leave Types).</p>
        )}
      </div>
    );
  }

  const toggleGrantedType = (typeId: string) => {
    setGrantedTypeIds((current) => {
      const next = new Set(current);
      if (next.has(typeId)) next.delete(typeId);
      else next.add(typeId);
      return next;
    });
  };

  // Not picked yet counts as Single: nothing spouse-based can be granted.
  const isCivilStatusSingle = form.civilStatus === "SINGLE" || !form.civilStatus;
  const grantableCount = types.filter((type) => canGrantLeaveType(type, employmentStatus)).length;

  return (
    <div className="employee-leave-grants">
      <p className="employee-leave-grants-title">
        <Info size={14} aria-hidden="true" /> Additional Leave Types{isLoading ? " (loading)" : ""}
      </p>
      {/* Always listed so the admin sees what exists; each is tickable only
          for the Employee Types it can be granted to (see canGrantLeaveType). */}
      <p className="employee-leave-grants-hint">
        {grantableCount === 0
          ? "Available only when the Employee Type is Regular."
          : grantableCount < types.length
            ? "Tick a leave type to grant it. The others need a Regular Employee Type."
            : "Tick a leave type to grant it to this employee."}
      </p>
      {types.map((type) => {
        const isSoloParentLeave = isSoloParentLeaveType(type);
        const isIneligible = requiresSpouse(type) && isCivilStatusSingle;
        // Added Paternity Leave is transferred from a spouse who also works at
        // ULPI. An older grant already on file stays uncheckable (revocable)
        // even without one recorded — it just can't be newly granted.
        const needsUlpiSpouse = type.isTransferable && form.spouseEmployment !== "ULPI";
        const isGranted = grantedTypeIds.has(type.id);
        const isLocked =
          !canGrantLeaveType(type, employmentStatus) || isLoading || isIneligible || (needsUlpiSpouse && !isGranted);
        return (
          <div key={type.id} className="employee-leave-grant-line">
            {/* A locked line is greyed out as a whole (not just its box), so
                it's obvious it can't be ticked — e.g. Solo Parent while Single. */}
            <label className={`employee-leave-grant-row${isLocked ? " employee-leave-grant-row--locked" : ""}`}>
              <input
                type="checkbox"
                checked={isGranted}
                disabled={isLocked}
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
                {type.name} <span className="grant-days">({getGrantDays(type)} day{getGrantDays(type) === 1 ? "" : "s"})</span>
                {type.isTransferable && (
                  <span className="grant-days"> — spouse must work at ULPI; deducted from her Maternity Leave</span>
                )}
              </span>
            </label>
          </div>
        );
      })}
    </div>
  );
}

function AddEmployeeModal({
  departments,
  supervisors,
  lockedDepartmentName,
  onClose,
  onCreated,
  onImport,
  canAssignRoles,
  onRoleChanged,
}: {
  departments: DepartmentOption[];
  supervisors: SupervisorOption[];
  lockedDepartmentName?: string;
  onClose: () => void;
  onCreated: (employee: Employee) => void;
  // Opens Batch Employee Import (bottom-left of this modal's footer).
  onImport?: () => void;
  // Shows the System Role section (anyone with User Management access).
  canAssignRoles: boolean;
  onRoleChanged: () => void;
}) {
  const [form, setForm] = useState<EmployeeForm>(() => ({
    ...initialForm,
    department: lockedDepartmentName ?? initialForm.department,
  }));
  const [roleAssignment, setRoleAssignment] = useState<RoleAssignment>({ enabled: false, role: "SUPERVISOR" });
  const roleUsersCache = useRoleUsers(canAssignRoles);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const [isDownloadingTemplate, setIsDownloadingTemplate] = useState(false);
  // Set when the employee was created but a leave grant failed — shown before
  // moving on so it can't be missed. (The login email is sent in the
  // background; a final failure arrives as a bell notification instead.)
  const [postCreateIssues, setPostCreateIssues] = useState<{
    employee: Employee;
    grantError: string;
  } | null>(null);
  const { options: employeeTypeOptions, byId: employeeTypesById } = useEmployeeTypes();

  // No type is preselected: Employee Type starts on its "Select employee
  // type" placeholder like Department and Position, and must be picked
  // (validateForm requires it).

  const selectedEmploymentStatus = employeeTypesById.get(form.employeeTypeId)?.employmentStatus;

  // Position options depend on the selected department — whatever Utilities →
  // Positions makes available there (e.g. Human Resources gets its HR set).
  const selectedDepartmentId = departments.find((department) => department.name === form.department.trim())?.id;
  const { positions: availablePositions, isLoading: arePositionsLoading } = useAvailablePositions(selectedDepartmentId);

  // Department changed and the picked position isn't offered there → clear it.
  useEffect(() => {
    if (!form.positionId || arePositionsLoading) return;
    if (!availablePositions.some((position) => position.id === form.positionId)) {
      setForm((current) => ({ ...current, positionId: "" }));
    }
  }, [form.positionId, availablePositions, arePositionsLoading]);

  const availableSupervisors = supervisors.filter((supervisor) => supervisor.department.name === form.department.trim());

  // Picking a department preselects its (first) supervisor — the admin can
  // still change it or choose "No supervisor assigned", same as Edit Employee.
  const defaultSupervisorId = availableSupervisors[0]?.id ?? "";
  useEffect(() => {
    setForm((current) =>
      current.supervisorId === defaultSupervisorId ? current : { ...current, supervisorId: defaultSupervisorId },
    );
  }, [form.department, defaultSupervisorId]);

  const { all: allAttendanceModeOptions } = useAttendanceModeOptions();
  const departmentMode = departments.find((department) => department.name === form.department.trim())?.attendanceMode;
  // The mode actually submitted: the department's own when it's Non-field or
  // Field. A "Both" department needs a concrete starting mode, so the hire
  // starts Non-field (with the default Office geotag) — assigning a field site
  // in Geotagging later switches them to Field automatically.
  useEffect(() => {
    if (!departmentMode) return;
    const startingMode = departmentMode === "BOTH" ? "FIXED" : departmentMode;
    setForm((current) => (current.attendanceMode === startingMode ? current : { ...current, attendanceMode: startingMode }));
  }, [departmentMode]);

  const leaveTypesCache = useLeaveTypes();
  // Sex/Gender starts unpicked (""), which offers no sex-linked leave yet.
  const genderLeaveType = useMemo(() => findGenderLeaveType(leaveTypesCache.data, form.sex || null), [leaveTypesCache.data, form.sex]);
  const genderLeaveLabel = getGenderLeaveLabel(form.sex || null);
  // Whether the chosen Employee Type gets Paternity/Maternity leave — driven by
  // that leave type's Applicable Statuses (Utilities → Leave Types), not a
  // hardcoded list. Only decides what the allocation field shows.
  const isEntitledToParentalLeave = Boolean(
    selectedEmploymentStatus && genderLeaveType?.applicableStatuses.includes(selectedEmploymentStatus),
  );

  const adminGrantTypes = useMemo(() => getAdminGrantTypes(leaveTypesCache.data, form.sex || null), [leaveTypesCache.data, form.sex]);
  const [grantedTypeIds, setGrantedTypeIds] = useState<Set<string>>(new Set());
  const isRegular = selectedEmploymentStatus === "REGULAR";

  // The grant list stays visible (locked) for types this Employee Type can't
  // get, so switching to one clears those ticks rather than leaving them
  // looking granted.
  useEffect(() => {
    setGrantedTypeIds((current) => {
      const next = new Set(
        [...current].filter((id) => {
          const type = adminGrantTypes.find((candidate) => candidate.id === id);
          return type && canGrantLeaveType(type, selectedEmploymentStatus);
        }),
      );
      return next.size === current.size ? current : next;
    });
    if (!isRegular) {
      setForm((current) => (current.soloParentStatus === "NOT_APPLICABLE" ? current : { ...current, soloParentStatus: "NOT_APPLICABLE" }));
    }
  }, [selectedEmploymentStatus, adminGrantTypes]);

  useSpouseDependentResets({
    civilStatus: form.civilStatus,
    spouseEmployment: form.spouseEmployment,
    adminGrantTypes,
    setGrantedTypeIds,
    setForm,
  });

  // Switching Sex/Gender flips which employees can be the spouse, so a
  // previous pick no longer applies.
  useEffect(() => {
    setForm((current) => (current.spouseEmployeeId ? { ...current, spouseEmployeeId: "" } : current));
  }, [form.sex]);

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
    if (!form.positionId) return "Position is required.";
    if (!form.employeeTypeId) return "Employee Type is required.";
    if (!form.hireDate) return "Hire Date is required.";
    if (!form.sex) return "Sex/Gender is required.";
    if (!form.civilStatus) return "Civil Status is required.";
    return validateSpouse(form);
  };

  // Only ticked types this Employee Type can get, still offered for the
  // chosen sex (Added Paternity / Paternity men-only, Maternity women-only),
  // and Added Paternity Leave only with a spouse who also works at ULPI.
  const grantsToApply = adminGrantTypes.filter(
    (type) =>
      grantedTypeIds.has(type.id) &&
      canGrantLeaveType(type, selectedEmploymentStatus) &&
      !(type.isTransferable && (form.civilStatus !== "MARRIED" || form.spouseEmployment !== "ULPI")),
  );

  // Fetched on click so the template's reference sheets (departments,
  // positions, supervisors) are current, not from when the modal opened.
  const handleDownloadTemplate = async () => {
    setError("");
    setIsDownloadingTemplate(true);
    try {
      await downloadImportTemplate(await apiRequest<ImportReference>("/employees/import/reference"));
    } catch (err) {
      if (err instanceof SessionExpiredError) return;
      setError("The template could not be downloaded. Please try again.");
    } finally {
      setIsDownloadingTemplate(false);
    }
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
          // Optional — a blank field is sent as null, never "" or "N/A".
          middleName: form.middleName.trim() || null,
          lastName: form.lastName.trim(),
          email: form.email.trim(),
          department: form.department.trim(),
          positionId: form.positionId,
          employeeTypeId: form.employeeTypeId,
          attendanceMode: form.attendanceMode,
          sex: form.sex,
          // Solo Parent eligibility is set through its grant checkbox, which
          // is only offered to a Regular hire.
          soloParentStatus: isRegular ? form.soloParentStatus : "NOT_APPLICABLE",
          civilStatus: form.civilStatus,
          ...getSpousePayload(form),
          ...(form.hireDate ? { hireDate: form.hireDate } : {}),
          ...(form.supervisorId ? { supervisorId: form.supervisorId } : {}),
        },
        {
          timeout: CREATE_EMPLOYEE_TIMEOUT_MS,
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
      );

      const employee = response.data;

      // The grant endpoint needs the new employee's id, so these can only
      // run once the create has returned. A failure here doesn't undo the
      // hire — it's reported so the grant can be redone from Edit Employee.
      let grantError: string | undefined;
      if (grantsToApply.length > 0) {
        const results = await Promise.allSettled(
          grantsToApply.map((type) =>
            apiRequest(`/leave-balances/${employee.id}/grant`, {
              method: "POST",
              body: JSON.stringify({ leaveTypeId: type.id, earnedDays: getGrantDays(type) }),
            }),
          ),
        );
        const failed = grantsToApply.filter((_, index) => results[index].status === "rejected");
        if (failed.length > 0) {
          grantError = `These leave types could not be granted: ${failed.map((type) => type.name).join(", ")}. Grant them from Edit Employee.`;
        }
      }

      // Like the grants, needs the new employee's id; a failure keeps the hire.
      if (canAssignRoles && roleAssignment.enabled) {
        try {
          await apiRequest("/users", {
            method: "POST",
            body: JSON.stringify({ employeeId: employee.id, role: roleAssignment.role }),
          });
          onRoleChanged();
        } catch (err) {
          const roleError = `The system role could not be assigned: ${extractErrorMessage(err, "unknown error")} Assign it from Edit Employee or User Management.`;
          grantError = grantError ? `${grantError} ${roleError}` : roleError;
        }
      }

      if (grantError) {
        setPostCreateIssues({ employee, grantError });
        return;
      }
      onCreated(employee);
    } catch (err) {
      setError(
        axios.isAxiosError(err) && err.code === "ECONNABORTED"
          ? "The server did not respond in time. The employee may already have been added — check the employee list before trying again."
          : extractErrorMessage(err, "Unable to add employee."),
      );
    } finally {
      setIsSaving(false);
    }
  };

  if (postCreateIssues) {
    const { employee, grantError } = postCreateIssues;
    return (
      <EmployeeModal title="Employee Added" onClose={() => onCreated(employee)}>
        <p>
          {employee.firstName} {employee.lastName} ({employee.employeeNo}) was added successfully.
        </p>
        <p className="employee-form-error">{grantError}</p>
        <div className="employee-form-actions">
          <button type="button" className="primary-button" onClick={() => onCreated(employee)}>
            Continue
          </button>
        </div>
      </EmployeeModal>
    );
  }

  return (
    <EmployeeModal
      title="Add Employee"
      description="Fields marked * are required."
      onClose={onClose}
      split
    >
      <form className="employee-form" onSubmit={handleSubmit}>
        {/* Three side-by-side columns, one per section, fields stacked. */}
        <div className="employee-form-sections">
          {/* First column: Personal Information, then Assign a Role. */}
          <div className="employee-form-stack">
            <FormSection icon={UserRound} title="Personal Information">
              <div className="employee-form-stack">
                <label>
                  <span>First Name <RequiredMark /></span>
                  <input type="text" value={form.firstName} onChange={updateField("firstName")} placeholder="e.g. Juan" required />
                </label>
                <label>
                  <span>
                    Middle Name <span className="employee-form-optional">(Optional)</span>
                  </span>
                  <input type="text" value={form.middleName} onChange={updateField("middleName")} placeholder="e.g. Santos" />
                </label>
                <label>
                  <span>Last Name <RequiredMark /></span>
                  <input type="text" value={form.lastName} onChange={updateField("lastName")} placeholder="e.g. Dela Cruz" required />
                </label>
                <label>
                  <span>Email <RequiredMark /></span>
                  <input type="email" value={form.email} onChange={updateField("email")} placeholder="e.g. employee@example.com" required />
                </label>
                <label>
                  <span>Sex/Gender <RequiredMark /></span>
                  <FormSelectDropdown
                    value={form.sex}
                    onChange={(value) => setForm((current) => ({ ...current, sex: value as EmployeeForm["sex"] }))}
                    options={[
                      { value: "MALE", label: "Male" },
                      { value: "FEMALE", label: "Female" },
                    ]}
                    placeholder="Select sex/gender"
                    ariaLabel="Sex/Gender"
                  />
                </label>
                <label>
                  <span>Civil Status <RequiredMark /></span>
                  <FormSelectDropdown
                    value={form.civilStatus}
                    onChange={(value) => setForm((current) => ({ ...current, civilStatus: value as EmployeeForm["civilStatus"] }))}
                    options={CIVIL_STATUS_OPTIONS}
                    placeholder="Select civil status"
                    ariaLabel="Civil Status"
                  />
                </label>
              </div>
            </FormSection>
            {canAssignRoles && (
              <SystemRoleFields
                value={roleAssignment}
                onChange={setRoleAssignment}
                roleUsers={roleUsersCache.data ?? []}
                employeeEmail={form.email}
              />
            )}
          </div>

          <FormSection icon={Briefcase} title="Employment Details">
            <div className="employee-form-stack">
              <label>
                <span>Department <RequiredMark /></span>
                {lockedDepartmentName ? (
                  <input type="text" value={lockedDepartmentName} disabled readOnly />
                ) : (
                  <FormSelectDropdown
                    value={form.department}
                    onChange={(value) => setForm((current) => ({ ...current, department: value }))}
                    options={departments.map((department) => ({ value: department.name, label: department.name }))}
                    placeholder="Select a department"
                    ariaLabel="Department"
                  />
                )}
              </label>
              <label>
                <span>Position <RequiredMark /></span>
                <FormSelectDropdown
                  value={form.positionId}
                  onChange={(value) => setForm((current) => ({ ...current, positionId: value }))}
                  options={availablePositions.map((position) => ({ value: position.id, label: position.title }))}
                  placeholder={selectedDepartmentId ? "Select a position" : "Select a department first"}
                  ariaLabel="Position"
                  disabled={!selectedDepartmentId || availablePositions.length === 0}
                />
                {selectedDepartmentId && !arePositionsLoading && availablePositions.length === 0 && (
                  <span className="employee-form-hint">No positions are available for this department yet (Utilities → Positions).</span>
                )}
              </label>
              <label>
                <span>Employee Type <RequiredMark /></span>
                <FormSelectDropdown
                  value={form.employeeTypeId}
                  onChange={(value) => setForm((current) => ({ ...current, employeeTypeId: value }))}
                  options={employeeTypeOptions}
                  placeholder="Select employee type"
                  ariaLabel="Employee Type"
                  disabled={employeeTypeOptions.length === 0}
                />
              </label>
              <label>
                <span>Hire Date <RequiredMark /></span>
                <input type="date" value={form.hireDate} onChange={updateField("hireDate")} required />
              </label>
              <label>
                Attendance Mode
                {/* Shows the department's own mode — "Both" included — same
                    as the Mode column in the employee list. Never picked here.
                    Full width so the whole placeholder fits. */}
                <input
                  type="text"
                  value={departmentMode ? getAttendanceModeLabel(departmentMode, allAttendanceModeOptions) : ""}
                  placeholder="Based on the department"
                  disabled
                  readOnly
                />
              </label>
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
                  placeholder={form.department.trim() ? "Select a supervisor" : "Select a department first"}
                  ariaLabel="Supervisor"
                  disabled={!form.department.trim()}
                />
              </label>
              {/* Read-only: a new hire gets the leave type's default allotment
                  from Utilities → Leave Types; says "Not applicable" when the
                  chosen Employee Type isn't entitled to it. */}
              {/* Hidden when the type is "Admin-grant only": it's then granted
                  (or not) through the Leave Entitlements checklist instead. */}
              {genderLeaveLabel && genderLeaveType && !genderLeaveType.requiresAdminGrant && (
                <label>
                  {genderLeaveLabel}
                  <input
                    type="text"
                    value={
                      isEntitledToParentalLeave
                        ? String(Number(genderLeaveType.defaultDays))
                        : "Not applicable to this Employee Type"
                    }
                    disabled
                    readOnly
                  />
                </label>
              )}
            </div>
          </FormSection>

          {/* Third column: spouse details, then the leave grants (Added
              Paternity / Solo Parent depend on the spouse details above). */}
          <div className="employee-form-stack">
            <FormSection icon={Users} title="Spouse Employment (If Applicable)">
              <SpouseFields
                form={form}
                setForm={setForm}
                employeeSex={form.sex}
                disabled={form.civilStatus !== "MARRIED" || !form.sex}
              />
            </FormSection>
            <FormSection icon={CalendarDays} title="Leave Entitlements">
              <AdditionalLeaveGrants
                types={adminGrantTypes}
                grantedTypeIds={grantedTypeIds}
                setGrantedTypeIds={setGrantedTypeIds}
                form={form}
                setForm={setForm}
                isLoading={leaveTypesCache.isLoading}
                employmentStatus={selectedEmploymentStatus}
              />
            </FormSection>
          </div>
        </div>

        {error && <p className="employee-form-error">{error}</p>}

        <div className="employee-form-actions">
          {onImport && (
            <div className="employee-import-group">
              <button type="button" className="employee-import-button" onClick={onImport} disabled={isSaving}>
                <FileUp size={16} /> Import Employees
              </button>
              <button
                type="button"
                className="employee-import-button"
                onClick={handleDownloadTemplate}
                disabled={isSaving || isDownloadingTemplate}
              >
                {isDownloadingTemplate ? <Loader2 size={16} className="import-spin" /> : <Download size={16} />}
                Download Template
              </button>
            </div>
          )}
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
  supervisors,
  lockedDepartmentName,
  onClose,
  onUpdated,
  onSynced,
  onSaveFailed,
  canAssignRoles,
  onRoleChanged,
}: {
  employee: Employee;
  departments: DepartmentOption[];
  supervisors: SupervisorOption[];
  lockedDepartmentName?: string;
  onClose: () => void;
  onUpdated: (employee: Employee) => void;
  onSynced: (employee: Employee) => void;
  onSaveFailed: (message: string) => void;
  canAssignRoles: boolean;
  onRoleChanged: () => void;
}) {
  // The employee's current role account (if any), matched by login email the
  // same way User Management does.
  const roleUsersCache = useRoleUsers(canAssignRoles);
  const roleUser = roleUsersCache.data?.find(
    (user) => user.email.toLowerCase() === employee.user?.email?.toLowerCase(),
  );
  const currentRole = roleUser ? getSystemRoleCode(roleUser) : null;
  const isRoleActive = roleUser?.status === "ACTIVE";
  const [roleAssignment, setRoleAssignment] = useState<RoleAssignment>({ enabled: false, role: "SUPERVISOR" });
  // Seeded once the /users list arrives (instantly on a warm cache), never
  // overwriting what the admin has already changed.
  const roleSeededRef = useRef(false);
  useEffect(() => {
    if (roleSeededRef.current || !roleUsersCache.data) return;
    roleSeededRef.current = true;
    if (currentRole) setRoleAssignment({ enabled: isRoleActive, role: currentRole });
  }, [roleUsersCache.data, currentRole, isRoleActive]);

  const [form, setForm] = useState<EditEmployeeForm>({
    firstName: employee.firstName,
    middleName: employee.middleName ?? "",
    lastName: employee.lastName,
    email: employee.user?.email ?? "",
    department: employee.department.name,
    positionId: employee.positionId,
    hireDate: getDateInputValue(employee.hireDate),
    employeeTypeId: employee.employeeTypeId,
    attendanceMode: employee.attendanceMode ?? "FIXED",
    soloParentStatus: employee.soloParentStatus ?? "NOT_APPLICABLE",
    civilStatus: employee.civilStatus ?? "SINGLE",
    spouseEmployment: getInitialSpouseEmployment(employee),
    spouseEmployerName: employee.spouseEmployerName ?? "",
    spouseEmployeeId: employee.spouseEmployeeId ?? "",
    sex: employee.sex === "FEMALE" ? "FEMALE" : "MALE",
    supervisorId: employee.supervisor?.id ?? "",
  });
  const [error, setError] = useState("");

  // Same department-based Position list as Add Employee (Utilities →
  // Positions). The employee's current position stays selectable while they
  // remain in their current department, even if it's archived/not offered.
  const editDepartmentId = departments.find((department) => department.name === form.department.trim())?.id;
  const { positions: editAvailablePositions, isLoading: areEditPositionsLoading } = useAvailablePositions(editDepartmentId);
  const keepsCurrentPosition =
    form.department.trim() === employee.department.name && form.positionId === employee.positionId;
  const positionOptions = [
    ...(form.department.trim() === employee.department.name &&
    !editAvailablePositions.some((position) => position.id === employee.positionId)
      ? [{ value: employee.positionId, label: `${employee.position.title} (current)` }]
      : []),
    ...editAvailablePositions.map((position) => ({ value: position.id, label: position.title })),
  ];

  // Department changed and the picked position isn't offered there → clear it.
  useEffect(() => {
    if (!form.positionId || areEditPositionsLoading || keepsCurrentPosition) return;
    if (!editAvailablePositions.some((position) => position.id === form.positionId)) {
      setForm((current) => ({ ...current, positionId: "" }));
    }
  }, [form.positionId, editAvailablePositions, areEditPositionsLoading, keepsCurrentPosition]);

  const { active: activeEmployeeTypes, byId: employeeTypesById } = useEmployeeTypes();
  // The Employment Status of whichever Employee Type is currently picked in
  // this form — what the leave/probation-dependent UI below reacts to.
  const selectedEmployeeType = employeeTypesById.get(form.employeeTypeId) ?? employee.employeeType ?? null;
  const selectedEmploymentStatus = selectedEmployeeType?.employmentStatus ?? employee.employmentStatus;

  const { all: allAttendanceModeOptions } = useAttendanceModeOptions();
  const departmentMode = departments.find((department) => department.name === form.department.trim())?.attendanceMode;
  const isModeLocked = !!departmentMode && departmentMode !== "BOTH";

  useEffect(() => {
    if (isModeLocked && departmentMode && form.attendanceMode !== departmentMode) {
      setForm((current) => ({ ...current, attendanceMode: departmentMode }));
    }
  }, [isModeLocked, departmentMode]);
  const [grantedTypeIds, setGrantedTypeIds] = useState<Set<string>>(new Set());
  const [initialGrantedTypeIds, setInitialGrantedTypeIds] = useState<Set<string>>(new Set());

  const availableSupervisors = supervisors.filter(
    (supervisor) => supervisor.id !== employee.id && supervisor.department.name === form.department.trim(),
  );

  const genderLeaveLabel = getGenderLeaveLabel(employee.sex);

  // The allocation field and the admin-grant checklist both read the same
  // two endpoints — routing them through the shared stale-while-revalidate
  // cache means any employee this modal (or LeavePage) has already fetched
  // renders instantly instead of showing "Loading..." again, and a cold open
  // only fires 2 requests total instead of 4.
  const leaveTypesCache = useLeaveTypes();
  const balancesCache = useCachedData<{ leaveTypeId: string; earnedDays: number }[]>(
    CACHE_KEYS.leaveBalances(employee.id),
    () => apiRequest(`/leave-balances/${employee.id}`),
  );

  const isAllocationLoading = leaveTypesCache.isLoading || balancesCache.isLoading;
  const isGrantsLoading = leaveTypesCache.isLoading || balancesCache.isLoading;

  const genderLeaveType = useMemo(
    () => findGenderLeaveType(leaveTypesCache.data, employee.sex),
    [employee.sex, leaveTypesCache.data],
  );
  const genderLeaveTypeId = genderLeaveType?.id ?? null;
  // This year's earned days (live from the balances cache, so an Added
  // Paternity transfer shows up on the wife's side). Undefined = the type
  // doesn't apply to this employee's Employee Type.
  const genderLeaveBalance = balancesCache.data?.find((b) => b.leaveTypeId === genderLeaveTypeId);
  const genderLeaveAllocation = genderLeaveBalance ? String(genderLeaveBalance.earnedDays) : undefined;

  const adminGrantTypes = useMemo(
    () => getAdminGrantTypes(leaveTypesCache.data, employee.sex),
    [leaveTypesCache.data, employee.sex],
  );

  // Seeds the editable local state exactly once, the first time both caches
  // have data — which, on a warm cache, is the very first render. A later
  // background revalidation must never clobber whatever the admin has
  // already checked or typed in this open modal.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    if (!leaveTypesCache.data || !balancesCache.data) return;
    seededRef.current = true;

    const granted = new Set(
      balancesCache.data
        .filter((b) => b.earnedDays > 0 && adminGrantTypes.some((t) => t.id === b.leaveTypeId))
        .map((b) => b.leaveTypeId),
    );
    setGrantedTypeIds(granted);
    setInitialGrantedTypeIds(granted);
  }, [leaveTypesCache.data, balancesCache.data, adminGrantTypes]);

  // Declared after the seeding effect above so, on the render the caches
  // load, its revocations run last and win.
  useSpouseDependentResets({
    civilStatus: form.civilStatus,
    spouseEmployment: form.spouseEmployment,
    adminGrantTypes,
    setGrantedTypeIds,
    setForm,
  });

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
    if (!form.positionId) return "Position is required.";
    if (!form.hireDate) return "Hire Date is required.";
    return validateSpouse(form);
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

    const spousePayload = getSpousePayload(form);
    const optimisticSpouse = spousePayload.spouseEmployeeId
      ? spousePayload.spouseEmployeeId === employee.spouseEmployee?.id
        ? employee.spouseEmployee
        : (() => {
            const match = cacheGet<SpouseCandidate[]>(`spouse-candidates:${employee.sex === "MALE" ? "FEMALE" : "MALE"}`)?.find(
              (candidate) => candidate.id === spousePayload.spouseEmployeeId,
            );
            return match
              ? { id: match.id, firstName: match.firstName, lastName: match.lastName, employeeNo: match.employeeNo }
              : null;
          })()
      : null;

    onUpdated({
      ...employee,
      firstName: form.firstName.trim(),
      middleName: form.middleName.trim() || null,
      lastName: form.lastName.trim(),
      user: employee.user ? { ...employee.user, email: form.email.trim() } : employee.user,
      department: { name: form.department.trim(), attendanceMode: departmentMode ?? employee.department.attendanceMode },
      positionId: form.positionId,
      position: { title: positionOptions.find((option) => option.value === form.positionId)?.label.replace(/ \(current\)$/, "") ?? employee.position.title },
      employeeTypeId: form.employeeTypeId,
      employeeType: selectedEmployeeType,
      // An archived employee stays SEPARATED on edit (only Restore reactivates).
      employmentStatus: employee.employmentStatus === "SEPARATED" ? "SEPARATED" : selectedEmploymentStatus,
      attendanceMode: form.attendanceMode,
      soloParentStatus: form.soloParentStatus,
      civilStatus: form.civilStatus || undefined,
      spouseEmployerName: spousePayload.spouseEmployerName,
      spouseUnemployed: spousePayload.spouseUnemployed,
      spouseEmployeeId: spousePayload.spouseEmployeeId || null,
      spouseEmployee: optimisticSpouse,
      supervisor: optimisticSupervisor ?? null,
      hireDate: form.hireDate || employee.hireDate,
    });

    const token = localStorage.getItem("accessToken");
    const patchPromise = axios.patch<Employee>(
      `${API_BASE_URL}/employees/${employee.id}`,
      {
        firstName: form.firstName.trim(),
        // Always sent, so clearing the field removes a saved middle name.
        middleName: form.middleName.trim() || null,
        lastName: form.lastName.trim(),
        email: form.email.trim(),
        department: form.department.trim(),
        positionId: form.positionId,
        employeeTypeId: form.employeeTypeId,
        attendanceMode: form.attendanceMode,
        soloParentStatus: form.soloParentStatus,
        civilStatus: form.civilStatus,
        ...spousePayload,
        supervisorId: form.supervisorId,
        ...(form.hireDate ? { hireDate: form.hireDate } : {}),
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

    // Grants run only after the employee save lands: an Added Paternity grant
    // takes its days from whichever wife the server has linked at that
    // moment, so it must see the spouse picked in this same save.
    const runGrants = () =>
      Promise.all(
        changedTypeIds.map((typeId) => {
          const type = adminGrantTypes.find((t) => t.id === typeId)!;
          const isGranted = grantedTypeIds.has(typeId);
          return apiRequest(`/leave-balances/${employee.id}/grant`, {
            method: "POST",
            body: JSON.stringify({
              leaveTypeId: typeId,
              earnedDays: isGranted ? getGrantDays(type) : 0,
            }),
          });
        }),
      );

    // Wives whose Maternity balance this save may have moved (old and new link).
    const spouseChanged = (employee.spouseEmployeeId ?? "") !== spousePayload.spouseEmployeeId;
    const affectedSpouseIds =
      spouseChanged || changedTypeIds.length > 0
        ? [employee.spouseEmployeeId, spousePayload.spouseEmployeeId].filter((id): id is string => Boolean(id))
        : [];

    // Role changes use User Management's own actions: Add User grants or
    // switches the role, Deactivate/Activate removes or restores it.
    const runRoleChange = async () => {
      if (!canAssignRoles || !roleSeededRef.current) return;
      const wasActive = Boolean(currentRole && isRoleActive);
      if (roleAssignment.enabled) {
        if (wasActive && roleAssignment.role === currentRole) return;
        await apiRequest("/users", {
          method: "POST",
          body: JSON.stringify({ employeeId: employee.id, role: roleAssignment.role }),
        });
        if (roleUser && !isRoleActive) {
          await apiRequest(`/users/${roleUser.id}/status`, { method: "PATCH", body: JSON.stringify({ status: "ACTIVE" }) });
        }
      } else if (wasActive && roleUser) {
        await apiRequest(`/users/${roleUser.id}/status`, { method: "PATCH", body: JSON.stringify({ status: "INACTIVE" }) });
      } else {
        return;
      }
      onRoleChanged();
    };

    patchPromise
      .then(async (response) => {
        if (changedTypeIds.length > 0) await runGrants();
        await runRoleChange();
        onSynced(response.data);
        // The grant POST above writes straight to the server, bypassing the
        // shared leave-balances cache — without this, reopening Edit
        // Employee (or the employee's own Leave page) would keep reading the
        // pre-grant snapshot and show the checkbox unchecked even though
        // soloParentStatus already says Eligible.
        for (const id of changedTypeIds.length > 0 ? [employee.id, ...affectedSpouseIds] : affectedSpouseIds) {
          revalidateCached(CACHE_KEYS.leaveBalances(id), () => apiRequest(`/leave-balances/${id}`)).catch(() => undefined);
        }
      })
      .catch((err) => onSaveFailed(extractErrorMessage(err, "Unable to update employee.")));
  };

  const regularization = getRegularizationEligibility(employee);
  const restrictedStatus = regularization.targetStatus && !regularization.isEligible ? regularization.targetStatus : null;

  return (
    <EmployeeModal title="Edit Employee" description={getEmployeeName(employee)} onClose={onClose} split>
      <form className="employee-form" onSubmit={handleSubmit}>
        {/* Same three columns as Add Employee: Personal | Employment | Spouse. */}
        <div className="employee-form-sections">
          {/* First column: Personal Information, then Assign a Role. */}
          <div className="employee-form-stack">
            <FormSection icon={UserRound} title="Personal Information">
              <div className="employee-form-stack">
                <label>
                  <span>First Name <RequiredMark /></span>
                  <input type="text" value={form.firstName} onChange={updateField("firstName")} required />
                </label>
                <label>
                  <span>
                    Middle Name <span className="employee-form-optional">(Optional)</span>
                  </span>
                  <input type="text" value={form.middleName} onChange={updateField("middleName")} />
                </label>
                <label>
                  <span>Last Name <RequiredMark /></span>
                  <input type="text" value={form.lastName} onChange={updateField("lastName")} required />
                </label>
                <label>
                  <span>Email <RequiredMark /></span>
                  <input type="email" value={form.email} onChange={updateField("email")} required />
                </label>
                <label>
                  Sex/Gender
                  {/* Not editable after creation. */}
                  <input type="text" value={employee.sex === "FEMALE" ? "Female" : employee.sex === "MALE" ? "Male" : "Not set"} disabled readOnly />
                </label>
                <label>
                  <span>Civil Status <RequiredMark /></span>
                  <FormSelectDropdown
                    value={form.civilStatus}
                    onChange={(value) => setForm((current) => ({ ...current, civilStatus: value as EmployeeForm["civilStatus"] }))}
                    options={CIVIL_STATUS_OPTIONS}
                    placeholder="Select civil status"
                    ariaLabel="Civil Status"
                  />
                </label>
              </div>
            </FormSection>
            {canAssignRoles && (
              <SystemRoleFields
                value={roleAssignment}
                onChange={setRoleAssignment}
                roleUsers={roleUsersCache.data ?? []}
                employeeEmail={employee.user?.email}
                inactiveRole={roleUser && !isRoleActive ? currentRole : null}
              />
            )}
          </div>

          <FormSection icon={Briefcase} title="Employment Details">
            <div className="employee-form-stack">
              <label>
                <span>Department <RequiredMark /></span>
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
                    placeholder="Select a department"
                    ariaLabel="Department"
                  />
                )}
              </label>
              <label>
                <span>Position <RequiredMark /></span>
                <FormSelectDropdown
                  value={form.positionId}
                  onChange={(value) => setForm((current) => ({ ...current, positionId: value }))}
                  options={positionOptions}
                  placeholder="Select a position"
                  ariaLabel="Position"
                  disabled={positionOptions.length === 0}
                />
              </label>
              <label>
                <span>Employee Type <RequiredMark /></span>
                <FormSelectDropdown
                  value={form.employeeTypeId}
                  onChange={(value) => setForm((current) => ({ ...current, employeeTypeId: value }))}
                  options={[
                    // Kept even if since archived so the currently-assigned type still displays correctly.
                    ...(employee.employeeType && !activeEmployeeTypes.some((type) => type.id === employee.employeeTypeId)
                      ? [{ value: employee.employeeTypeId, label: `${employee.employeeType.name} (archived)` }]
                      : []),
                    ...activeEmployeeTypes.map((type) => ({
                      value: type.id,
                      label: type.name,
                      // Still on probation: every type that would regularize them is locked.
                      disabled: type.employmentStatus === restrictedStatus && type.id !== employee.employeeTypeId,
                    })),
                  ]}
                  placeholder="Select employee type"
                  ariaLabel="Employee Type"
                />
              </label>
              <label>
                <span>Hire Date <RequiredMark /></span>
                <input type="date" value={form.hireDate} onChange={updateField("hireDate")} required />
              </label>
              <label>
                Attendance Mode
                {/* Shows the department's mode ("Both" included), same as the
                    Mode column in the employee list. Read-only: the employee's
                    concrete mode is set by the backend from their assigned
                    geotagged area — see GeolocationService.syncAttendanceModes. */}
                <input
                  type="text"
                  value={getAttendanceModeLabel(departmentMode === "BOTH" ? "BOTH" : form.attendanceMode, allAttendanceModeOptions)}
                  placeholder="Based on the department"
                  disabled
                  readOnly
                />
              </label>
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
                  placeholder="Select a supervisor"
                  ariaLabel="Supervisor"
                />
              </label>
              {genderLeaveLabel && (isAllocationLoading || genderLeaveTypeId) && !genderLeaveType?.requiresAdminGrant && (
                <label>
                  {genderLeaveLabel}
                  {/* Read-only: allotments come from Utilities → Leave Types
                      (and Added Paternity transfers), never edited per employee. */}
                  <input
                    type="text"
                    value={isAllocationLoading ? "" : (genderLeaveAllocation ?? "Not applicable to this Employee Type")}
                    placeholder="Loading"
                    disabled
                    readOnly
                  />
                </label>
              )}
            </div>
          </FormSection>

          {/* Third column: spouse details, then the leave grants (Added
              Paternity / Solo Parent depend on the spouse details above). */}
          <div className="employee-form-stack">
            <FormSection icon={Users} title="Spouse Employment (If Applicable)">
              {employee.sex ? (
                <SpouseFields
                  form={form}
                  setForm={setForm}
                  employeeSex={employee.sex}
                  currentSpouse={employee.spouseEmployee}
                  disabled={form.civilStatus !== "MARRIED"}
                />
              ) : (
                <p className="employee-form-hint">Spouse details need the employee's Sex/Gender on file.</p>
              )}
            </FormSection>
            {/* Only a Regular employee is eligible for these — reacts to the
                form's own Employee Type (its Employment Status) so toggling the
                dropdown in this same modal updates it immediately. */}
            <FormSection icon={CalendarDays} title="Leave Entitlements">
              <AdditionalLeaveGrants
                types={adminGrantTypes}
                grantedTypeIds={grantedTypeIds}
                setGrantedTypeIds={setGrantedTypeIds}
                form={form}
                setForm={setForm}
                isLoading={isGrantsLoading}
                employmentStatus={selectedEmploymentStatus}
              />
            </FormSection>
          </div>
        </div>

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
  systemRole,
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
  // Active HR Admin/Supervisor role, shown as a badge beside the name.
  systemRole?: SystemRoleCode | null;
}) {
  // Same condition the "Register Face" button below is disabled for — the
  // banner explains why (see FaceRegistrationPage's own "Employee Consent
  // Required" modal, which explains the same wait to an admin already on
  // that page).
  const consentPending = Boolean(
    employee.requiresFaceConsent && !employee.faceConsentAcceptedAt && employee.employmentStatus !== "SEPARATED",
  );

  const attendanceModeCode = employee.department.attendanceMode === "BOTH" ? "BOTH" : employee.attendanceMode;
  const tenure = employee.hireDate ? getTenure(employee.hireDate) : null;
  const spouseEmployment = employee.spouseEmployeeId
    ? "Works at ULPI"
    : employee.spouseEmployerName
      ? "Works at another company"
      : employee.spouseUnemployed
        ? "Unemployed"
        : "Not provided";
  const isMarried = employee.civilStatus === "MARRIED";
  const show = (value?: string | null) => (value && value.trim() ? value : "—");

  return (
    <EmployeeModal
      title="Employee Details"
      description={getEmployeeName(employee)}
      onClose={onClose}
      split
    >
      {/* Same three columns as Add/Edit Employee, showing values instead of
          inputs: Personal | Employment | Spouse Employment. */}
      <div className="employee-detail-body">
        <div className="employee-form-sections">
          {/* First column: Personal Information, then the role (only for
              employees who hold one), same place as in Add/Edit Employee. */}
          <div className="employee-form-stack">
            <FormSection icon={UserRound} title="Personal Information">
              <div className="employee-form-stack">
                <div className="employee-view-field">
                  <span>First Name</span>
                  <strong>{show(employee.firstName)}</strong>
                </div>
                <div className="employee-view-field">
                  <span>Middle Name</span>
                  <strong>{show(employee.middleName)}</strong>
                </div>
                <div className="employee-view-field">
                  <span>Last Name</span>
                  <strong>{show(employee.lastName)}</strong>
                </div>
                <div className="employee-view-field">
                  <span>Email</span>
                  <strong>{employee.user?.email ?? "Unassigned"}</strong>
                </div>
                <div className="employee-view-field">
                  <span>Sex/Gender</span>
                  <strong>{employee.sex === "FEMALE" ? "Female" : employee.sex === "MALE" ? "Male" : "Not set"}</strong>
                </div>
                <div className="employee-view-field">
                  <span>Civil Status</span>
                  <strong>
                    {employee.civilStatus ? employee.civilStatus.charAt(0) + employee.civilStatus.slice(1).toLowerCase() : "Single"}
                  </strong>
                </div>
              </div>
            </FormSection>
            {systemRole && (
              <FormSection icon={UserCheck} title="Assigned Role">
                <div className="employee-view-field">
                  <span>Role</span>
                  {/* Same wording as User Management's Role column. */}
                  <strong>{systemRole === "ADMIN" ? "HR Admin" : `${employee.department.name} Supervisor`}</strong>
                </div>
              </FormSection>
            )}
          </div>

          <FormSection icon={Briefcase} title="Employment Details">
            <div className="employee-form-stack">
              <div className="employee-view-field">
                <span>Department</span>
                <strong>{employee.department.name}</strong>
              </div>
              <div className="employee-view-field">
                <span>Position</span>
                <strong>{employee.position.title}</strong>
              </div>
              <div className="employee-view-field">
                <span>Employee Type</span>
                <strong>{getStatusLabel(employee)}</strong>
              </div>
              <div className="employee-view-field">
                <span>Hire Date</span>
                {/* Time in service on the same line, so every item stays one
                    line and the rows line up across the three columns. */}
                <strong>
                  {employee.hireDate
                    ? new Date(employee.hireDate).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
                    : "—"}
                  {tenure && (
                    <em>
                      {" · "}
                      {tenure.months > 0
                        ? `${tenure.months} month${tenure.months === 1 ? "" : "s"}`
                        : tenure.days > 0
                          ? `${tenure.days} day${tenure.days === 1 ? "" : "s"}`
                          : "New hire"}
                    </em>
                  )}
                </strong>
              </div>
              <div className="employee-view-field">
                <span>Attendance Mode</span>
                {/* Same as the list's Mode column: a "Both" department shows Both. */}
                <strong>{getAttendanceModeLabel(attendanceModeCode, attendanceModeOptions)}</strong>
              </div>
              <div className="employee-view-field">
                <span>Supervisor</span>
                <strong>
                  {/* A supervisor/HR Admin has no one above them — say so
                      rather than "Unassigned", which reads as missing data. */}
                  {employee.supervisor
                    ? `${employee.supervisor.firstName} ${employee.supervisor.lastName}`
                    : systemRole === "SUPERVISOR"
                      ? "None (department supervisor)"
                      : systemRole === "ADMIN"
                        ? "None (HR Admin)"
                        : "Unassigned"}
                </strong>
              </div>
            </div>
          </FormSection>

          {/* Third column: spouse details, then (while it's pending) the
              face-consent notice — in the column's free space rather than a
              full-width banner under all three columns. */}
          <div className="employee-form-stack">
          <FormSection icon={Users} title="Spouse Employment (If Applicable)">
            <div className="employee-form-stack">
              <div className="employee-view-field">
                <span>Spouse's Employment</span>
                <strong>{isMarried ? spouseEmployment : "Not applicable"}</strong>
              </div>
              <div className="employee-view-field">
                <span>Spouse's Company</span>
                <strong>{isMarried ? show(employee.spouseEmployerName) : "—"}</strong>
              </div>
              <div className="employee-view-field">
                <span>Spouse (ULPI Employee)</span>
                <strong>
                  {isMarried && employee.spouseEmployee
                    ? `${employee.spouseEmployee.firstName} ${employee.spouseEmployee.lastName} (${employee.spouseEmployee.employeeNo})`
                    : "—"}
                </strong>
              </div>
              {employee.soloParentStatus && employee.soloParentStatus !== "NOT_APPLICABLE" && (
                <div className="employee-view-field">
                  <span>Solo Parent Status</span>
                  <strong>{employee.soloParentStatus === "ELIGIBLE" ? "Eligible" : "Ineligible"}</strong>
                </div>
              )}
            </div>
          </FormSection>
          {consentPending && (
            <FormSection icon={ScanFace} title="Face Registration">
              <div className="employee-view-note" role="status">
                <AlertTriangle size={16} />
                <div>
                  <strong>Consent pending</strong>
                  <p>The employee must accept the face-data consent on the mobile app before their face can be registered.</p>
                </div>
              </div>
            </FormSection>
          )}
          </div>
        </div>
      </div>
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
          </div>
        </div>
      )}

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
          <button
            type="button"
            className="outline-button"
            onClick={onRegisterFace}
            disabled={consentPending}
            title={consentPending ? "Waiting for the employee to accept the face-data consent on the mobile app" : undefined}
          >
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

  // Step 1 is the Archive Type / Date / Reason form; submitting it only moves
  // on to the "Are you sure?" step — nothing is saved until that's confirmed.
  const handleFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setConfirmed(true);
  };

  const handleArchive = async () => {
    setIsSaving(true);
    setError("");

    try {
      const archived = await apiRequest<Employee>(`/employees/${employee.id}/archive`, {
        method: "PATCH",
        body: JSON.stringify({ archiveType, effectiveDate, reason }),
      });
      onArchived(archived);
    } catch (err) {
      // Back to the form (entries kept) so the error is shown next to them.
      setError(err instanceof Error ? err.message : "Unable to archive employee.");
      setConfirmed(false);
    } finally {
      setIsSaving(false);
    }
  };

  if (confirmed) {
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
            <button type="button" className="employee-archive-action" onClick={handleArchive} disabled={isSaving}>
              {isSaving ? "Archiving..." : "Archive Employee"}
            </button>
            {/* Back to the form with the entries kept. */}
            <button type="button" className="outline-button" onClick={() => setConfirmed(false)} disabled={isSaving}>
              Cancel
            </button>
          </div>
        </div>
      </EmployeeModal>
    );
  }

  return (
    <EmployeeModal title="Archive Employee" description={getEmployeeName(employee)} onClose={onClose} small>
      <form className="employee-form" onSubmit={handleFormSubmit}>
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
              placeholder="Select archive type"
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
          <button type="submit" className="employee-archive-action">
            Archive Employee
          </button>
          <button type="button" className="outline-button" onClick={onClose}>
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
  user?: { permissions: PermissionCode[]; roles?: string[]; departmentId?: string; department?: string; employeeId?: string };
  
  onEmployeeCreated?: (employee: Employee) => void;
  onRegisterFace?: (employee: Employee) => void;
  
  initialFocusEmployeeId?: string;
  onFocusHandled?: () => void;
}) {
  const canWrite = user?.permissions.includes(permissions.employeesWrite) ?? true;
  const roles = user?.roles ?? [];
  const isDepartmentLocked = roles.includes("SUPERVISOR") && !roles.includes("ADMIN");
  const lockedDepartmentName = isDepartmentLocked ? user?.department : undefined;
  // Same access as the User Management page; a department-locked supervisor
  // never grants roles.
  const canAssignRoles = Boolean(user?.permissions.includes(permissions.usersRead)) && !isDepartmentLocked;

  const [departmentFilter, setDepartmentFilter] = useState("ALL");
  const [positionFilter, setPositionFilter] = useState("ALL");
  const [roleFilter, setRoleFilter] = useState("ALL");
  // Active system role per login email — what the Role filter matches on.
  // A role deactivated in User Management counts as No Role.
  const roleUsersCache = useRoleUsers(canAssignRoles);
  const activeRoleByEmail = new Map(
    (roleUsersCache.data ?? [])
      .filter((roleUser) => roleUser.status === "ACTIVE")
      .map((roleUser) => [roleUser.email.toLowerCase(), getSystemRoleCode(roleUser)] as const),
  );
  const [nameSort, setNameSort] = useState<"asc" | "desc" | null>(null);
  const [showArchivedOnly, setShowArchivedOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [viewEmployee, setViewEmployee] = useState<Employee | null>(null);
  const [editEmployee, setEditEmployee] = useState<Employee | null>(null);
  const [archiveEmployee, setArchiveEmployee] = useState<Employee | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<Employee | null>(null);
  const [notification, setNotification] = useState<NotificationConfig>(null);


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
    if (!initialFocusEmployeeId) return;
    const match = employees.find((employee) => employee.id === initialFocusEmployeeId);
    if (match) {
      setViewEmployee(match);
      onFocusHandled?.();
    }
  }, [initialFocusEmployeeId, employees, onFocusHandled]);

  // While Employee Details is open for someone whose face consent is still
  // pending, silently re-fetch every 5s so "Register Face" enables (and the
  // banner clears) the moment they accept on mobile — no reopening needed.
  const viewConsentPending = Boolean(viewEmployee?.requiresFaceConsent && !viewEmployee.faceConsentAcceptedAt);
  useEffect(() => {
    if (!viewConsentPending) return;
    const interval = window.setInterval(() => {
      employeesCache.refresh().catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(interval);
  }, [viewConsentPending, viewEmployee?.id]);

  useEffect(() => {
    if (!viewEmployee) return;
    const fresh = employees.find((employee) => employee.id === viewEmployee.id);
    if (fresh && fresh.faceConsentAcceptedAt !== viewEmployee.faceConsentAcceptedAt) {
      setViewEmployee((current) => (current && current.id === fresh.id ? { ...current, faceConsentAcceptedAt: fresh.faceConsentAcceptedAt } : current));
    }
  }, [employees]);

  const activeEmployeeCount = employees.filter((employee) => employee.employmentStatus !== "SEPARATED").length;

  // Every active position from Utilities → Positions — never a list kept in
  // this app or inferred from whoever happens to hold a position.
  const { positions: allPositions } = usePositions();
  const positionFilterOptions = allPositions.filter((position) => position.isActive);
  const activePositionFilter = positionFilterOptions.some((position) => position.id === positionFilter)
    ? positionFilter
    : "ALL";

  const visibleEmployees = employees.filter((employee) => {
    if (departmentFilter !== "ALL" && employee.department.name !== departmentFilter) return false;
    if (activePositionFilter !== "ALL" && employee.positionId !== activePositionFilter) return false;
    if (canAssignRoles && roleFilter !== "ALL") {
      const role = activeRoleByEmail.get(employee.user?.email?.toLowerCase() ?? "") ?? null;
      if (roleFilter === "ANY_ROLE" ? !role : role !== roleFilter) return false;
    }
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

  useEffect(() => setPage(1), [departmentFilter, activePositionFilter, roleFilter, showArchivedOnly, searchQuery, nameSort]);
  const pageCount = Math.max(1, Math.ceil(sortedVisibleEmployees.length / EMPLOYEES_PAGE_SIZE));
  const pageSafe = Math.min(page, pageCount);
  const pagedEmployees = sortedVisibleEmployees.slice(
    (pageSafe - 1) * EMPLOYEES_PAGE_SIZE,
    pageSafe * EMPLOYEES_PAGE_SIZE,
  );

  // Spouse links are two-way on the server: saving one spouse also updates
  // the other (Married, linked back) and unlinks any previous partner, so
  // those rows are re-read rather than left stale.
  const refreshIfSpouseLinked = (employee: Employee) => {
    if (employee.spouseEmployeeId || employees.some((item) => item.spouseEmployeeId === employee.id)) {
      employeesCache.refresh().catch(() => undefined);
    }
  };

  const handleEmployeeCreated = (employee: Employee) => {
    employeesCache.setData([employee, ...employees]);
    refreshIfSpouseLinked(employee);
    setIsAddOpen(false);
    if (onEmployeeCreated) {
      onEmployeeCreated(employee);
      return;
    }
    setNotification({ type: "success", title: "Employee Added", message: "Employee was added successfully." });
  };

  const handleEmployeeUpdated = (employee: Employee) => {
    employeesCache.setData(employees.map((item) => (item.id === employee.id ? employee : item)));
    setViewEmployee((current) => (current?.id === employee.id ? employee : current));
    setEditEmployee(null);
    setNotification({ type: "success", title: "Employee Updated", message: "Employee was updated successfully." });
  };

  // Quietly reconciles the optimistic edit with the server's response once
  // the background save actually lands — no re-closing the modal (already
  // closed) and no second toast.
  const handleEmployeeSynced = (employee: Employee) => {
    employeesCache.setData(employees.map((item) => (item.id === employee.id ? employee : item)));
    setViewEmployee((current) => (current?.id === employee.id ? employee : current));
    refreshIfSpouseLinked(employee);
  };

  // A new/changed Supervisor role changes the Supervisor dropdowns, and the
  // System Role section reads the /users list.
  const handleRoleChanged = () => {
    supervisorsCache.refresh().catch(() => undefined);
    revalidateCached("users", () => apiRequest("/users")).catch(() => undefined);
  };

  const handleEmployeeSaveFailed = (message: string) => {
    setNotification({ type: "error", title: "Couldn't Update Employee", message });
    employeesCache.refresh().catch(() => undefined);
  };

  const handleEmployeeArchived = (employee: Employee) => {
    employeesCache.setData(employees.map((item) => (item.id === employee.id ? employee : item)));
    setViewEmployee((current) => (current?.id === employee.id ? employee : current));
    setArchiveEmployee(null);
    setNotification({
      type: "success",
      title: "Employee Archived",
      message: "Employee was archived and their login was deactivated.",
    });
  };

  const handleRestoreEmployee = async (employee: Employee) => {
    try {
      const restored = await apiRequest<Employee>(`/employees/${employee.id}/restore`, { method: "PATCH" });
      employeesCache.setData(employees.map((item) => (item.id === restored.id ? restored : item)));
      setViewEmployee((current) => (current?.id === restored.id ? restored : current));
      setNotification({
        type: "success",
        title: "Employee Restored",
        message: "Employee was restored and their login was reactivated.",
      });
    } catch (err) {
      setNotification({
        type: "error",
        title: "Couldn't Restore Employee",
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
      <NotificationModal notification={notification} onClose={() => setNotification(null)} />

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

        <div className="employees-filter-group">
          <label className="employees-filter-label">Position</label>
          <DropdownFilter
            className="department-select"
            value={activePositionFilter}
            onChange={setPositionFilter}
            options={positionFilterOptions.map((position) => ({ value: position.id, label: position.title }))}
            allLabel="All Positions"
            menuLabel="Filter by position"
            ariaLabel="Filter employees by position"
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

        {canAssignRoles && (
          <div className="employees-filter-group">
            <label className="employees-filter-label">Role</label>
            <DropdownFilter
              className="department-select"
              value={roleFilter}
              onChange={setRoleFilter}
              options={[{ value: "ANY_ROLE", label: "HR Admin & Supervisor" }, ...SYSTEM_ROLE_OPTIONS]}
              allLabel="All Roles"
              hideAllOption
              menuLabel="Filter by role"
              ariaLabel="Filter employees by role"
            />
          </div>
        )}

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

        {/* SEARCH — pushed to the right, sitting just left of Add Employee */}
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
          systemRole={activeRoleByEmail.get(viewEmployee.user?.email?.toLowerCase() ?? "") ?? null}
          attendanceModeOptions={allAttendanceModeOptions}
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
              !registeredFaceEmployeeIds.has(viewEmployee.id) &&
              viewEmployee.employmentStatus !== "SEPARATED",
          )}
          onRegisterFace={onRegisterFace ? () => onRegisterFace(viewEmployee) : undefined}
        />
      )}

      {editEmployee && (
        <EditEmployeeModal
          employee={editEmployee}
          departments={activeDepartments}
          supervisors={supervisors}
          lockedDepartmentName={lockedDepartmentName}
          onClose={() => setEditEmployee(null)}
          onUpdated={(updatedEmployee) => {
            handleEmployeeUpdated(updatedEmployee);
            supervisorsCache.refresh().catch(() => undefined);
          }}
          onSynced={handleEmployeeSynced}
          onSaveFailed={handleEmployeeSaveFailed}
          canAssignRoles={canAssignRoles}
          onRoleChanged={handleRoleChanged}
        />
      )}

      {isAddOpen && (
        <AddEmployeeModal
          departments={activeDepartments}
          supervisors={supervisors}
          lockedDepartmentName={lockedDepartmentName}
          onClose={() => setIsAddOpen(false)}
          onCreated={handleEmployeeCreated}
          onImport={() => {
            setIsAddOpen(false);
            setIsImportOpen(true);
          }}
          canAssignRoles={canAssignRoles}
          onRoleChanged={handleRoleChanged}
        />
      )}

      {isImportOpen && (
        <ImportEmployeesModal
          onClose={() => setIsImportOpen(false)}
          // Imported rows can be spouses/supervisees of existing employees,
          // so the whole list is re-read rather than patched in.
          onImported={() => {
            employeesCache.refresh().catch(() => undefined);
            supervisorsCache.refresh().catch(() => undefined);
          }}
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