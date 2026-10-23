// Spreadsheet side of Batch Employee Import: the template's columns, reading
// an uploaded .xlsx/.xls/.csv into rows, the instant client-side checks, the
// downloadable template, and the CSV error report. The backend
// (EmployeeImportService) re-validates everything against the database.

export type ImportField =
  | "firstName"
  | "middleName"
  | "lastName"
  | "email"
  | "sex"
  | "department"
  | "position"
  | "employeeType"
  | "hireDate"
  | "supervisorEmployeeNo"
  | "civilStatus"
  | "spouseEmployment"
  | "spouseCompany"
  | "spouseEmployeeNo";

export type ImportRow = { rowNumber: number } & Partial<Record<ImportField, string>>;

export type ImportRowIssue = { field: string; message: string };

export type ImportReference = {
  departments: { name: string; attendanceMode: string }[];
  positions: { department: string; title: string }[];
  employeeTypes: { name: string; employmentStatus: string }[];
  supervisors: { employeeNo: string; name: string; department: string }[];
  limits: { maxRows: number; maxRowsPerRequest: number };
};

type ImportColumn = {
  key: ImportField;
  // Exactly as written in the template's header row.
  header: string;
  // The label used in error messages (matches the backend's).
  label: string;
  required: boolean;
  // Other header spellings accepted on upload (already normalized).
  aliases?: string[];
};

export const IMPORT_COLUMNS: ImportColumn[] = [
  { key: "firstName", header: "First Name", label: "First Name", required: true },
  { key: "middleName", header: "Middle Name (Optional)", label: "Middle Name", required: false },
  { key: "lastName", header: "Last Name", label: "Last Name", required: true },
  { key: "email", header: "Email", label: "Email", required: true, aliases: ["emailaddress"] },
  { key: "sex", header: "Sex", label: "Sex", required: true, aliases: ["sexgender", "gender"] },
  { key: "department", header: "Department", label: "Department", required: true },
  { key: "position", header: "Position", label: "Position", required: true },
  { key: "employeeType", header: "Employee Type", label: "Employee Type", required: true },
  { key: "hireDate", header: "Hire Date (Optional, YYYY-MM-DD)", label: "Hire Date", required: false },
  {
    key: "supervisorEmployeeNo",
    header: "Supervisor Employee No (Optional)",
    label: "Supervisor Employee No",
    required: false,
    aliases: ["supervisor", "supervisorno"],
  },
  { key: "civilStatus", header: "Civil Status (Optional)", label: "Civil Status", required: false },
  { key: "spouseEmployment", header: "Spouse Employment (Optional)", label: "Spouse Employment", required: false },
  { key: "spouseCompany", header: "Spouse Company (Optional)", label: "Spouse Company", required: false },
  { key: "spouseEmployeeNo", header: "Spouse Employee No (Optional)", label: "Spouse Employee No", required: false },
];

export const ACCEPTED_EXTENSIONS = [".xlsx", ".xls", ".csv"];
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
// The sheet the importer reads; the template's Instructions/Lists sheets
// (which hold the example rows) are never imported.
const EMPLOYEES_SHEET = "Employees";
const TEMPLATE_FILE_NAME = "e-TALA Employee Import Template.xlsx";

// "Middle Name (Optional)" / "middle_name" / "MIDDLE NAME *" → "middlename".
function normalizeHeader(value: string) {
  return value
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z0-9]/g, "");
}

