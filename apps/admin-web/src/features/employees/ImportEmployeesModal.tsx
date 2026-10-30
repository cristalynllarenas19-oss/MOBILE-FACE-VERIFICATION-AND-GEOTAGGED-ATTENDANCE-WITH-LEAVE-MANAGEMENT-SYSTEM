import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Copy,
  Download,
  FileSpreadsheet,
  Loader2,
  MailWarning,
  Upload,
  X,
  XCircle,
} from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { apiRequest, SessionExpiredError } from "../../lib/api";
import {
  ACCEPTED_EXTENSIONS,
  checkImportFile,
  downloadErrorReport,
  downloadImportTemplate,
  formatFileSize,
  formatRowName,
  ImportFileError,
  mergeIssues,
  parseImportFile,
  validateRowsLocally,
  type ImportReference,
  type ImportRow,
  type ImportRowIssue,
} from "./employeeImport";
import "./ImportEmployeesModal.css";

type RowStatus = "VALID" | "INVALID" | "DUPLICATE";

type CheckedRow = {
  row: ImportRow;
  status: RowStatus;
  errors: ImportRowIssue[];
  resolved: { supervisor: string | null; attendanceMode: string | null };
};

type ValidateResponse = {
  rows: { rowNumber: number; status: RowStatus; errors: ImportRowIssue[]; resolved: CheckedRow["resolved"] }[];
};

type EmailStatus = "SENT" | "FAILED" | "PENDING";

type ImportResult = {
  rowNumber: number;
  outcome: "CREATED" | "FAILED" | "SKIPPED";
  errors: ImportRowIssue[];
  employee?: { id: string; employeeNo: string; name: string };
  emailStatus?: EmailStatus;
};

// Three steps: pick the file, check the rows (and import from there), see
// the results. "importing" is the Review step while rows are being added.
type Step = "upload" | "preview" | "importing" | "results";

const STEPS: { id: Exclude<Step, "importing">; label: string }[] = [
  { id: "upload", label: "Upload" },
  { id: "preview", label: "Review" },
  { id: "results", label: "Done" },
];

// Used until the server's own limits load (GET /employees/import/reference).
const DEFAULT_LIMITS = { maxRows: 500, maxRowsPerRequest: 25 };
// Rows per POST /employees/import. One at a time, so the "Adding employees…
// 3 of 10" counter and progress bar move after every employee (with a batch,
// they sat at 0 until the whole batch was done).
const IMPORT_CHUNK_SIZE = 1;

type PreviewFilter = "ALL" | RowStatus;

const STATUS_LABEL: Record<RowStatus, string> = { VALID: "Ready", INVALID: "Invalid", DUPLICATE: "Duplicate" };
// Shown when a summary box is clicked and nothing falls in that group.
const EMPTY_GROUP_MESSAGE: Record<PreviewFilter, string> = {
  ALL: "No employees in this file.",
  VALID: "No employees are ready yet. Fix the ones marked Invalid or Duplicate, then upload the file again.",
  INVALID: "No errors. Every employee is filled in correctly.",
  DUPLICATE: "No duplicates. Every email is new.",
};

const STATUS_TONE: Record<RowStatus, "success" | "danger" | "warning"> = {
  VALID: "success",
  INVALID: "danger",
  DUPLICATE: "warning",
};

function IssueList({ issues }: { issues: ImportRowIssue[] }) {
  // Spelled out instead of a bare dash, which read as "missing" rather
  // than "nothing wrong".
  if (issues.length === 0) {
    return (
      <span className="import-no-issues">
        <CheckCircle2 size={13} /> No issues
      </span>
    );
  }
  return (
    <ul className="import-issues">
      {issues.map((issue) => (
        <li key={`${issue.field}|${issue.message}`}>
          <strong>{issue.field}:</strong> {issue.message}
        </li>
      ))}
    </ul>
  );
}

