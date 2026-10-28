import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Loader2,
  XCircle,
  CloudDownload,
  CloudUpload,
  Download,
  FileJson,
  Info,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { ConfirmDialog, type ConfirmDialogConfig } from "../../components/ui/ConfirmDialog";
import { DropdownFilter } from "../../components/ui/DropdownFilter";
import { apiRequest, API_BASE_URL } from "../../lib/api";
import { useLiveRefresh } from "../../lib/liveRefresh";
import type { Notification } from "./UtilitiesPage";

type BackupStatus = "SUCCESS" | "FAILED";
type BackupTrigger = "manual" | "pre-restore";

type BackupRecord = {
  name: string;
  createdAt: string;
  sizeBytes: number;
  createdBy: string;
  status: BackupStatus;
  // Absent on backups made before this field existed — treated as "manual".
  trigger?: BackupTrigger;
};

const PAGE_SIZE = 10;

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function formatSize(sizeBytes: number) {
  return sizeBytes > 0 ? `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB` : "—";
}

// A missing trigger (backups made before this field existed) reads as "Backup".
function actionLabel(trigger?: BackupTrigger) {
  return trigger === "pre-restore" ? "Restored" : "Backup";
}

function actionTone(trigger?: BackupTrigger): "role" | "warning" {
  return trigger === "pre-restore" ? "warning" : "role";
}

// Same File System Access shape ReportsPage's saveBlob uses, plus the
// optional remove() used to clean up a picked-but-never-written file.
type SaveFileHandle = {
  createWritable: () => Promise<{
    write: (data: Blob) => Promise<void>;
    close: () => Promise<void>;
  }>;
  remove?: () => Promise<void>;
};
type SavePicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<SaveFileHandle>;

// Mirrors the backend's backupStamp() so the name pre-filled in the save
// dialog matches what the backup will be called in Backup History.
function suggestedBackupName(date = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  const hours24 = date.getHours();
  const suffix = hours24 >= 12 ? "PM" : "AM";
  return `Backup_${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(hours24 % 12 || 12)}${pad(date.getMinutes())}${suffix}.sql`;
}