const COLUMN_BY_HEADER = new Map<string, ImportField>();
for (const column of IMPORT_COLUMNS) {
  COLUMN_BY_HEADER.set(normalizeHeader(column.header), column.key);
  for (const alias of column.aliases ?? []) COLUMN_BY_HEADER.set(alias, column.key);
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Name parts joined without placeholders, so a blank middle name never
// leaves a double space.
export function formatRowName(row: ImportRow) {
  return [row.firstName, row.middleName, row.lastName]
    .map((part) => (part ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ");
}

export class ImportFileError extends Error {}

export type ParsedImportFile = { rows: ImportRow[]; ignoredColumns: string[] };

// SheetJS is only needed by this flow, so it's loaded on demand rather than
// in the main bundle. The ESM build (what Vite serves) has SSF as a named
// export; the CommonJS build only has it on the default export — take
// whichever shape actually carries it.
type SheetJs = typeof import("xlsx");
async function loadSheetJs(): Promise<SheetJs> {
  const mod = await import("xlsx");
  return mod.SSF ? mod : (mod as unknown as { default: SheetJs }).default;
}

export function checkImportFile(file: File, maxRows?: number): string | null {
  const name = file.name.toLowerCase();
  if (!ACCEPTED_EXTENSIONS.some((extension) => name.endsWith(extension))) {
    return "Unsupported file type. Upload an .xlsx, .xls, or .csv file.";
  }
  if (file.size === 0) return "The file is empty.";
  if (file.size > MAX_FILE_BYTES) {
    return `The file is larger than the ${MAX_FILE_BYTES / (1024 * 1024)} MB limit${
      maxRows ? ` (up to ${maxRows} employees per import)` : ""
    }. Split it into smaller files.`;
  }
  return null;
}

export async function parseImportFile(file: File, maxRows: number): Promise<ParsedImportFile> {
  const problem = checkImportFile(file, maxRows);
  if (problem) throw new ImportFileError(problem);

  const XLSX = await loadSheetJs();
  const isCsv = file.name.toLowerCase().endsWith(".csv");
  let workbook: import("xlsx").WorkBook;
  try {
    // CSV is decoded as UTF-8 text (keeps names like "Ñiño" intact) and kept
    // raw so values like employee numbers and dates stay exactly as typed.
    // Spreadsheets keep each cell's number format so date cells are
    // recognised as dates (cellNF).
    workbook = isCsv
      ? XLSX.read(await file.text(), { type: "string", raw: true })
      : XLSX.read(await file.arrayBuffer(), { type: "array", cellNF: true });
  } catch {
    throw new ImportFileError("The file could not be read. Make sure it is a valid, unprotected .xlsx, .xls, or .csv file.");
  }

  const sheetName = workbook.SheetNames.includes(EMPLOYEES_SHEET) ? EMPLOYEES_SHEET : workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!sheet || !sheet["!ref"]) throw new ImportFileError("The file has no data.");

  const range = XLSX.utils.decode_range(sheet["!ref"]);
  const readCell = (rowIndex: number, columnIndex: number): string => {
    const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
    if (!cell || cell.v === undefined || cell.v === null) return "";
    if (cell.t === "n" && cell.z && XLSX.SSF.is_date(cell.z)) {
      // A real date cell → YYYY-MM-DD from the serial itself (timezone-free),
      // whatever date format the cell displays.
      const parts = XLSX.SSF.parse_date_code(cell.v as number);
      if (parts) return `${parts.y}-${String(parts.m).padStart(2, "0")}-${String(parts.d).padStart(2, "0")}`;
    }
    if (cell.t === "n" && typeof cell.w === "string") return cell.w.trim();
    return String(cell.v).trim();
  };

  // The header is the first non-empty row (a title row above it is fine).
  let headerRowIndex = -1;
  for (let r = range.s.r; r <= range.e.r && headerRowIndex < 0; r += 1) {
    for (let c = range.s.c; c <= range.e.c; c += 1) {
      if (readCell(r, c)) {
        headerRowIndex = r;
        break;
      }
    }
  }
  if (headerRowIndex < 0) throw new ImportFileError("The file has no data.");

  const columnFields = new Map<number, ImportField>();
  const ignoredColumns: string[] = [];
  for (let c = range.s.c; c <= range.e.c; c += 1) {
    const header = readCell(headerRowIndex, c);
    if (!header) continue;
    const field = COLUMN_BY_HEADER.get(normalizeHeader(header));
    if (field && !Array.from(columnFields.values()).includes(field)) columnFields.set(c, field);
    else ignoredColumns.push(header);
  }

  const presentFields = new Set(columnFields.values());
  const missing = IMPORT_COLUMNS.filter((column) => column.required && !presentFields.has(column.key));
  if (missing.length > 0) {
    throw new ImportFileError(
      `The file is missing required column${missing.length === 1 ? "" : "s"}: ${missing
        .map((column) => column.header)
        .join(", ")}. Download the template to get the correct header row.`,
    );
  }

  const rows: ImportRow[] = [];
  for (let r = headerRowIndex + 1; r <= range.e.r; r += 1) {
    // Numbered by employee (1, 2, 3…), not by spreadsheet row — the
    // heading row and blank rows aren't counted.
    const row: ImportRow = { rowNumber: rows.length + 1 };
    let hasValue = false;
    for (const [c, field] of columnFields) {
      const value = readCell(r, c);
      if (value) {
        row[field] = value;
        hasValue = true;
      }
    }
    if (hasValue) rows.push(row);
  }

  if (rows.length === 0) throw new ImportFileError("The file has a header row but no employee rows.");
  if (rows.length > maxRows) {
    throw new ImportFileError(`The file has ${rows.length} employee rows. The limit is ${maxRows} per import — split it into smaller files.`);
  }
  return { rows, ignoredColumns };
}

// Instant checks that need no database (the server repeats them and adds the
// rest). Same messages as the backend so merged lists don't repeat.
export function validateRowsLocally(rows: ImportRow[]) {
  const issues = new Map<number, ImportRowIssue[]>();
  const firstRowByEmail = new Map<string, number>();
  for (const row of rows) {
    const rowIssues: ImportRowIssue[] = [];
    for (const column of IMPORT_COLUMNS) {
      if (column.required && !row[column.key]?.trim()) {
        rowIssues.push({ field: column.label, message: "This field is required." });
      }
    }
    const email = row.email?.trim().toLowerCase();
    if (email) {
      if (!/^\S+@\S+\.\S+$/.test(email)) {
        rowIssues.push({ field: "Email", message: "Enter a valid email address." });
      } else {
        const firstRow = firstRowByEmail.get(email);
        if (firstRow !== undefined) rowIssues.push({ field: "Email", message: `Same email as employee no. ${firstRow} in this file.` });
        else firstRowByEmail.set(email, row.rowNumber);
      }
    }
    issues.set(row.rowNumber, rowIssues);
  }
  return issues;
}

export function mergeIssues(...lists: (ImportRowIssue[] | undefined)[]) {
  const seen = new Set<string>();
  const merged: ImportRowIssue[] = [];
  for (const issue of lists.flat()) {
    if (!issue) continue;
    const key = `${issue.field}|${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(issue);
  }
  return merged;
}

// ── Template ────────────────────────────────────────────────────────────────

export async function downloadImportTemplate(reference: ImportReference) {
  const XLSX = await loadSheetJs();
  const workbook = XLSX.utils.book_new();

  // 1. Employees — the only sheet that's imported: header row, no data.
  const employeesSheet = XLSX.utils.aoa_to_sheet([IMPORT_COLUMNS.map((column) => column.header)]);
  employeesSheet["!cols"] = IMPORT_COLUMNS.map((column) => ({ wch: Math.max(16, column.header.length + 2) }));
  XLSX.utils.book_append_sheet(workbook, employeesSheet, EMPLOYEES_SHEET);

  // 2. Instructions — column rules, plus the example rows (here, never on
  // the Employees sheet, so they can't be imported by accident).
  const exampleDepartment = reference.departments[0]?.name ?? "";
  const examplePosition = reference.positions.find((p) => p.department === exampleDepartment)?.title ?? "";
  const exampleType = reference.employeeTypes[0]?.name ?? "";
  const instructions: (string | number)[][] = [
    ["e-TALA Batch Employee Import — Instructions"],
    [],
    ["How to use"],
    ["1. Enter one employee per row on the \"Employees\" sheet, starting on row 2. Keep the header row as it is."],
    ["2. Use the exact names listed on the \"Lists\" sheet for Department, Position, Employee Type and Supervisor Employee No."],
    ["3. Save the file and upload it from Employee Management → Add Employee → Import Employees."],
    [`4. Up to ${reference.limits.maxRows} employees and ${MAX_FILE_BYTES / (1024 * 1024)} MB per file. .xlsx, .xls and .csv (same header row) are accepted.`],
    ["5. Every row is checked before anything is saved. Rows with errors are listed and skipped; you can fix them and import again."],
    [],
    ["Columns", "Required?", "Accepted values / notes"],
    ["First Name", "Required", "Employee's given name."],
    ["Middle Name (Optional)", "Optional", "Leave blank if the employee has none — do not type N/A or a dash."],
    ["Last Name", "Required", "Employee's surname."],
    ["Email", "Required", "Must be unique — not used by any existing account or another row. The employee's login email with a temporary password is sent here."],
    ["Sex", "Required", "Male or Female."],
    ["Department", "Required", "An active department (see Lists). Attendance Mode follows the department automatically."],
    ["Position", "Required", "A position offered in that department (see Lists → Positions by Department)."],
    ["Employee Type", "Required", "An active employee type (see Lists). Paternity/Maternity leave is allocated from Leave Types automatically when the type is entitled."],
    ["Hire Date (Optional, YYYY-MM-DD)", "Optional", "Format YYYY-MM-DD, e.g. 2026-01-15 (Excel date cells are also accepted). Blank = today."],
    ["Supervisor Employee No (Optional)", "Optional", "Employee No of an active supervisor in the same department. Blank = the department's default supervisor (same as Add Employee). Type None for no supervisor."],
    ["Civil Status (Optional)", "Optional", "Single, Married, Widowed, Separated, or Annulled. Blank = Single."],
    ["Spouse Employment (Optional)", "Optional", "Only when Married: Not provided, Other Company, ULPI, or Unemployed. Blank = Not provided."],
    ["Spouse Company (Optional)", "Optional", "Required when Spouse Employment is Other Company."],
    ["Spouse Employee No (Optional)", "Optional", "Required when Spouse Employment is ULPI — an active employee of the opposite sex."],
    [],
    ["Not set by import"],
    ["• No passwords: each employee gets a temporary password by email and sets their own on first login."],
    ["• No face data: each employee accepts the face-data consent on first login, then their face is registered in Face Registration."],
    ["• Additional Leave Types (admin grants) and Solo Parent eligibility are granted afterward from Edit Employee."],
    [],
    ["EXAMPLES — for reference only. Do not copy these into the Employees sheet (example.com addresses are rejected)."],
    IMPORT_COLUMNS.map((column) => column.header),
    ["EXAMPLE Juan", "Santos", "Dela Cruz", "juan.delacruz@example.com", "Male", exampleDepartment, examplePosition, exampleType, "2026-01-15", "", "Married", "Other Company", "ABC Trading", ""],
    ["EXAMPLE Maria", "", "Reyes", "maria.reyes@example.com", "Female", exampleDepartment, examplePosition, exampleType, "", "None", "Single", "", "", ""],
  ];
  const instructionsSheet = XLSX.utils.aoa_to_sheet(instructions);
  instructionsSheet["!cols"] = [{ wch: 36 }, { wch: 14 }, { wch: 110 }];
  XLSX.utils.book_append_sheet(workbook, instructionsSheet, "Instructions");

  // 3. Lists — the accepted values, side by side.
  const blocks: (string | number)[][][] = [
    [["Department", "Attendance Mode"], ...reference.departments.map((d) => [d.name, d.attendanceMode])],
    [["Positions by Department", ""], ["Department", "Position"], ...reference.positions.map((p) => [p.department, p.title])],
    [["Employee Type"], ...reference.employeeTypes.map((t) => [t.name])],
    [["Supervisor Employee No", "Name", "Department"], ...reference.supervisors.map((s) => [s.employeeNo, s.name, s.department])],
    [["Sex"], ["Male"], ["Female"]],
    [["Civil Status"], ["Single"], ["Married"], ["Widowed"], ["Separated"], ["Annulled"]],
    [["Spouse Employment"], ["Not provided"], ["Other Company"], ["ULPI"], ["Unemployed"]],
  ];
  const lists: (string | number)[][] = [];
  const columnWidths: { wch: number }[] = [];
  let columnOffset = 0;
  for (const block of blocks) {
    const width = Math.max(...block.map((row) => row.length));
    block.forEach((row, rowIndex) => {
      lists[rowIndex] ??= [];
      for (let c = 0; c < width; c += 1) lists[rowIndex][columnOffset + c] = row[c] ?? "";
    });
    for (let c = 0; c < width; c += 1) columnWidths[columnOffset + c] = { wch: 24 };
    columnWidths[columnOffset + width] = { wch: 3 };
    columnOffset += width + 1;
  }
  const height = lists.length;
  for (let r = 0; r < height; r += 1) {
    lists[r] ??= [];
    for (let c = 0; c < columnOffset; c += 1) lists[r][c] ??= "";
  }
  const listsSheet = XLSX.utils.aoa_to_sheet(lists);
  listsSheet["!cols"] = columnWidths;
  XLSX.utils.book_append_sheet(workbook, listsSheet, "Lists");

  XLSX.writeFile(workbook, TEMPLATE_FILE_NAME);
}

// ── Error report ────────────────────────────────────────────────────────────

// Neutralises spreadsheet formula injection: a cell starting with = + - @
// (or a tab/CR) is prefixed with ' so Excel shows it as text instead of
// running it. Then standard CSV quoting.
function csvCell(value: string | number) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function downloadErrorReport(lines: { row: number; name: string; email: string; outcome: string; field: string; message: string }[]) {
  const header = ["No.", "Name", "Email", "Result", "Field", "Problem"];
  const body = lines.map((line) => [line.row, line.name, line.email, line.outcome, line.field, line.message]);
  // BOM so Excel opens it as UTF-8 (names with ñ etc.).
  const csv = "﻿" + [header, ...body].map((cells) => cells.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  link.href = url;
  link.download = `employee-import-errors-${stamp}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
