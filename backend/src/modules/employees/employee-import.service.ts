import { ConflictException, HttpException, Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { isEmail } from "class-validator";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditLogContext } from "../audit-logs/audit-logs.service";
import { isPositionAvailableIn } from "../positions/positions.service";
import {
  CreateEmployeeDto,
  CreateEmployeeSex,
  EmployeeCivilStatus,
  EmployeeSoloParentStatus,
} from "./dto/create-employee.dto";
import { ImportEmployeeRowDto, MAX_IMPORT_ROWS, MAX_IMPORT_ROWS_PER_REQUEST } from "./dto/import-employees.dto";
import { EmployeesService } from "./employees.service";

export type ImportRowIssue = { field: string; message: string };
export type ImportRowStatus = "VALID" | "INVALID" | "DUPLICATE";
export type ImportEmailStatus = "SENT" | "FAILED" | "PENDING";

type ValidatedRow = {
  rowNumber: number;
  status: ImportRowStatus;
  errors: ImportRowIssue[];
  // What a valid row resolves to, shown in the preview — e.g. which
  // supervisor a blank Supervisor column defaulted to.
  resolved: { supervisor: string | null; attendanceMode: string | null };
  dto?: CreateEmployeeDto;
};

type ImportRowResult = {
  rowNumber: number;
  outcome: "CREATED" | "FAILED" | "SKIPPED";
  errors: ImportRowIssue[];
  employee?: { id: string; employeeNo: string; name: string };
  emailStatus?: ImportEmailStatus;
};

// How long one import request waits for its rows' login emails before
// answering. An email still retrying after this is reported as PENDING — the
// existing bell notification + audit log still flag it if it finally fails.
// Kept short because admin-web sends one employee per request.
const EMAIL_WAIT_MS = 10_000;

// Column names as they appear in the template, used in every error message
// so "Row 3 — Email: …" points at the exact cell to fix.
const FIELD = {
  firstName: "First Name",
  lastName: "Last Name",
  email: "Email",
  sex: "Sex",
  department: "Department",
  position: "Position",
  employeeType: "Employee Type",
  hireDate: "Hire Date",
  supervisor: "Supervisor Employee No",
  civilStatus: "Civil Status",
  spouseEmployment: "Spouse Employment",
  spouseCompany: "Spouse Company",
  spouseEmployeeNo: "Spouse Employee No",
} as const;

const REQUIRED = "This field is required.";

const SEX_VALUES: Record<string, CreateEmployeeSex> = {
  male: CreateEmployeeSex.MALE,
  m: CreateEmployeeSex.MALE,
  female: CreateEmployeeSex.FEMALE,
  f: CreateEmployeeSex.FEMALE,
};

const CIVIL_STATUS_VALUES: Record<string, EmployeeCivilStatus> = {
  single: EmployeeCivilStatus.SINGLE,
  married: EmployeeCivilStatus.MARRIED,
  widowed: EmployeeCivilStatus.WIDOWED,
  separated: EmployeeCivilStatus.SEPARATED,
  annulled: EmployeeCivilStatus.ANNULLED,
};

// Same four mutually exclusive choices as the spouse checkboxes on Add
// Employee (see admin-web's SpouseEmployment).
type SpouseEmployment = "NONE" | "OTHER_COMPANY" | "ULPI" | "UNEMPLOYED";
const SPOUSE_EMPLOYMENT_VALUES: Record<string, SpouseEmployment> = {
  "not provided": "NONE",
  none: "NONE",
  "other company": "OTHER_COMPANY",
  "another company": "OTHER_COMPANY",
  ulpi: "ULPI",
  unemployed: "UNEMPLOYED",
};

// Typed in Supervisor Employee No to leave the employee without a supervisor
// (blank instead picks the department's default, same as Add Employee).
const NO_SUPERVISOR = "none";

// Collapses inner runs of whitespace too, so "Juan  Carlos" can't produce a
// double-spaced name.
function clean(value?: string | null) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function lookupKey(value?: string | null) {
  return clean(value).toLowerCase();
}

function isValidIsoDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function personName(person: { firstName: string; lastName: string }) {
  return `${person.firstName} ${person.lastName}`;
}