export function ImportEmployeesModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  // Called once rows were created, so Employee Management refreshes its list
  // behind the modal without a page reload.
  onImported: () => void;
}) {
  const [step, setStep] = useState<Step>("upload");
  const [reference, setReference] = useState<ImportReference | null>(null);
  const [referenceError, setReferenceError] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [isDownloadingTemplate, setIsDownloadingTemplate] = useState(false);
  const [checkedRows, setCheckedRows] = useState<CheckedRow[]>([]);
  const [ignoredColumns, setIgnoredColumns] = useState<string[]>([]);
  const [previewFilter, setPreviewFilter] = useState<PreviewFilter>("ALL");
  const [results, setResults] = useState<ImportResult[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0, current: "" });
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards against a double click starting the import twice before the
  // first click's state update disables the button.
  const importStartedRef = useRef(false);

  const limits = reference?.limits ?? DEFAULT_LIMITS;

  useEffect(() => {
    let cancelled = false;
    apiRequest<ImportReference>("/employees/import/reference")
      .then((data) => {
        if (!cancelled) setReference(data);
      })
      .catch((error) => {
        if (!cancelled) setReferenceError(error instanceof Error ? error.message : "Could not load the import settings.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rowsByNumber = useMemo(() => new Map(checkedRows.map((checked) => [checked.row.rowNumber, checked.row])), [checkedRows]);
  const counts = useMemo(
    () => ({
      total: checkedRows.length,
      valid: checkedRows.filter((row) => row.status === "VALID").length,
      invalid: checkedRows.filter((row) => row.status === "INVALID").length,
      duplicates: checkedRows.filter((row) => row.status === "DUPLICATE").length,
    }),
    [checkedRows],
  );
  const visibleRows = previewFilter === "ALL" ? checkedRows : checkedRows.filter((row) => row.status === previewFilter);

  const resultCounts = useMemo(
    () => ({
      created: results.filter((r) => r.outcome === "CREATED").length,
      failed: results.filter((r) => r.outcome === "FAILED").length,
      skipped: results.filter((r) => r.outcome === "SKIPPED").length,
      emailFailed: results.filter((r) => r.emailStatus === "FAILED").length,
      emailPending: results.filter((r) => r.emailStatus === "PENDING").length,
    }),
    [results],
  );
  const problemResults = results.filter(
    (r) => r.outcome !== "CREATED" || r.emailStatus === "FAILED" || r.emailStatus === "PENDING",
  );

  const isBusy = isChecking || step === "importing";

  function selectFile(next: File | null) {
    setFileError("");
    if (!next) {
      setFile(null);
      return;
    }
    const problem = checkImportFile(next, limits.maxRows);
    if (problem) {
      setFile(null);
      setFileError(problem);
      return;
    }
    setFile(next);
  }

  function resetToUpload() {
    setStep("upload");
    setFile(null);
    setFileError("");
    setCheckedRows([]);
    setIgnoredColumns([]);
    setPreviewFilter("ALL");
    if (inputRef.current) inputRef.current.value = "";
  }

  async function handleDownloadTemplate() {
    if (!reference) return;
    setIsDownloadingTemplate(true);
    try {
      await downloadImportTemplate(reference);
    } catch {
      setFileError("The template could not be generated. Please try again.");
    } finally {
      setIsDownloadingTemplate(false);
    }
  }

  async function handleCheckFile() {
    if (!file) return;
    setIsChecking(true);
    setFileError("");
    try {
      const parsed = await parseImportFile(file, limits.maxRows);
      const localIssues = validateRowsLocally(parsed.rows);
      // Authoritative check (departments, positions, existing emails, …) —
      // a dry run, nothing is saved.
      const server = await apiRequest<ValidateResponse>("/employees/import/validate", {
        method: "POST",
        body: JSON.stringify({ rows: parsed.rows }),
      });
      const serverByRow = new Map(server.rows.map((row) => [row.rowNumber, row]));
      setCheckedRows(
        parsed.rows.map((row) => {
          const serverRow = serverByRow.get(row.rowNumber);
          const errors = mergeIssues(localIssues.get(row.rowNumber), serverRow?.errors);
          const status: RowStatus =
            serverRow?.status === "DUPLICATE" ? "DUPLICATE" : errors.length > 0 || !serverRow ? "INVALID" : "VALID";
          return {
            row,
            status,
            errors: !serverRow && errors.length === 0 ? [{ field: "Row", message: "Could not be checked." }] : errors,
            resolved: serverRow?.resolved ?? { supervisor: null, attendanceMode: null },
          };
        }),
      );
      setIgnoredColumns(parsed.ignoredColumns);
      setPreviewFilter("ALL");
      setStep("preview");
    } catch (error) {
      if (error instanceof SessionExpiredError) return;
      setFileError(
        error instanceof ImportFileError
          ? error.message
          : `The file could not be checked: ${error instanceof Error ? error.message : "unknown error"}.`,
      );
    } finally {
      setIsChecking(false);
    }
  }

  async function handleImport() {
    if (importStartedRef.current) return;
    importStartedRef.current = true;

    const validRows = checkedRows.filter((row) => row.status === "VALID").map((row) => row.row);
    // Invalid/duplicate rows were never sent; they're reported alongside.
    const skippedUpfront: ImportResult[] = checkedRows
      .filter((row) => row.status !== "VALID")
      .map((row) => ({
        rowNumber: row.row.rowNumber,
        outcome: row.status === "DUPLICATE" ? "SKIPPED" : "FAILED",
        errors: row.errors,
      }));

    setStep("importing");
    setProgress({ done: 0, total: validRows.length, current: "" });
    const collected: ImportResult[] = [];
    const chunkSize = Math.min(IMPORT_CHUNK_SIZE, limits.maxRowsPerRequest);

    for (let start = 0; start < validRows.length; start += chunkSize) {
      const chunk = validRows.slice(start, start + chunkSize);
      // Name the employee being added right now.
      setProgress((current) => ({ ...current, current: formatRowName(chunk[0]) }));
      try {
        const response = await apiRequest<{ results: ImportResult[] }>("/employees/import", {
          method: "POST",
          body: JSON.stringify({ rows: chunk }),
        });
        collected.push(...response.results);
      } catch (error) {
        if (error instanceof SessionExpiredError) return;
        const reason = error instanceof Error ? error.message : "unknown error";
        collected.push(
          ...chunk.map((row) => ({
            rowNumber: row.rowNumber,
            outcome: "FAILED" as const,
            errors: [
              {
                field: "Row",
                message: `The server could not be reached (${reason}). This employee may or may not have been created — check Employee Management. Importing the same file again is safe: existing emails are skipped.`,
              },
            ],
          })),
        );
      }
      setProgress((current) => ({ ...current, done: Math.min(start + chunk.length, validRows.length) }));
    }

    const all = [...collected, ...skippedUpfront].sort((a, b) => a.rowNumber - b.rowNumber);
    setResults(all);
    setStep("results");
    if (all.some((result) => result.outcome === "CREATED")) onImported();
  }

  function handleDownloadErrorReport() {
    const lines = problemResults.flatMap((result) => {
      const row = rowsByNumber.get(result.rowNumber);
      const base = {
        row: result.rowNumber,
        name: row ? formatRowName(row) : result.employee?.name ?? "",
        email: row?.email ?? "",
        outcome:
          result.outcome === "CREATED" ? "Created" : result.outcome === "SKIPPED" ? "Skipped (duplicate)" : "Not imported",
      };
      const issues: ImportRowIssue[] = [...result.errors];
      if (result.emailStatus === "FAILED") {
        issues.push({ field: "Login email", message: "The employee was created but the login email could not be sent. They can set a password with Forgot Password on the login screen." });
      } else if (result.emailStatus === "PENDING") {
        issues.push({ field: "Login email", message: "Still sending when the import finished. If it fails, you'll get a bell notification." });
      }
      return issues.map((issue) => ({ ...base, field: issue.field, message: issue.message }));
    });
    downloadErrorReport(lines);
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setIsDragging(false);
    if (isBusy) return;
    selectFile(event.dataTransfer.files?.[0] ?? null);
  }

  const activeStepIndex = STEPS.findIndex((item) => item.id === (step === "importing" ? "preview" : step));

  return (
    <div className="employee-modal-backdrop" role="presentation">
      <section className="employee-modal import-modal" role="dialog" aria-modal="true" aria-labelledby="import-modal-title">
        <div className="employee-modal-header">
          <div>
            <h2 id="import-modal-title">Import Employees</h2>
            <p>Register multiple employees at once from one spreadsheet.</p>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            disabled={step === "importing"}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <ol className="import-stepper" aria-label="Import progress">
          {STEPS.map((item, index) => (
            <li
              key={item.id}
              className={`import-step${index === activeStepIndex ? " active" : ""}${index < activeStepIndex ? " done" : ""}`}
              aria-current={index === activeStepIndex ? "step" : undefined}
            >
              <span className="import-step-number">{index < activeStepIndex ? <Check size={15} strokeWidth={3} /> : index + 1}</span>
              <span className="import-step-label">{item.label}</span>
            </li>
          ))}
        </ol>

        <div className="import-body">
          {step === "upload" && (
            <>
              {/* Get the template. Icons, not numbers, so these don't clash
                  with the numbered step bar above. */}
              <div className="import-upload-step">
                <span className="import-upload-step-icon">
                  <FileSpreadsheet size={15} />
                </span>
                <div className="import-upload-step-text">
                  <strong>Download the template</strong>
                  <span>Fill in one employee per row on the "Employees" sheet.</span>
                </div>
                <button
                  type="button"
                  className="outline-button import-template-button"
                  onClick={handleDownloadTemplate}
                  disabled={!reference || isDownloadingTemplate}
                >
                  {isDownloadingTemplate ? <Loader2 size={14} className="import-spin" /> : <Download size={14} />}
                  Download Template
                </button>
              </div>
              {referenceError && <p className="employee-form-error">Could not load the template data: {referenceError}</p>}

              {/* Upload the filled file. */}
              <div className="import-upload-step">
                <span className="import-upload-step-icon">
                  <Upload size={15} />
                </span>
                <div className="import-upload-step-text">
                  <strong>Upload the filled file</strong>
                  <span>
                    Excel (.xlsx, .xls) or CSV
                  </span>
                </div>
              </div>

              {file ? (
                <div className="import-file-card">
                  <FileSpreadsheet size={22} />
                  <div className="import-file-meta">
                    <strong title={file.name}>{file.name}</strong>
                    <span>{formatFileSize(file.size)}</span>
                  </div>
                  <button type="button" className="outline-button" onClick={() => inputRef.current?.click()} disabled={isChecking}>
                    Change File
                  </button>
                  <button
                    type="button"
                    className="icon-button import-file-remove"
                    onClick={() => selectFile(null)}
                    disabled={isChecking}
                    aria-label="Remove file"
                  >
                    <X size={16} />
                  </button>
                </div>
              ) : (
                // A real button that opens the file picker itself — the old
                // <label> wasn't tied to the hidden input, so clicking it
                // did nothing.
                <button
                  type="button"
                  className={`import-dropzone${isDragging ? " dragging" : ""}`}
                  onClick={() => inputRef.current?.click()}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setIsDragging(true);
                  }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={handleDrop}
                >
                  <Upload size={26} />
                  <strong>Click to choose a file</strong>
                  <span>or drag and drop it here</span>
                </button>
              )}
              <input
                ref={inputRef}
                type="file"
                accept={ACCEPTED_EXTENSIONS.join(",")}
                className="import-file-input"
                onChange={(event) => {
                  selectFile(event.target.files?.[0] ?? null);
                  // Lets the same file be picked again after Remove.
                  event.target.value = "";
                }}
              />

              {fileError && <p className="employee-form-error">{fileError}</p>}

              <div className="employee-form-actions">
                <button type="button" className="outline-button" onClick={onClose} disabled={isChecking}>
                  Cancel
                </button>
                <button type="button" className="primary-button" onClick={handleCheckFile} disabled={!file || isChecking}>
                  {isChecking ? <Loader2 size={14} className="import-spin" /> : null}
                  {isChecking ? "Checking..." : "Check File"}
                </button>
              </div>
            </>
          )}

          {(step === "preview" || step === "importing") && (
            <>
              <div className="import-summary">
                <button type="button" className={`import-chip${previewFilter === "ALL" ? " active" : ""}`} onClick={() => setPreviewFilter("ALL")}>
                  <span>Total rows</span>
                  <strong>{counts.total}</strong>
                </button>
                <button type="button" className={`import-chip valid${previewFilter === "VALID" ? " active" : ""}`} onClick={() => setPreviewFilter("VALID")}>
                  <span>Ready to import</span>
                  <strong>{counts.valid}</strong>
                </button>
                <button type="button" className={`import-chip invalid${previewFilter === "INVALID" ? " active" : ""}`} onClick={() => setPreviewFilter("INVALID")}>
                  <span>Invalid</span>
                  <strong>{counts.invalid}</strong>
                </button>
                <button type="button" className={`import-chip duplicate${previewFilter === "DUPLICATE" ? " active" : ""}`} onClick={() => setPreviewFilter("DUPLICATE")}>
                  <span>Duplicates</span>
                  <strong>{counts.duplicates}</strong>
                </button>
              </div>

              {ignoredColumns.length > 0 && (
                <p className="import-note">
                  <AlertTriangle size={14} /> These columns aren't part of the template and were ignored: {ignoredColumns.join(", ")}.
                </p>
              )}
              {counts.invalid + counts.duplicates > 0 && (
                <p className="import-note">
                  <AlertTriangle size={14} />
                  {counts.valid === 0
                    ? "Nothing to import. Fix the rows below in your file, then upload it again."
                    : `Invalid and Duplicate rows will be skipped. ${counts.valid} employee${counts.valid === 1 ? "" : "s"} will be imported.`}
                </p>
              )}

              <div className="import-table-scroll">
                {/* Five columns, sized to fit the modal (no sideways
                    scrolling). Status is last and carries any problems
                    under its badge, so there's no separate Issues column. */}
                <table className="import-table import-table--preview">
                  <colgroup>
                    <col className="import-col-row" />
                    <col className="import-col-employee" />
                    <col className="import-col-assignment" />
                    <col className="import-col-type" />
                    <col className="import-col-status" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>No.</th>
                      <th>Employee</th>
                      <th>Department / Position</th>
                      <th>Employee Type</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="import-empty">{EMPTY_GROUP_MESSAGE[previewFilter]}</td>
                      </tr>
                    ) : (
                      visibleRows.map(({ row, status, errors, resolved }) => (
                        <tr key={row.rowNumber} className={status !== "VALID" ? "has-issues" : undefined}>
                          <td data-label="No.">{row.rowNumber}</td>
                          <td data-label="Employee">
                            <div className="import-cell-stack">
                              <strong>{formatRowName(row) || "—"}</strong>
                              <span>{row.email || "No email"}</span>
                            </div>
                          </td>
                          <td data-label="Department">
                            <div className="import-cell-stack">
                              <strong>{row.department || "—"}</strong>
                              <span>{row.position || "No position"}</span>
                            </div>
                          </td>
                          <td data-label="Employee Type">
                            <div className="import-cell-stack">
                              <strong>{row.employeeType || "—"}</strong>
                              {resolved.supervisor && <span>Supervisor: {resolved.supervisor}</span>}
                            </div>
                          </td>
                          <td data-label="Status">
                            <div className="import-status-cell">
                              <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
                              {errors.length > 0 && <IssueList issues={errors} />}
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* Replaces the old separate Confirm step: what clicking Import
                  does, then live progress once it's running. */}
              {step === "importing" ? (
                <div className="import-progress" role="status" aria-live="polite">
                  <div className="import-progress-label">
                    <Loader2 size={14} className="import-spin" />
                    Adding employees… {progress.done} of {progress.total}
                  </div>
                  <div className="import-progress-track">
                    <div
                      className="import-progress-bar"
                      style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
                    />
                  </div>
                  <span className="import-muted">
                    {progress.current ? `Now adding: ${progress.current}. ` : ""}Keep this window open until it finishes.
                  </span>
                </div>
              ) : (
                counts.valid > 0 && (
                  <p className="import-info">
                    Clicking <strong>Import</strong> adds the {counts.valid} Ready employee{counts.valid === 1 ? "" : "s"}. Each
                    one gets a login email with a temporary password.
                  </p>
                )
              )}

              <div className="employee-form-actions">
                <button
                  type="button"
                  className="outline-button import-left-action"
                  onClick={resetToUpload}
                  disabled={step === "importing"}
                >
                  <ArrowLeft size={14} /> Upload a Different File
                </button>
                <button type="button" className="outline-button" onClick={onClose} disabled={step === "importing"}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={handleImport}
                  disabled={counts.valid === 0 || step === "importing"}
                >
                  {step === "importing" ? "Importing..." : `Import ${counts.valid} Employee${counts.valid === 1 ? "" : "s"}`}
                </button>
              </div>
            </>
          )}

          {step === "results" && (
            <>
              <div className="import-results-grid">
                <div className="import-result-card created">
                  <CheckCircle2 size={18} />
                  <strong>{resultCounts.created}</strong>
                  <span>Created</span>
                </div>
                <div className="import-result-card failed">
                  <XCircle size={18} />
                  <strong>{resultCounts.failed}</strong>
                  <span>Not imported</span>
                </div>
                <div className="import-result-card skipped">
                  <Copy size={18} />
                  <strong>{resultCounts.skipped}</strong>
                  <span>Skipped duplicates</span>
                </div>
                <div className="import-result-card email">
                  <MailWarning size={18} />
                  <strong>{resultCounts.emailFailed}</strong>
                  <span>Login emails not sent</span>
                </div>
              </div>
              {resultCounts.emailPending > 0 && (
                <p className="import-note">
                  <AlertTriangle size={14} /> {resultCounts.emailPending} login email{resultCounts.emailPending === 1 ? " was" : "s were"} still
                  sending when the import finished. If any fails, you'll get a bell notification.
                </p>
              )}

              {problemResults.length > 0 ? (
                <div className="import-table-scroll">
                  <table className="import-table">
                    <thead>
                      <tr>
                        <th>No.</th>
                        <th>Name</th>
                        <th>Result</th>
                        <th>Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {problemResults.map((result) => {
                        const row = rowsByNumber.get(result.rowNumber);
                        const emailIssue: ImportRowIssue[] =
                          result.emailStatus === "FAILED"
                            ? [{ field: "Login email", message: "Not sent. They can set a password with Forgot Password on the login screen." }]
                            : result.emailStatus === "PENDING"
                              ? [{ field: "Login email", message: "Still sending." }]
                              : [];
                        return (
                          <tr key={result.rowNumber}>
                            <td data-label="No.">{result.rowNumber}</td>
                            <td data-label="Name">
                              {result.employee ? `${result.employee.name} (${result.employee.employeeNo})` : row ? formatRowName(row) : "—"}
                            </td>
                            <td data-label="Result">
                              {result.outcome === "CREATED" ? (
                                <Badge tone="success">Created</Badge>
                              ) : result.outcome === "SKIPPED" ? (
                                <Badge tone="warning">Skipped</Badge>
                              ) : (
                                <Badge tone="danger">Not imported</Badge>
                              )}
                            </td>
                            <td data-label="Details">
                              <IssueList issues={[...result.errors, ...emailIssue]} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="import-success-note">
                  <CheckCircle2 size={16} /> All employees were imported and their login emails were sent.
                </p>
              )}

              <div className="employee-form-actions">
                {problemResults.length > 0 && (
                  <button type="button" className="outline-button import-left-action" onClick={handleDownloadErrorReport}>
                    <Download size={14} /> Download Error Report
                  </button>
                )}
                <button type="button" className="primary-button" onClick={onClose}>
                  Done
                </button>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