// Backend streams the file as a blob (not JSON), so this bypasses apiRequest
// — same as the Reports export, but with the auth header a real file
// endpoint needs.
async function fetchBackupBlob(filename: string) {
  const token = localStorage.getItem("accessToken");
  const response = await fetch(`${API_BASE_URL}/backups/${encodeURIComponent(filename)}/download`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new Error(await response.text());
  return response.blob();
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

type RestoreResult = { restoredTables: number; preRestoreSnapshot: string };
type FileValidation = "checking" | "valid" | "invalid";

// First line of every .sql backup the backend writes (its SQL_HEADER).
const SQL_BACKUP_HEADER = "-- ETALA backup";

// Same first-pass check the backend does — catches an obviously wrong file
// client-side before the admin can even click Restore Data, rather than
// only finding out after a round trip to the server. A .sql backup is
// recognised by its header line; anything else is checked as the older
// .json format.
async function looksLikeBackupFile(file: File): Promise<boolean> {
  try {
    const head = await file.slice(0, SQL_BACKUP_HEADER.length).text();
    if (head === SQL_BACKUP_HEADER) return true;
    if (file.name.toLowerCase().endsWith(".sql")) return false;
    const parsed = JSON.parse(await file.text());
    return !!parsed && typeof parsed === "object" && typeof parsed.tables === "object" && parsed.tables !== null;
  } catch {
    return false;
  }
}

// The restore is one request: the file uploads, then the server validates
// it, takes a safety backup and restores inside a single transaction before
// it answers. Only the upload part reports real progress.
type RestoreStage = "uploading" | "restoring";
type RestoreModalState =
  | { phase: "running"; stage: RestoreStage; uploadPercent: number | null }
  | { phase: "success"; result: RestoreResult }
  // "uncertain" = the connection dropped after the upload, so the server may
  // still have finished the restore.
  | { phase: "error"; message: string; uncertain: boolean };

type CreateModalState =
  | { phase: "running"; stage: "creating" | "saving" }
  | { phase: "success"; name: string }
  // savedName = the backup was made but saving the file failed.
  | { phase: "error"; message: string; savedName?: string };

class RestoreRequestError extends Error {
  constructor(message: string, readonly uncertain: boolean) {
    super(message);
  }
}

// Nest errors come back as JSON ({ message }); fall back to the raw text.
function readErrorMessage(body: string) {
  try {
    const parsed = JSON.parse(body);
    const message = Array.isArray(parsed?.message) ? parsed.message.join(" ") : parsed?.message;
    if (typeof message === "string" && message.trim()) return message;
  } catch {
    // not JSON
  }
  return body.trim() || "Restore failed.";
}

// Multipart upload, so this bypasses apiRequest the same way the download
// helper does — a FormData body needs the browser to set its own
// multipart Content-Type header (with boundary), which apiRequest's
// hardcoded "application/json" header would clobber. XHR instead of fetch
// because only XHR reports upload progress.
function uploadRestoreFile(
  file: File,
  onProgress: (stage: RestoreStage, uploadPercent: number | null) => void,
): Promise<RestoreResult> {
  return new Promise((resolve, reject) => {
    const token = localStorage.getItem("accessToken");
    const formData = new FormData();
    formData.append("file", file);
    const xhr = new XMLHttpRequest();
    let uploadDone = false;
    xhr.open("POST", `${API_BASE_URL}/backups/restore-upload`);
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (event) => {
      onProgress("uploading", event.lengthComputable ? Math.round((event.loaded / event.total) * 100) : null);
    };
    xhr.upload.onload = () => {
      uploadDone = true;
      onProgress("restoring", null);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new RestoreRequestError("The server finished but sent an unreadable reply.", true));
        }
      } else {
        reject(new RestoreRequestError(readErrorMessage(xhr.responseText), false));
      }
    };
    xhr.onerror = () =>
      reject(
        new RestoreRequestError(
          uploadDone
            ? "The connection to the server was lost while it was restoring."
            : "Couldn't reach the server. Check your connection and try again.",
          uploadDone,
        ),
      );
    xhr.ontimeout = () => reject(new RestoreRequestError("The server took too long to respond.", uploadDone));
    xhr.send(formData);
  });
}