// Batch Employee Import. Validates spreadsheet rows against the same rules
// as Add Employee, then creates each valid row through EmployeesService.create
// — so employee numbers, the temporary password + first-login reset, face
// consent, default schedule/geotag, leave balances, audit logging and the
// credentials email all behave exactly as for a single hire. Rows are
// created one at a time (each in its own short transaction), so one bad row
// never rolls back the rest and partial results are reported per row.
@Injectable()
export class EmployeeImportService {
  private readonly logger = new Logger(EmployeeImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly employees: EmployeesService,
  ) {}

  private async loadReference(scopeDepartmentId?: string) {
    const [departments, positions, employeeTypes, supervisors] = await Promise.all([
      this.prisma.department.findMany({
        where: { isActive: true, ...(scopeDepartmentId ? { id: scopeDepartmentId } : {}) },
        select: { id: true, name: true, attendanceMode: true, attendanceModeRef: { select: { label: true } } },
        orderBy: { name: "asc" },
      }),
      this.prisma.position.findMany({
        where: { isActive: true },
        orderBy: [{ createdAt: "asc" }, { title: "asc" }],
        include: { departments: { select: { departmentId: true } } },
      }),
      this.prisma.employeeType.findMany({
        where: { isActive: true },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, employmentStatus: true },
      }),
      // Same list (and order) the Add Employee Supervisor dropdown uses, so
      // a blank cell defaults to the same supervisor the form would preselect.
      this.employees.findSupervisors(scopeDepartmentId),
    ]);

