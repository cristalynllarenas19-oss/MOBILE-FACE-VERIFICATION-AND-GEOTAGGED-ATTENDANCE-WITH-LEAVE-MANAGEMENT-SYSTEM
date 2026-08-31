import { useEffect, useRef, useState } from "react";
import {
  CloudDownload,
  CloudUpload,
  Download,
  MoreVertical,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { ConfirmDialog, type ConfirmDialogConfig } from "../../components/ui/ConfirmDialog";
import { DropdownFilter } from "../../components/ui/DropdownFilter";
import { apiRequest, API_BASE_URL } from "../../lib/api";
import type { Notification } from "./UtilitiesPage";

type BackupStatus = "SUCCESS" | "FAILED";

type BackupRecord = {
  name: string;
  createdAt: string;
  sizeBytes: number;
  createdBy: string;
  status: BackupStatus;
};

const PAGE_SIZE = 10;

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function formatSize(sizeBytes: number) {
  return sizeBytes > 0 ? `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB` : "—";
}

// Backend streams the file as a blob (not JSON), so this bypasses apiRequest
// and drives an anchor click instead — same client-side-save pattern as the
// Reports CSV export, but with the auth header a real file endpoint needs.
async function downloadBackupFile(filename: string) {
  const token = localStorage.getItem("accessToken");
  const response = await fetch(`${API_BASE_URL}/backups/${encodeURIComponent(filename)}/download`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new Error(await response.text());
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

type RestoreResult = { restoredTables: number; preRestoreSnapshot: string };

// Multipart upload, so this bypasses apiRequest the same way the download
// helper does — a FormData body needs the browser to set its own
// multipart Content-Type header (with boundary), which apiRequest's
// hardcoded "application/json" header would clobber.
async function uploadRestoreFile(file: File): Promise<RestoreResult> {
  const token = localStorage.getItem("accessToken");
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(`${API_BASE_URL}/backups/restore-upload`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

export function BackupRestoreTab({ notify }: { notify: (notification: Notification) => void }) {
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [page, setPage] = useState(1);
  const [isCreating, setIsCreating] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [confirmConfig, setConfirmConfig] = useState<ConfirmDialogConfig | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const loadBackups = () => {
    apiRequest<BackupRecord[]>("/backups").then(setBackups).catch(() => undefined);
  };

  useEffect(loadBackups, []);

  useEffect(() => {
    if (!openMenuId) return;
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current?.contains(event.target as Node)) return;
      setOpenMenuId(null);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [openMenuId]);

  useEffect(() => {
    setPage(1);
  }, [search, statusFilter]);

  const visibleBackups = backups.filter((backup) => {
    if (statusFilter !== "ALL" && backup.status !== statusFilter) return false;
    if (search.trim() && !backup.name.toLowerCase().includes(search.trim().toLowerCase())) return false;
    return true;
  });

  const pageCount = Math.max(1, Math.ceil(visibleBackups.length / PAGE_SIZE));
  const pagedBackups = visibleBackups.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const createBackup = async () => {
    setIsCreating(true);
    try {
      const record = await apiRequest<BackupRecord>("/backups", { method: "POST" });
      setBackups((current) => [record, ...current]);
      notify({ type: "success", message: `"${record.name}" created successfully.` });
    } catch (err) {
      notify({ type: "error", message: err instanceof Error ? err.message : "Failed to create backup." });
    } finally {
      setIsCreating(false);
    }
  };

  const requestUpload = () => fileInputRef.current?.click();

  const handleFileSelected = (file: File | null) => {
    if (!file) return;
    setConfirmConfig({
      title: "Restore from this backup file?",
      description: `This will replace current data with the contents of "${file.name}". A safety backup of your current data is taken automatically first.`,
      confirmLabel: "Restore",
      tone: "danger",
      onConfirm: async () => {
        try {
          const result = await uploadRestoreFile(file);
          notify({
            type: "success",
            message: `Restore complete. A safety backup of the data it replaced was saved as "${result.preRestoreSnapshot}".`,
          });
          loadBackups();
        } catch (err) {
          notify({ type: "error", message: err instanceof Error ? err.message : "Restore failed." });
        }
      },
    });
  };

  const requestRestore = (backup: BackupRecord) => {
    setOpenMenuId(null);
    setConfirmConfig({
      title: `Restore "${backup.name}"?`,
      description: "This will replace current data with the contents of this backup. A safety backup of your current data is taken automatically first.",
      confirmLabel: "Restore",
      tone: "danger",
      onConfirm: async () => {
        try {
          const result = await apiRequest<RestoreResult>(`/backups/${encodeURIComponent(backup.name)}/restore`, { method: "POST" });
          notify({
            type: "success",
            message: `Restored from "${backup.name}". A safety backup of the data it replaced was saved as "${result.preRestoreSnapshot}".`,
          });
          loadBackups();
        } catch (err) {
          notify({ type: "error", message: err instanceof Error ? err.message : "Restore failed." });
        }
      },
    });
  };

  const requestDelete = (backup: BackupRecord) => {
    setOpenMenuId(null);
    setConfirmConfig({
      title: `Delete "${backup.name}"?`,
      description: "This backup file will be permanently removed from backup history.",
      confirmLabel: "Delete",
      tone: "danger",
      onConfirm: async () => {
        try {
          await apiRequest(`/backups/${encodeURIComponent(backup.name)}`, { method: "DELETE" });
          setBackups((current) => current.filter((item) => item.name !== backup.name));
          notify({ type: "success", message: `"${backup.name}" deleted.` });
        } catch (err) {
          notify({ type: "error", message: err instanceof Error ? err.message : "Failed to delete backup." });
        }
      },
    });
  };

  const downloadBackup = async (backup: BackupRecord) => {
    try {
      await downloadBackupFile(backup.name);
    } catch (err) {
      notify({ type: "error", message: err instanceof Error ? err.message : "Failed to download backup." });
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
          <button className="primary-button" onClick={createBackup} disabled={isCreating}>
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
          <button className="outline-button" onClick={requestUpload}>
            <CloudUpload size={14} /> Upload Backup File
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".sql,.zip,.bak"
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
                <th>SIZE</th>
                <th>CREATED BY</th>
                <th>STATUS</th>
                <th>ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {pagedBackups.length === 0 ? (
                <tr>
                  <td colSpan={6} className="utilities-empty-state">
                    {backups.length === 0 ? "No backups have been created yet." : "No backups match your current filters."}
                  </td>
                </tr>
              ) : (
                pagedBackups.map((backup) => (
                  <tr key={backup.name}>
                    <td data-label="Backup Name">{backup.name}</td>
                    <td data-label="Date & Time">{formatDateTime(backup.createdAt)}</td>
                    <td data-label="Size">{formatSize(backup.sizeBytes)}</td>
                    <td data-label="Created By">{backup.createdBy}</td>
                    <td data-label="Status">
                      <Badge tone={backup.status === "SUCCESS" ? "success" : "danger"}>
                        {backup.status === "SUCCESS" ? "Success" : "Failed"}
                      </Badge>
                    </td>
                    <td data-label="Actions">
                      <div className="backup-restore-row-actions">
                        <button
                          type="button"
                          className="backup-restore-icon-button"
                          disabled={backup.status !== "SUCCESS"}
                          onClick={() => downloadBackup(backup)}
                          aria-label={`Download ${backup.name}`}
                        >
                          <Download size={15} />
                        </button>
                        <div className="backup-restore-menu-wrap" ref={openMenuId === backup.name ? menuRef : undefined}>
                          <button
                            type="button"
                            className="backup-restore-icon-button"
                            onClick={() => setOpenMenuId((current) => (current === backup.name ? null : backup.name))}
                            aria-label={`More actions for ${backup.name}`}
                          >
                            <MoreVertical size={15} />
                          </button>
                          {openMenuId === backup.name && (
                            <div className="backup-restore-menu">
                              <button
                                type="button"
                                disabled={backup.status !== "SUCCESS"}
                                onClick={() => requestRestore(backup)}
                              >
                                <RotateCcw size={13} /> Restore
                              </button>
                              <button type="button" className="danger" onClick={() => requestDelete(backup)}>
                                <Trash2 size={13} /> Delete
                              </button>
                            </div>
                          )}
                        </div>
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

      {confirmConfig && <ConfirmDialog config={confirmConfig} onCancel={() => setConfirmConfig(null)} />}
    </>
  );
}