export function BackupRestoreTab({ notify }: { notify: (notification: Notification) => void }) {
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [page, setPage] = useState(1);
  const [createModal, setCreateModal] = useState<CreateModalState | null>(null);
  const isCreating = createModal?.phase === "running";
  const [restoreModal, setRestoreModal] = useState<RestoreModalState | null>(null);
  const isRestoring = restoreModal?.phase === "running";
  const [confirmConfig, setConfirmConfig] = useState<ConfirmDialogConfig | null>(null);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileValidation, setFileValidation] = useState<FileValidation | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadBackups = () => {
    apiRequest<BackupRecord[]>("/backups").then(setBackups).catch(() => undefined);
  };

  useEffect(loadBackups, []);
  useLiveRefresh(loadBackups);

  useEffect(() => {
    setPage(1);
  }, [search, statusFilter]);

  // Browser's own "leave site?" prompt while a backup or restore is running.
  const isBusy = isCreating || isRestoring;
  useEffect(() => {
    if (!isBusy) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [isBusy]);

  const visibleBackups = backups.filter((backup) => {
    if (statusFilter !== "ALL" && backup.status !== statusFilter) return false;
    if (search.trim() && !backup.name.toLowerCase().includes(search.trim().toLowerCase())) return false;
    return true;
  });

  const pageCount = Math.max(1, Math.ceil(visibleBackups.length / PAGE_SIZE));
  const pagedBackups = visibleBackups.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const createBackup = async () => {
    // The save dialog has to open first, straight off the click — browsers
    // refuse to show it once the (slow) backup request has used up the user
    // gesture. Browsers without the picker fall back to a normal download.
    const showSaveFilePicker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
    let handle: SaveFileHandle | null = null;
    if (showSaveFilePicker) {
      try {
        handle = await showSaveFilePicker({
          suggestedName: suggestedBackupName(),
          types: [{ description: "SQL backup file", accept: { "application/sql": [".sql"] } }],
        });
      } catch (err) {
        // Cancelled the dialog — no backup is created.
        if (err instanceof DOMException && err.name === "AbortError") return;
      }
    }

    setCreateModal({ phase: "running", stage: "creating" });
    let record: BackupRecord;
    try {
      record = await apiRequest<BackupRecord>("/backups", { method: "POST" });
      setBackups((current) => [record, ...current]);
    } catch (err) {
      // The picker already created an empty file at the chosen location.
      await handle?.remove?.().catch(() => undefined);
      setCreateModal({ phase: "error", message: err instanceof Error ? err.message : "Failed to create backup." });
      return;
    }

    setCreateModal({ phase: "running", stage: "saving" });
    try {
      const blob = await fetchBackupBlob(record.name);
      if (handle) {
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
      } else {
        downloadBlob(blob, record.name);
      }
      setCreateModal({ phase: "success", name: record.name });
    } catch (err) {
      await handle?.remove?.().catch(() => undefined);
      setCreateModal({
        phase: "error",
        message: err instanceof Error && err.message ? err.message : "Saving the file failed.",
        savedName: record.name,
      });
    }
  };

  // Created-but-not-saved only needs the file again, not a second backup.
  const retryCreate = () => {
    if (createModal?.phase !== "error") return;
    const savedName = createModal.savedName;
    setCreateModal(null);
    if (savedName) {
      const record = backups.find((backup) => backup.name === savedName);
      if (record) downloadBackup(record);
    } else {
      createBackup();
    }
  };

  const openUploadModal = () => {
    setSelectedFile(null);
    setFileValidation(null);
    setUploadModalOpen(true);
  };

  const closeUploadModal = () => {
    setUploadModalOpen(false);
    setSelectedFile(null);
    setFileValidation(null);
  };

  const chooseFile = () => fileInputRef.current?.click();

  const handleFileSelected = async (file: File | null) => {
    if (!file) return;
    setSelectedFile(file);
    setFileValidation("checking");
    const isValid = await looksLikeBackupFile(file);
    setFileValidation(isValid ? "valid" : "invalid");
  };

  const confirmUploadRestore = async () => {
    if (!selectedFile || fileValidation !== "valid" || isRestoring) return;
    const file = selectedFile;
    closeUploadModal();
    setRestoreModal({ phase: "running", stage: "uploading", uploadPercent: 0 });
    try {
      const result = await uploadRestoreFile(file, (stage, uploadPercent) =>
        setRestoreModal({ phase: "running", stage, uploadPercent }),
      );
      setRestoreModal({ phase: "success", result });
    } catch (err) {
      setRestoreModal({
        phase: "error",
        message: err instanceof Error ? err.message : "Restore failed.",
        uncertain: err instanceof RestoreRequestError && err.uncertain,
      });
    } finally {
      // Success adds a safety backup; a failed restore can too.
      loadBackups();
    }
  };

  const retryRestore = () => {
    setRestoreModal(null);
    openUploadModal();
  };

  const requestDelete = (backup: BackupRecord) => {
    setConfirmConfig({
      title: `Delete "${backup.name}"?`,
      description: "This backup file will be permanently removed from backup history.",
      confirmLabel: "Delete",
      tone: "danger",
      onConfirm: async () => {
        try {
          await apiRequest(`/backups/${encodeURIComponent(backup.name)}`, { method: "DELETE" });
          setBackups((current) => current.filter((item) => item.name !== backup.name));
          notify({ type: "success", title: "Backup Deleted", message: `"${backup.name}" deleted.` });
        } catch (err) {
          notify({
            type: "error",
            title: "Couldn't Delete Backup",
            message: err instanceof Error ? err.message : "Failed to delete backup.",
          });
        }
      },
    });
  };

  const downloadBackup = async (backup: BackupRecord) => {
    try {
      downloadBlob(await fetchBackupBlob(backup.name), backup.name);
    } catch (err) {
      notify({
        type: "error",
        title: "Couldn't Download Backup",
        message: err instanceof Error ? err.message : "Failed to download backup.",
      });
    }
  };

  return (
    <>
      <div className="utilities-toolbar-header">
        <div className="utilities-toolbar-header-left">
          <h3 className="utilities-toolbar-title">Backup &amp; Restore</h3>
        </div>
      </div>
      <p className="backup-restore-subtitle">Manage system data backups and restore when needed.</p>

      <div className="backup-restore-action-grid">
        <section className="backup-restore-action-card">
          <div className="backup-restore-action-icon backup-restore-action-icon--create">
            <CloudDownload size={20} />
          </div>
          <h4>Create a Backup</h4>
          <p>Download a backup of your system data. The backup file will include all important records.</p>
          <button className="primary-button" onClick={createBackup} disabled={isCreating || isRestoring}>
            {isCreating ? "Creating…" : "+ Create Backup"}
          </button>
          <span className="backup-restore-action-note">
            <ShieldCheck size={13} /> Only administrators can create backups.
          </span>
        </section>

        <section className="backup-restore-action-card">
          <div className="backup-restore-action-icon backup-restore-action-icon--restore">
            <CloudUpload size={20} />
          </div>
          <h4>Restore Data</h4>
          <p>Restore your system data from a previously saved backup file.</p>
          <button className="outline-button" onClick={openUploadModal} disabled={isRestoring}>
            <CloudUpload size={14} /> Upload Backup File
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".sql,.json"
            hidden
            onChange={(e) => {
              handleFileSelected(e.target.files?.[0] ?? null);
              e.target.value = "";
            }}
          />
          <span className="backup-restore-action-note backup-restore-action-note--warning">
            <ShieldCheck size={13} /> This will replace current data with the backup data.
          </span>
        </section>
      </div>

      <div className="utilities-toolbar-header">
        <div className="utilities-toolbar-header-left">
          <h3 className="utilities-toolbar-title">Backup History</h3>
        </div>
        <div className="utilities-result-count">
          <span>{visibleBackups.length} result{visibleBackups.length !== 1 ? "s" : ""}</span>
        </div>
      </div>
      <p className="backup-restore-subtitle backup-restore-subtitle--tight">View and manage your previous backups.</p>

      <div className="utilities-filter-bar">
        <div className="utilities-filter-group utilities-audit-search-group">
          <label className="utilities-filter-label">Search</label>
          <div className="utilities-search-input-wrap">
            <Search size={14} className="utilities-search-icon" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search backup..."
              aria-label="Search backups"
            />
            {search && (
              <button type="button" className="utilities-search-clear" onClick={() => setSearch("")} aria-label="Clear search">
                <X size={13} />
              </button>
            )}
          </div>
        </div>

        <div className="utilities-filter-group">
          <label className="utilities-filter-label">Status</label>
          <DropdownFilter
            className="utilities-filter-select"
            value={statusFilter}
            onChange={setStatusFilter}
            options={[{ value: "SUCCESS", label: "Success" }, { value: "FAILED", label: "Failed" }]}
            allLabel="All Statuses"
            menuLabel="Filter by status"
            ariaLabel="Filter backups by status"
          />
        </div>
      </div>

      <section className="table-card utilities-table-card">
        <div className="utilities-table-scroll">
          <table>
            <thead>
              <tr>
                <th>BACKUP NAME</th>
                <th>DATE &amp; TIME</th>
                <th>ACTION</th>
                <th>SIZE</th>
                <th>CREATED BY</th>
                <th>STATUS</th>
                <th>OPTIONS</th>
              </tr>
            </thead>
            <tbody>
              {pagedBackups.length === 0 ? (
                <tr>
                  <td colSpan={7} className="utilities-empty-state">
                    {backups.length === 0 ? "No backups have been created yet." : "No backups match your current filters."}
                  </td>
                </tr>
              ) : (
                pagedBackups.map((backup) => (
                  <tr key={backup.name}>
                    <td data-label="Backup Name">
                      <span className="backup-restore-name-cell">
                        <FileJson size={14} />
                        {backup.name}
                      </span>
                    </td>
                    <td data-label="Date & Time">{formatDateTime(backup.createdAt)}</td>
                    <td data-label="Action">
                      <Badge tone={actionTone(backup.trigger)}>{actionLabel(backup.trigger)}</Badge>
                    </td>
                    <td data-label="Size">{formatSize(backup.sizeBytes)}</td>
                    <td data-label="Created By">{backup.createdBy}</td>
                    <td data-label="Status">
                      <Badge tone={backup.status === "SUCCESS" ? "success" : "danger"}>
                        {backup.status === "SUCCESS" ? "Success" : "Failed"}
                      </Badge>
                    </td>
                    <td data-label="Options">
                      <div className="backup-restore-row-actions">
                        <button
                          type="button"
                          className="backup-restore-icon-button"
                          disabled={backup.status !== "SUCCESS" || isRestoring}
                          onClick={() => downloadBackup(backup)}
                          aria-label={`Download ${backup.name}`}
                        >
                          <Download size={15} />
                        </button>
                        <button
                          type="button"
                          className="backup-restore-icon-button backup-restore-icon-button--danger"
                          disabled={isRestoring}
                          onClick={() => requestDelete(backup)}
                          aria-label={`Delete ${backup.name}`}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="utilities-pagination utilities-pagination-footer">
          <button className="outline-button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </button>
          <span>Page {page} of {pageCount}</span>
          <button className="outline-button" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>
            Next
          </button>
        </div>
      </section>

      {uploadModalOpen && (
        <div className="utilities-modal-backdrop" role="presentation">
          <section
            className="utilities-modal utilities-modal--sm backup-restore-upload-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="restore-upload-title"
          >
            <div className="utilities-modal-header">
              <div>
                <h2 id="restore-upload-title">Restore from Backup</h2>
                <p>Select a backup file to restore your system data.</p>
              </div>
              <button className="icon-button" onClick={closeUploadModal} aria-label="Close">
                <X size={18} />
              </button>
            </div>

            <div className="utilities-modal-body">
              {!selectedFile ? (
                <div className="backup-restore-dropzone">
                  <CloudUpload size={28} />
                  <button type="button" className="primary-button" onClick={chooseFile}>
                    Choose Backup File
                  </button>
                  <p className="backup-restore-dropzone-hint">Select a valid SQL backup file.</p>
                  <span className="backup-restore-filetype-chip">SQL (.sql)</span>
                </div>
              ) : (
                <>
                  <div>
                    <span className="utilities-field-label">Selected Backup File</span>
                    <div className={`backup-restore-selected-file ${fileValidation === "invalid" ? "invalid" : ""}`}>
                      <div className={`backup-restore-file-icon ${fileValidation === "invalid" ? "invalid" : ""}`}>
                        <FileJson size={20} />
                      </div>
                      <div className="backup-restore-selected-file-info">
                        <strong>{selectedFile.name}</strong>
                        <span>
                          {formatDateTime(new Date(selectedFile.lastModified).toISOString())} · {formatSize(selectedFile.size)}
                        </span>
                      </div>
                      {fileValidation === "checking" && <Badge tone="neutral">Checking…</Badge>}
                      {fileValidation === "valid" && <Badge tone="success">Ready</Badge>}
                      {fileValidation === "invalid" && <Badge tone="danger">Invalid</Badge>}
                    </div>
                    <button type="button" className="backup-restore-change-file" onClick={chooseFile}>
                      Change File
                    </button>
                    {fileValidation === "invalid" && (
                      <p className="utilities-field-error">This doesn&apos;t look like a valid ETALA backup file.</p>
                    )}
                  </div>

                  <div className="backup-restore-info-box">
                    <span className="backup-restore-info-box-title">What will happen?</span>
                    <ul>
                      <li>
                        <CheckCircle2 size={13} /> Your current system data will be replaced with the data from this backup.
                      </li>
                      <li>
                        <CheckCircle2 size={13} /> This action cannot be undone.
                      </li>
                      <li>
                        <CheckCircle2 size={13} /> A safety backup of your current data is taken automatically first.
                      </li>
                    </ul>
                  </div>
                  <p className="backup-restore-dropzone-hint">
                    <Info size={13} /> This process may take a few minutes depending on the backup size.
                  </p>
                </>
              )}
            </div>

            <div className="utilities-modal-actions">
              <button className="outline-button" onClick={closeUploadModal}>
                Cancel
              </button>
              <button className="primary-button" disabled={fileValidation !== "valid"} onClick={confirmUploadRestore}>
                Restore Data
              </button>
            </div>
          </section>
        </div>
      )}

      {createModal && (
        <div className="utilities-modal-backdrop" role="presentation">
          <section
            className="utilities-modal utilities-modal--sm backup-restore-status-modal"
            role={createModal.phase === "error" ? "alertdialog" : "dialog"}
            aria-modal="true"
            aria-labelledby="create-status-title"
            aria-busy={createModal.phase === "running"}
          >
            {createModal.phase === "running" && (
              <>
                <Loader2 size={34} className="backup-restore-status-spinner" />
                <h2 id="create-status-title">Creating Backup...</h2>
                <p>Please wait while we back up your system data. This may take a few moments.</p>

                <ol className="backup-restore-steps">
                  {(
                    [
                      ["creating", "Creating backup"],
                      ["saving", "Saving file to your computer"],
                    ] as const
                  ).map(([stage, label]) => {
                    const done = stage === "creating" && createModal.stage === "saving";
                    const current = stage === createModal.stage;
                    return (
                      <li key={stage} className={done ? "done" : current ? "current" : ""}>
                        <span className="backup-restore-step-marker">{done && <Check size={11} />}</span>
                        <div className="backup-restore-step-body">
                          <span>{label}</span>
                          {current && (
                            <div className="backup-restore-progress-track">
                              <div className="backup-restore-progress-fill backup-restore-progress-fill--indeterminate" />
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>

                <div className="backup-restore-status-note">
                  <Info size={14} />
                  <span>Please do not refresh or leave this page while the backup is being created.</span>
                </div>
              </>
            )}

            {createModal.phase === "success" && (
              <>
                <CheckCircle2 size={40} className="backup-restore-status-icon backup-restore-status-icon--success" />
                <h2 id="create-status-title">Backup Created Successfully!</h2>
                <p>Your system data has been backed up and saved.</p>
                <p className="backup-restore-status-detail">&quot;{createModal.name}&quot;</p>
                <div className="backup-restore-status-actions">
                  <button className="primary-button" onClick={() => setCreateModal(null)} autoFocus>
                    Done
                  </button>
                </div>
              </>
            )}

            {createModal.phase === "error" && (
              <>
                <XCircle size={40} className="backup-restore-status-icon backup-restore-status-icon--error" />
                <h2 id="create-status-title">
                  {createModal.savedName ? "Backup Created, But Not Saved" : "Backup Creation Failed"}
                </h2>
                <p>
                  {createModal.savedName
                    ? `"${createModal.savedName}" is in Backup History, but saving it to your computer failed.`
                    : "We couldn't back up your system data. Please try again or contact the system administrator."}
                </p>
                <div className="backup-restore-status-error">
                  <AlertCircle size={14} />
                  <span>
                    <strong>Error:</strong> {createModal.message}
                  </span>
                </div>
                <div className="backup-restore-status-actions">
                  <button className="outline-button" onClick={() => setCreateModal(null)}>
                    Close
                  </button>
                  <button className="primary-button" onClick={retryCreate}>
                    {createModal.savedName ? "Download Again" : "Try Again"}
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {restoreModal && (
        <div className="utilities-modal-backdrop" role="presentation">
          <section
            className="utilities-modal utilities-modal--sm backup-restore-status-modal"
            role={restoreModal.phase === "error" ? "alertdialog" : "dialog"}
            aria-modal="true"
            aria-labelledby="restore-status-title"
            aria-busy={restoreModal.phase === "running"}
          >
            {restoreModal.phase === "running" && (
              <>
                <Loader2 size={34} className="backup-restore-status-spinner" />
                <h2 id="restore-status-title">Restoring Backup...</h2>
                <p>Please wait while we restore your system data. This may take a few moments.</p>

                <ol className="backup-restore-steps">
                  {(
                    [
                      ["uploading", "Uploading backup file"],
                      ["restoring", "Validating and restoring database"],
                    ] as const
                  ).map(([stage, label]) => {
                    const done = stage === "uploading" && restoreModal.stage === "restoring";
                    const current = stage === restoreModal.stage;
                    return (
                      <li key={stage} className={done ? "done" : current ? "current" : ""}>
                        <span className="backup-restore-step-marker">{done && <Check size={11} />}</span>
                        <div className="backup-restore-step-body">
                          <span>
                            {label}
                            {current && stage === "uploading" && restoreModal.uploadPercent != null && (
                              <strong> {restoreModal.uploadPercent}%</strong>
                            )}
                          </span>
                          {current && (
                            <div className="backup-restore-progress-track">
                              {stage === "uploading" && restoreModal.uploadPercent != null ? (
                                <div
                                  className="backup-restore-progress-fill"
                                  style={{ width: `${restoreModal.uploadPercent}%` }}
                                />
                              ) : (
                                <div className="backup-restore-progress-fill backup-restore-progress-fill--indeterminate" />
                              )}
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>

                <div className="backup-restore-status-note">
                  <Info size={14} />
                  <span>Please do not refresh or leave this page while restoration is in progress.</span>
                </div>
              </>
            )}

            {restoreModal.phase === "success" && (
              <>
                <CheckCircle2 size={40} className="backup-restore-status-icon backup-restore-status-icon--success" />
                <h2 id="restore-status-title">Backup Restored Successfully!</h2>
                <p>Your system data has been restored from the selected backup file.</p>
                <p className="backup-restore-status-detail">
                  A safety backup of the data it replaced was saved as &quot;{restoreModal.result.preRestoreSnapshot}&quot;.
                </p>
                <div className="backup-restore-status-actions">
                  <button className="primary-button" onClick={() => setRestoreModal(null)} autoFocus>
                    Done
                  </button>
                </div>
              </>
            )}

            {restoreModal.phase === "error" && (
              <>
                <XCircle size={40} className="backup-restore-status-icon backup-restore-status-icon--error" />
                <h2 id="restore-status-title">Backup Restoration Failed</h2>
                <p>
                  {restoreModal.uncertain
                    ? "We couldn't confirm whether the restore finished."
                    : "We couldn't restore your system data. Please check the file and try again or contact the system administrator."}
                </p>
                <div className="backup-restore-status-error">
                  <AlertCircle size={14} />
                  <span>
                    <strong>Error:</strong> {restoreModal.message}
                    {restoreModal.uncertain &&
                      " The server may still have completed it. Check Backup History for a new \"Restored\" safety backup and review your data before trying again."}
                  </span>
                </div>
                <div className="backup-restore-status-actions">
                  <button className="outline-button" onClick={() => setRestoreModal(null)}>
                    Close
                  </button>
                  {!restoreModal.uncertain && (
                    <button className="primary-button" onClick={retryRestore}>
                      Try Again
                    </button>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {confirmConfig && <ConfirmDialog config={confirmConfig} onCancel={() => setConfirmConfig(null)} />}
    </>
  );
}