    return {
      departments,
      positions,
      employeeTypes,
      supervisors,
      departmentsByKey: new Map(departments.map((department) => [lookupKey(department.name), department])),
      positionsByKey: new Map(positions.map((position) => [lookupKey(position.title), position])),
      employeeTypesByKey: new Map(employeeTypes.map((type) => [lookupKey(type.name), type])),
      supervisorsByNo: new Map(supervisors.map((supervisor) => [supervisor.employeeNo.toUpperCase(), supervisor])),
      scopedDepartmentName: scopeDepartmentId ? departments[0]?.name : undefined,
    };
  }

  // The accepted values the downloadable template lists — read from the same
  // reference data the validator checks against, so the two never disagree.
  async getReference(scopeDepartmentId?: string) {
    const reference = await this.loadReference(scopeDepartmentId);
    return {
      departments: reference.departments.map((department) => ({
        name: department.name,
        attendanceMode: department.attendanceModeRef?.label ?? department.attendanceMode,
      })),
      positions: reference.departments.flatMap((department) =>
        reference.positions
          .filter((position) => isPositionAvailableIn(position, department.id))
          .map((position) => ({ department: department.name, title: position.title })),
      ),
      employeeTypes: reference.employeeTypes.map(({ name, employmentStatus }) => ({ name, employmentStatus })),
      supervisors: reference.supervisors.map((supervisor) => ({
        employeeNo: supervisor.employeeNo,
        name: personName(supervisor),
        department: supervisor.department.name,
      })),
      limits: { maxRows: MAX_IMPORT_ROWS, maxRowsPerRequest: MAX_IMPORT_ROWS_PER_REQUEST },
    };
  }

  // Dry run — never writes anything. Called for the preview, and again by
  // runImport() so the server never trusts the client's earlier check.
  async validate(rows: ImportEmployeeRowDto[], scopeDepartmentId?: string) {
    const validated = await this.validateRows(rows, scopeDepartmentId);
    return {
      rows: validated.map(({ dto: _dto, ...row }) => row),
      summary: {
        total: validated.length,
        valid: validated.filter((row) => row.status === "VALID").length,
        invalid: validated.filter((row) => row.status === "INVALID").length,
        duplicates: validated.filter((row) => row.status === "DUPLICATE").length,
      },
    };
  }

  private async validateRows(rows: ImportEmployeeRowDto[], scopeDepartmentId?: string): Promise<ValidatedRow[]> {
    const reference = await this.loadReference(scopeDepartmentId);

    // Emails are stored lowercased (CreateEmployeeDto's transform), and
    // create() checks them with an exact match — same rule here.
    const emails = Array.from(new Set(rows.map((row) => lookupKey(row.email)).filter(Boolean)));
    const spouseNumbers = Array.from(
      new Set(rows.map((row) => clean(row.spouseEmployeeNo).toUpperCase()).filter(Boolean)),
    );
    const [existingUsers, spouses] = await Promise.all([
      emails.length > 0
        ? this.prisma.user.findMany({ where: { email: { in: emails } }, select: { email: true } })
        : Promise.resolve([] as { email: string }[]),
      spouseNumbers.length > 0
        ? this.prisma.employee.findMany({
            where: { employeeNo: { in: spouseNumbers } },
            select: { id: true, employeeNo: true, sex: true, employmentStatus: true },
          })
        : Promise.resolve([] as { id: string; employeeNo: string; sex: string | null; employmentStatus: string }[]),
    ]);
    const existingEmails = new Set(existingUsers.map((user) => user.email.toLowerCase()));
    const spousesByNo = new Map(spouses.map((spouse) => [spouse.employeeNo.toUpperCase(), spouse]));
    const firstRowByEmail = new Map<string, number>();

    return rows.map((row) => {
      const errors: ImportRowIssue[] = [];
      const fail = (field: string, message: string) => errors.push({ field, message });
      let isDuplicate = false;

      const firstName = clean(row.firstName);
      const middleName = clean(row.middleName) || null;
      const lastName = clean(row.lastName);
      if (!firstName) fail(FIELD.firstName, REQUIRED);
      if (!lastName) fail(FIELD.lastName, REQUIRED);

      const email = lookupKey(row.email);
      if (!email) {
        fail(FIELD.email, REQUIRED);
      } else if (!isEmail(email)) {
        fail(FIELD.email, "Enter a valid email address.");
      } else if (email.endsWith("@example.com")) {
        // The template's example rows use example.com (reserved, never a
        // real mailbox) — catches an example copied in by mistake.
        fail(FIELD.email, "This is an example address from the template. Replace it with the employee's real email.");
      } else {
        const firstRow = firstRowByEmail.get(email);
        if (firstRow !== undefined) {
          isDuplicate = true;
          fail(FIELD.email, `Same email as employee no. ${firstRow} in this file.`);
        } else {
          firstRowByEmail.set(email, row.rowNumber);
          if (existingEmails.has(email)) {
            isDuplicate = true;
            fail(FIELD.email, "This email address already exists.");
          }
        }
      }

      const sexKey = lookupKey(row.sex);
      const sex = SEX_VALUES[sexKey];
      if (!sexKey) fail(FIELD.sex, REQUIRED);
      else if (!sex) fail(FIELD.sex, 'Use "Male" or "Female".');

      const departmentKey = lookupKey(row.department);
      const department = reference.departmentsByKey.get(departmentKey);
      if (!departmentKey) {
        fail(FIELD.department, REQUIRED);
      } else if (!department) {
        fail(
          FIELD.department,
          reference.scopedDepartmentName
            ? `Department not found. You can only add employees to ${reference.scopedDepartmentName}.`
            : "Department not found.",
        );
      }

      const positionKey = lookupKey(row.position);
      const position = reference.positionsByKey.get(positionKey);
      if (!positionKey) {
        fail(FIELD.position, REQUIRED);
      } else if (!position) {
        fail(FIELD.position, "Position not found.");
      } else if (department && !isPositionAvailableIn(position, department.id)) {
        fail(FIELD.position, `"${position.title}" is not an available position for the ${department.name} department.`);
      }

      const employeeTypeKey = lookupKey(row.employeeType);
      const employeeType = reference.employeeTypesByKey.get(employeeTypeKey);
      if (!employeeTypeKey) fail(FIELD.employeeType, REQUIRED);
      else if (!employeeType) fail(FIELD.employeeType, "Invalid employee type.");

      const hireDate = clean(row.hireDate);
      if (hireDate && !isValidIsoDate(hireDate)) {
        fail(FIELD.hireDate, "Use the YYYY-MM-DD format, e.g. 2026-01-15.");
      }

      // Blank = the department's default supervisor (what Add Employee
      // preselects); "None" = no supervisor; otherwise an active supervisor
      // of the same department, by Employee No.
      const supervisorValue = clean(row.supervisorEmployeeNo);
      let supervisorId: string | undefined;
      let supervisorLabel: string | null = null;
      if (department) {
        if (!supervisorValue) {
          const fallback = reference.supervisors.find((supervisor) => supervisor.department.name === department.name);
          if (fallback) {
            supervisorId = fallback.id;
            supervisorLabel = `${personName(fallback)} (department default)`;
          }
        } else if (supervisorValue.toLowerCase() !== NO_SUPERVISOR) {
          const supervisor = reference.supervisorsByNo.get(supervisorValue.toUpperCase());
          if (!supervisor) {
            fail(FIELD.supervisor, "No active supervisor has this Employee No.");
          } else if (supervisor.department.name !== department.name) {
            fail(FIELD.supervisor, `${personName(supervisor)} belongs to ${supervisor.department.name}, not ${department.name}.`);
          } else {
            supervisorId = supervisor.id;
            supervisorLabel = personName(supervisor);
          }
        }
      }

      const civilStatusKey = lookupKey(row.civilStatus);
      const civilStatus = civilStatusKey ? CIVIL_STATUS_VALUES[civilStatusKey] : EmployeeCivilStatus.SINGLE;
      if (!civilStatus) fail(FIELD.civilStatus, "Use Single, Married, Widowed, Separated, or Annulled.");

      // Same rules as Add Employee's spouse section: only meaningful while
      // Married, and the ULPI spouse must be an active employee of the
      // opposite sex (EmployeesService.resolveSpouseEmployeeId).
      const spouseEmploymentKey = lookupKey(row.spouseEmployment);
      const spouseEmployment = spouseEmploymentKey ? SPOUSE_EMPLOYMENT_VALUES[spouseEmploymentKey] : "NONE";
      const spouseCompany = clean(row.spouseCompany);
      const spouseNo = clean(row.spouseEmployeeNo).toUpperCase();
      let spouseEmployeeId = "";
      if (!spouseEmployment) {
        fail(FIELD.spouseEmployment, "Use Not provided, Other Company, ULPI, or Unemployed.");
      } else if (civilStatus && civilStatus !== EmployeeCivilStatus.MARRIED) {
        if (spouseEmployment !== "NONE" || spouseCompany || spouseNo) {
          fail(FIELD.spouseEmployment, "Spouse details only apply when Civil Status is Married.");
        }
      } else if (civilStatus === EmployeeCivilStatus.MARRIED) {
        if (spouseEmployment === "OTHER_COMPANY" && !spouseCompany) {
          fail(FIELD.spouseCompany, "Required when Spouse Employment is Other Company.");
        } else if (spouseEmployment !== "OTHER_COMPANY" && spouseCompany) {
          fail(FIELD.spouseCompany, "Only used when Spouse Employment is Other Company.");
        }
        if (spouseEmployment === "ULPI") {
          const spouse = spouseNo ? spousesByNo.get(spouseNo) : undefined;
          if (!spouseNo) {
            fail(FIELD.spouseEmployeeNo, "Required when Spouse Employment is ULPI.");
          } else if (!spouse || spouse.employmentStatus === "SEPARATED") {
            fail(FIELD.spouseEmployeeNo, "No active employee has this Employee No.");
          } else if (!spouse.sex || (sex && spouse.sex === sex)) {
            fail(FIELD.spouseEmployeeNo, "The spouse must be an employee of the opposite sex.");
          } else {
            spouseEmployeeId = spouse.id;
          }
        } else if (spouseNo) {
          fail(FIELD.spouseEmployeeNo, "Only used when Spouse Employment is ULPI.");
        }
      }

      const status: ImportRowStatus = isDuplicate ? "DUPLICATE" : errors.length > 0 ? "INVALID" : "VALID";
      const resolved = {
        supervisor: supervisorLabel,
        attendanceMode: department ? (department.attendanceModeRef?.label ?? department.attendanceMode) : null,
      };
      if (status !== "VALID" || !department || !position || !employeeType || !sex || !civilStatus) {
        return { rowNumber: row.rowNumber, status, errors, resolved };
      }

      const isMarried = civilStatus === EmployeeCivilStatus.MARRIED;
      // Exactly the payload Add Employee sends for the same choices.
      const dto = Object.assign(new CreateEmployeeDto(), {
        firstName,
        middleName,
        lastName,
        email,
        department: department.name,
        positionId: position.id,
        employeeTypeId: employeeType.id,
        // A "Both" department starts its hires Non-field, like Add Employee;
        // assigning a field site in Geotagging switches them later.
        attendanceMode: department.attendanceMode === "BOTH" ? "FIXED" : department.attendanceMode,
        sex,
        // Solo Parent eligibility is only set through an admin leave grant.
        soloParentStatus: EmployeeSoloParentStatus.NOT_APPLICABLE,
        civilStatus,
        spouseEmployerName: isMarried && spouseEmployment === "OTHER_COMPANY" ? spouseCompany : "",
        spouseUnemployed: isMarried && spouseEmployment === "UNEMPLOYED",
        spouseEmployeeId,
        ...(hireDate ? { hireDate } : {}),
        ...(supervisorId ? { supervisorId } : {}),
      });
      return { rowNumber: row.rowNumber, status, errors, resolved, dto };
    });
  }

  // Creates the valid rows of one chunk. Safe to retry: a row whose email
  // now exists (created by an earlier attempt) is skipped, never duplicated,
  // and gets no second login email.
  async runImport(rows: ImportEmployeeRowDto[], context: AuditLogContext, scopeDepartmentId?: string) {
    const validated = await this.validateRows(rows, scopeDepartmentId);
    const results: ImportRowResult[] = [];
    const deliveries = new Map<number, Promise<boolean>>();

    for (const row of validated) {
      if (row.status !== "VALID" || !row.dto) {
        results.push({
          rowNumber: row.rowNumber,
          outcome: row.status === "DUPLICATE" ? "SKIPPED" : "FAILED",
          errors: row.errors,
        });
        continue;
      }

      try {
        const created = await this.employees.create(row.dto, context, scopeDepartmentId, {
          onCredentialsEmail: (delivery) => deliveries.set(row.rowNumber, delivery),
        });
        results.push({
          rowNumber: row.rowNumber,
          outcome: "CREATED",
          errors: [],
          employee: {
            id: created.id,
            employeeNo: created.employeeNo,
            name: [created.firstName, created.middleName, created.lastName].filter(Boolean).join(" "),
          },
        });
      } catch (error) {
        const isEmailTaken =
          error instanceof ConflictException ||
          (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002");
        if (isEmailTaken) {
          results.push({
            rowNumber: row.rowNumber,
            outcome: "SKIPPED",
            errors: [{ field: FIELD.email, message: "This email address already exists." }],
          });
          continue;
        }
        // Business-rule rejections carry a message meant for the admin;
        // anything else is logged here and reported generically.
        const message =
          error instanceof HttpException ? error.message : "Unexpected server error while creating this employee.";
        if (!(error instanceof HttpException)) {
          this.logger.error(`[IMPORT] Row ${row.rowNumber} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        results.push({ rowNumber: row.rowNumber, outcome: "FAILED", errors: [{ field: "Row", message }] });
      }
    }

    const emailStatus = await this.settleDeliveries(deliveries);
    for (const result of results) {
      if (result.outcome === "CREATED") result.emailStatus = emailStatus.get(result.rowNumber) ?? "PENDING";
    }
    return { results };
  }

  // Waits (up to EMAIL_WAIT_MS) for this chunk's login emails so each row
  // reports SENT/FAILED; anything still retrying stays PENDING.
  private async settleDeliveries(deliveries: Map<number, Promise<boolean>>) {
    const status = new Map<number, ImportEmailStatus>();
    const tracked = Array.from(deliveries, ([rowNumber, delivery]) => {
      status.set(rowNumber, "PENDING");
      return delivery.then((sent) => {
        status.set(rowNumber, sent ? "SENT" : "FAILED");
      });
    });
    if (tracked.length === 0) return status;

    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(tracked),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, EMAIL_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    return status;
  }
}
