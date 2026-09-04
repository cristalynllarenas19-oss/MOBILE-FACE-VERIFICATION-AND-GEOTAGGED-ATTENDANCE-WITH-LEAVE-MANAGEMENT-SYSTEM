import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  Eye,
  Flag,
  Image as ImageIcon,
  IndentIncrease,
  Link2,
  List,
  ListOrdered,
  Megaphone,
  Pin,
  Redo2,
  Search,
  SquarePen,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { DropdownFilter } from "../../components/ui/DropdownFilter";
import { MultiSelectDropdown } from "../../components/ui/MultiSelectDropdown";
import { apiRequest } from "../../lib/api";
import { useActiveDepartments } from "../../lib/departments";
import { renderFormattedText } from "../../lib/richText";
import { PermissionCode, permissions } from "../../types/rbac";
import type { Notification } from "./UtilitiesPage";
import "../employees/EmployeesPage.css";

type ActorRef = { email: string; employee?: { firstName: string; lastName: string } | null } | null;

type AnnouncementStatus = "DRAFT" | "SCHEDULED" | "PUBLISHED";

type AnnouncementListItem = {
  id: string;
  title: string;
  message: string;
  status: AnnouncementStatus;
  scheduledAt: string | null;
  publishedAt: string | null;
  targetDepartmentIds: string[];
  targetSupervisorsOnly: boolean;
  targetEmployeeIds: string[];
  createdAt: string;
  createdBy?: ActorRef;
  recipientCount: number;
  deliveredCount: number;
  viewedCount: number;
  notViewedCount: number;
  archivedAt: string | null;
};

type EmployeeOption = {
  id: string;
  firstName: string;
  lastName: string;
  employeeNo?: string;
  employmentStatus?: string;
  department?: { name: string } | null;
};

type AnnouncementRecipient = {
  firstName: string;
  lastName: string;
  department: string;
  viewedAt: string | null;
};

type AnnouncementDetail = AnnouncementListItem & { recipients: AnnouncementRecipient[] };

type AnnouncementPriority = "URGENT" | "IMPORTANT" | "STANDARD" | "PINNED";

const ALL_EMPLOYEES_VALUE = "ALL";
const SUPERVISORS_VALUE = "SUPERVISORS";

const PRIORITY_OPTIONS: { value: AnnouncementPriority; label: string }[] = [
  { value: "URGENT", label: "Urgent" },
  { value: "IMPORTANT", label: "Important" },
  { value: "STANDARD", label: "Standard" },
  { value: "PINNED", label: "Pinned" },
];

const PAGE_SIZE = 10;

// Same cap as the leave-request attachment flow (leave.service.ts) — the
// image is embedded as a base64 data: URI directly in the message text.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

type DateFilterPreset = "ALL" | "WEEK" | "MONTH" | "SIX_MONTHS" | "YEAR" | "CUSTOM";

const DATE_FILTER_OPTIONS: { value: DateFilterPreset; label: string }[] = [
  { value: "WEEK", label: "Older than a week" },
  { value: "MONTH", label: "Older than a month" },
  { value: "SIX_MONTHS", label: "Older than 6 months" },
  { value: "YEAR", label: "Older than a year" },
  { value: "CUSTOM", label: "Custom range…" },
];

// Local YYYY-MM-DD (not toISOString, which is UTC and can land on the wrong
// calendar day depending on the browser's timezone).
function toDateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateBeforePreset(preset: Exclude<DateFilterPreset, "ALL" | "CUSTOM">) {
  const date = new Date();
  if (preset === "WEEK") date.setDate(date.getDate() - 7);
  if (preset === "MONTH") date.setMonth(date.getMonth() - 1);
  if (preset === "SIX_MONTHS") date.setMonth(date.getMonth() - 6);
  if (preset === "YEAR") date.setFullYear(date.getFullYear() - 1);
  return toDateInputValue(date);
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

// datetime-local inputs want "YYYY-MM-DDTHH:mm" in the browser's local time
// (not UTC, which is what toISOString gives), so the offset has to be
// subtracted back out before slicing.
function toDatetimeLocalValue(iso: string) {
  const date = new Date(iso);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function creatorName(actor?: ActorRef) {
  if (!actor) return "System";
  if (actor.employee) return `${actor.employee.firstName} ${actor.employee.lastName}`;
  return actor.email;
}

export function AnnouncementsTab({
  user,
  notify,
}: {
  user?: { permissions: PermissionCode[] };
  notify: (notification: Notification) => void;
}) {
  const canManage = user?.permissions.includes(permissions.announcementsWrite) ?? true;
  const { departments: activeDepartments } = useActiveDepartments();

  const [announcements, setAnnouncements] = useState<AnnouncementListItem[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [dateFilterPreset, setDateFilterPreset] = useState<DateFilterPreset>("ALL");
  const [page, setPage] = useState(1);

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [allEmployees, setAllEmployees] = useState(false);
  const [selectedDepartmentIds, setSelectedDepartmentIds] = useState<Set<string>>(new Set());
  const [targetSupervisorsOnly, setTargetSupervisorsOnly] = useState(false);
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<Set<string>>(new Set());
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [priority, setPriority] = useState<AnnouncementPriority>("STANDARD");
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [isScheduling, setIsScheduling] = useState(false);
  const [showSchedulePicker, setShowSchedulePicker] = useState(false);
  const [scheduledAtInput, setScheduledAtInput] = useState("");
  const [isHeadingLine, setIsHeadingLine] = useState(false);

  const messageRef = useRef<HTMLTextAreaElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const historyRef = useRef<string[]>([""]);
  const historyIndexRef = useRef(0);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [viewId, setViewId] = useState<string | null>(null);
  const [viewDetail, setViewDetail] = useState<AnnouncementDetail | null>(null);
  const [isViewLoading, setIsViewLoading] = useState(false);

  const loadAnnouncements = () => {
    apiRequest<AnnouncementListItem[]>(`/announcements?archived=${showArchived}`)
      .then(setAnnouncements)
      .catch(() => undefined);
  };

  useEffect(loadAnnouncements, [showArchived]);

  useEffect(() => {
    apiRequest<EmployeeOption[]>("/employees").then(setEmployees).catch(() => undefined);
  }, []);

  useEffect(() => {
    setPage(1);
  }, [search, dateFrom, dateTo, showArchived]);

  // "Any time" (DropdownFilter's built-in allValue) clears the range
  // entirely — everything shows, same as no filter applied at all. Each
  // preset sets an upper bound only (unbounded past), matching "older than
  // X" literally. Custom range leaves From/To alone for manual entry.
  const applyDateFilterPreset = (preset: DateFilterPreset) => {
    setDateFilterPreset(preset);
    if (preset === "ALL") {
      setDateFrom("");
      setDateTo("");
    } else if (preset !== "CUSTOM") {
      setDateFrom("");
      setDateTo(dateBeforePreset(preset));
    }
  };

  useEffect(() => {
    if (!viewId) {
      setViewDetail(null);
      return;
    }
    setIsViewLoading(true);
    apiRequest<AnnouncementDetail>(`/announcements/${viewId}`)
      .then(setViewDetail)
      .catch(() => undefined)
      .finally(() => setIsViewLoading(false));
  }, [viewId]);

  const departmentNameById = useMemo(
    () => new Map(activeDepartments.map((department) => [department.id, department.name])),
    [activeDepartments],
  );

  const recipientOptions = useMemo(
    () => [
      { value: ALL_EMPLOYEES_VALUE, label: "All Employees" },
      { value: SUPERVISORS_VALUE, label: "Supervisors" },
      ...activeDepartments.map((department) => ({ value: department.id, label: department.name })),
    ],
    [activeDepartments],
  );

  const recipientValues = allEmployees
    ? [ALL_EMPLOYEES_VALUE]
    : [...(targetSupervisorsOnly ? [SUPERVISORS_VALUE] : []), ...Array.from(selectedDepartmentIds)];

  // MultiSelectDropdown always toggles exactly one value per click, so diffing
  // prev vs. next tells us which single value was the one just (de)selected —
  // lets "All Employees" stay mutually exclusive with everything else without
  // a separate checkbox control.
  function handleRecipientsChange(nextValues: string[]) {
    const added = nextValues.find((v) => !recipientValues.includes(v));
    const removed = recipientValues.find((v) => !nextValues.includes(v));
    const toggled = added ?? removed;

    if (toggled === ALL_EMPLOYEES_VALUE) {
      const turnedOn = added === ALL_EMPLOYEES_VALUE;
      setAllEmployees(turnedOn);
      if (turnedOn) {
        setSelectedDepartmentIds(new Set());
        setTargetSupervisorsOnly(false);
        setSelectedEmployeeIds(new Set());
      }
      return;
    }

    if (toggled === SUPERVISORS_VALUE) {
      setAllEmployees(false);
      setTargetSupervisorsOnly(added === SUPERVISORS_VALUE);
      return;
    }

    setAllEmployees(false);
    setSelectedDepartmentIds(new Set(nextValues.filter((v) => v !== ALL_EMPLOYEES_VALUE && v !== SUPERVISORS_VALUE)));
  }

  const activeEmployees = useMemo(
    () => employees.filter((employee) => employee.employmentStatus !== "SEPARATED"),
    [employees],
  );

  const selectedEmployees = useMemo(
    () => activeEmployees.filter((employee) => selectedEmployeeIds.has(employee.id)),
    [activeEmployees, selectedEmployeeIds],
  );

  const employeeSearchResults = useMemo(() => {
    const query = employeeSearch.trim().toLowerCase();
    if (!query) return [];
    return activeEmployees
      .filter((employee) => !selectedEmployeeIds.has(employee.id))
      .filter((employee) => `${employee.firstName} ${employee.lastName}`.toLowerCase().includes(query))
      .slice(0, 8);
  }, [activeEmployees, employeeSearch, selectedEmployeeIds]);

  function addEmployee(id: string) {
    setSelectedEmployeeIds((current) => new Set(current).add(id));
    setAllEmployees(false);
    setEmployeeSearch("");
  }

  function removeEmployee(id: string) {
    setSelectedEmployeeIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }

  function removeDepartment(id: string) {
    setSelectedDepartmentIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }

  function resetHistory(initial: string) {
    historyRef.current = [initial];
    historyIndexRef.current = 0;
  }

  // Its own small undo/redo stack rather than the textarea's native one —
  // toolbar buttons set `message` via React state, which resets the
  // browser's built-in undo history on every click, so Undo/Redo would
  // otherwise only ever "undo" the very last keystroke.
  function commitMessage(next: string, options: { immediate?: boolean } = {}) {
    setMessage(next);
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);

    const commit = () => {
      const stack = historyRef.current.slice(0, historyIndexRef.current + 1);
      if (stack[stack.length - 1] === next) return;
      stack.push(next);
      historyRef.current = stack;
      historyIndexRef.current = stack.length - 1;
    };

    if (options.immediate) commit();
    else typingTimerRef.current = setTimeout(commit, 500);
  }

  function handleUndo() {
    if (historyIndexRef.current === 0) return;
    historyIndexRef.current -= 1;
    setMessage(historyRef.current[historyIndexRef.current]);
  }

  function handleRedo() {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    historyIndexRef.current += 1;
    setMessage(historyRef.current[historyIndexRef.current]);
  }

  // Shared plumbing for every toolbar button: read the textarea's current
  // value/selection, let the caller build the next value + where the
  // cursor should land, commit it, then restore focus and selection (the
  // re-render from commitMessage briefly steals both).
  function applyToTextarea(
    build: (value: string, start: number, end: number) => { next: string; selStart: number; selEnd: number },
  ) {
    const textarea = messageRef.current;
    if (!textarea) return;
    const { value, selectionStart, selectionEnd } = textarea;
    const { next, selStart, selEnd } = build(value, selectionStart, selectionEnd);
    commitMessage(next, { immediate: true });
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(selStart, selEnd);
    });
  }

  // Prefixes every line touched by the current selection (or just the
  // current line) — used for bullets, numbering, and indent. These prefixes
  // are inserted as plain characters, not a markup token, so they read fine
  // as-is anywhere the message is shown without needing to be parsed back.
  function prefixLines(makePrefix: (lineIndex: number) => string) {
    applyToTextarea((value, start, end) => {
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      const searchFrom = Math.max(end - 1, lineStart);
      const nextBreak = value.indexOf("\n", searchFrom);
      const blockEnd = nextBreak === -1 ? value.length : nextBreak;

      const block = value.slice(lineStart, blockEnd);
      const lines = block.split("\n");
      const prefixed = lines.map((line, i) => `${makePrefix(i)}${line}`).join("\n");
      const next = value.slice(0, lineStart) + prefixed + value.slice(blockEnd);
      const delta = prefixed.length - block.length;
      return { next, selStart: start + makePrefix(0).length, selEnd: end + delta };
    });
  }

  function insertLink() {
    const textarea = messageRef.current;
    const selected = textarea ? textarea.value.slice(textarea.selectionStart, textarea.selectionEnd) : "";
    const url = window.prompt("Link URL");
    if (!url) return;
    const text = selected || window.prompt("Link text", url) || url;
    applyToTextarea((value, start, end) => {
      const token = `[${text}](${url})`;
      const next = value.slice(0, start) + token + value.slice(end);
      const pos = start + token.length;
      return { next, selStart: pos, selEnd: pos };
    });
  }

  function insertImage() {
    imageInputRef.current?.click();
  }

  // Embeds the picked file as a data: URI directly in the message — same
  // base64-in-the-record pattern the leave-request attachment flow already
  // uses (backend/src/modules/leave/leave.service.ts), so no separate file
  // storage/upload endpoint is needed for something this small.
  function handleImageFileSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    if (file.size > MAX_IMAGE_BYTES) {
      setFormError("Image is too large. Please choose a file under 5MB.");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      applyToTextarea((value, start, end) => {
        const token = `![${file.name}](${dataUrl})`;
        const next = value.slice(0, start) + token + value.slice(end);
        const pos = start + token.length;
        return { next, selStart: pos, selEnd: pos };
      });
    };
    reader.readAsDataURL(file);
  }

  function toggleHeadingLine() {
    applyToTextarea((value, start, end) => {
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      const nextBreak = value.indexOf("\n", start);
      const lineEnd = nextBreak === -1 ? value.length : nextBreak;
      const line = value.slice(lineStart, lineEnd);
      const isHeading = line.startsWith("# ");
      const nextLine = isHeading ? line.slice(2) : `# ${line}`;
      const next = value.slice(0, lineStart) + nextLine + value.slice(lineEnd);
      const delta = nextLine.length - line.length;
      return { next, selStart: start + delta, selEnd: end + delta };
    });
  }

  function updateHeadingState() {
    const textarea = messageRef.current;
    if (!textarea) return;
    const value = textarea.value;
    const lineStart = value.lastIndexOf("\n", textarea.selectionStart - 1) + 1;
    setIsHeadingLine(value.slice(lineStart, lineStart + 2) === "# ");
  }

  function targetLabel(announcement: {
    targetDepartmentIds: string[];
    targetSupervisorsOnly?: boolean;
    targetEmployeeIds?: string[];
  }) {
    const parts: string[] = [];
    if (announcement.targetDepartmentIds.length) {
      parts.push(...announcement.targetDepartmentIds.map((id) => departmentNameById.get(id) ?? "Unknown"));
    }
    if (announcement.targetSupervisorsOnly) parts.push("Supervisors");
    if (announcement.targetEmployeeIds?.length) {
      parts.push(`${announcement.targetEmployeeIds.length} specific employee${announcement.targetEmployeeIds.length === 1 ? "" : "s"}`);
    }
    return parts.length === 0 ? "All Employees" : parts.join(", ");
  }

  const hasAnyRecipients =
    allEmployees || selectedDepartmentIds.size > 0 || targetSupervisorsOnly || selectedEmployeeIds.size > 0;

  const visibleAnnouncements = useMemo(
    () =>
      announcements.filter((announcement) => {
        if (search.trim() && !announcement.title.toLowerCase().includes(search.trim().toLowerCase())) return false;
        const sentDate = announcement.createdAt.slice(0, 10);
        if (dateFrom && sentDate < dateFrom) return false;
        if (dateTo && sentDate > dateTo) return false;
        return true;
      }),
    [announcements, search, dateFrom, dateTo],
  );

  const pageCount = Math.max(1, Math.ceil(visibleAnnouncements.length / PAGE_SIZE));
  const pagedAnnouncements = visibleAnnouncements.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const openCreateForm = () => {
    setEditingId(null);
    setTitle("");
    setMessage("");
    resetHistory("");
    setAllEmployees(false);
    setSelectedDepartmentIds(new Set());
    setTargetSupervisorsOnly(false);
    setSelectedEmployeeIds(new Set());
    setEmployeeSearch("");
    setPriority("STANDARD");
    setFormError(null);
    setScheduledAtInput("");
    setShowSchedulePicker(false);
    setFormOpen(true);
  };

  // Re-opens the compose modal pre-filled with an existing DRAFT/SCHEDULED
  // announcement — the same modal handles both "start fresh" and "keep
  // working on this one" (PATCH instead of POST on save, see editingId).
  const openEditForm = (announcement: AnnouncementListItem) => {
    setEditingId(announcement.id);
    setTitle(announcement.title);
    setMessage(announcement.message);
    resetHistory(announcement.message);
    const isAllEmployees =
      announcement.targetDepartmentIds.length === 0 &&
      !announcement.targetSupervisorsOnly &&
      announcement.targetEmployeeIds.length === 0;
    setAllEmployees(isAllEmployees);
    setSelectedDepartmentIds(new Set(announcement.targetDepartmentIds));
    setTargetSupervisorsOnly(announcement.targetSupervisorsOnly);
    setSelectedEmployeeIds(new Set(announcement.targetEmployeeIds));
    setEmployeeSearch("");
    setPriority("STANDARD");
    setFormError(null);
    setScheduledAtInput(announcement.scheduledAt ? toDatetimeLocalValue(announcement.scheduledAt) : "");
    setShowSchedulePicker(false);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setFormError(null);
    setShowSchedulePicker(false);
  };

  function recipientsPayload() {
    return {
      targetDepartmentIds: allEmployees ? [] : Array.from(selectedDepartmentIds),
      targetSupervisorsOnly: allEmployees ? false : targetSupervisorsOnly,
      targetEmployeeIds: allEmployees ? [] : Array.from(selectedEmployeeIds),
    };
  }

  function saveAnnouncement(body: Record<string, unknown>) {
    return editingId
      ? apiRequest<AnnouncementListItem>(`/announcements/${editingId}`, { method: "PATCH", body: JSON.stringify(body) })
      : apiRequest<AnnouncementListItem>("/announcements", { method: "POST", body: JSON.stringify(body) });
  }

  const submitForm = async () => {
    const trimmedTitle = title.trim();
    const trimmedMessage = message.trim();
    if (!trimmedTitle || !trimmedMessage) {
      setFormError("Title and message are both required.");
      return;
    }
    if (!hasAnyRecipients) {
      setFormError("Select at least one recipient, or choose All Employees.");
      return;
    }

    setIsSaving(true);
    setFormError(null);
    try {
      const published = await saveAnnouncement({
        title: trimmedTitle,
        message: trimmedMessage,
        status: "PUBLISHED",
        ...recipientsPayload(),
      });
      closeForm();
      loadAnnouncements();
      notify({
        type: "success",
        message: `Announcement sent to ${published.recipientCount} employee${published.recipientCount === 1 ? "" : "s"}.`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to send announcement.";
      setFormError(msg);
    } finally {
      setIsSaving(false);
    }
  };

  const saveDraft = async () => {
    const trimmedTitle = title.trim();
    const trimmedMessage = message.trim();
    if (!trimmedTitle && !trimmedMessage) {
      setFormError("Add a title or message before saving a draft.");
      return;
    }

    setIsSavingDraft(true);
    setFormError(null);
    try {
      await saveAnnouncement({
        title: trimmedTitle,
        message: trimmedMessage,
        status: "DRAFT",
        ...recipientsPayload(),
      });
      closeForm();
      loadAnnouncements();
      notify({ type: "success", message: "Draft saved." });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save draft.");
    } finally {
      setIsSavingDraft(false);
    }
  };

  function openSchedulePicker() {
    if (!title.trim() || !message.trim()) {
      setFormError("Title and message are both required.");
      return;
    }
    if (!hasAnyRecipients) {
      setFormError("Select at least one recipient, or choose All Employees.");
      return;
    }
    setFormError(null);
    setShowSchedulePicker(true);
  }

  const confirmSchedule = async () => {
    if (!scheduledAtInput) {
      setFormError("Pick a date and time to schedule this announcement.");
      return;
    }
    const scheduledDate = new Date(scheduledAtInput);
    if (scheduledDate.getTime() <= Date.now()) {
      setFormError("Scheduled time must be in the future.");
      return;
    }

    setIsScheduling(true);
    setFormError(null);
    try {
      await saveAnnouncement({
        title: title.trim(),
        message: message.trim(),
        status: "SCHEDULED",
        scheduledAt: scheduledDate.toISOString(),
        ...recipientsPayload(),
      });
      setShowSchedulePicker(false);
      closeForm();
      loadAnnouncements();
      notify({
        type: "success",
        message: `Announcement scheduled for ${formatDateTime(scheduledDate.toISOString())}.`,
      });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to schedule announcement.");
    } finally {
      setIsScheduling(false);
    }
  };

  async function deleteAnnouncement(id: string) {
    if (!window.confirm("Delete this announcement? This cannot be undone.")) return;
    try {
      await apiRequest(`/announcements/${id}`, { method: "DELETE" });
      loadAnnouncements();
      notify({ type: "success", message: "Announcement deleted." });
    } catch (err) {
      notify({ type: "error", message: err instanceof Error ? err.message : "Failed to delete announcement." });
    }
  }

  async function archiveAnnouncement(id: string) {
    try {
      await apiRequest(`/announcements/${id}/archive`, { method: "PATCH" });
      setViewId(null);
      loadAnnouncements();
      notify({ type: "success", message: "Announcement archived." });
    } catch (err) {
      notify({ type: "error", message: err instanceof Error ? err.message : "Failed to archive announcement." });
    }
  }

  async function unarchiveAnnouncement(id: string) {
    try {
      await apiRequest(`/announcements/${id}/unarchive`, { method: "PATCH" });
      setViewId(null);
      loadAnnouncements();
      notify({ type: "success", message: "Announcement unarchived." });
    } catch (err) {
      notify({ type: "error", message: err instanceof Error ? err.message : "Failed to unarchive announcement." });
    }
  }

  return (
    <>
      <div className="filter-tabs announcement-archive-tabs">
        <button className={!showArchived ? "active" : ""} onClick={() => setShowArchived(false)}>
          Active
        </button>
        <button className={showArchived ? "active" : ""} onClick={() => setShowArchived(true)}>
          Archived
        </button>
      </div>

      <div className="employees-filter-bar">
        <div className="employees-filter-group employees-filter-search-group">
          <label className="employees-filter-label">Search</label>
          <div className="employee-search">
            <Search size={14} className="employee-search-icon" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search announcements..."
              aria-label="Search announcements by title"
            />
            <button type="button" className="employee-search-clear" onClick={() => setSearch("")} aria-label="Clear search">
              <X size={13} />
            </button>
          </div>
        </div>

        <div className="employees-filter-group">
          <label className="employees-filter-label">Date</label>
          <DropdownFilter
            className="announcement-date-filter"
            value={dateFilterPreset}
            onChange={(value) => applyDateFilterPreset(value as DateFilterPreset)}
            options={DATE_FILTER_OPTIONS}
            allLabel="Any time"
            allValue="ALL"
            menuLabel="Filter by date"
            ariaLabel="Filter announcements by sent date"
          />
        </div>

        {dateFilterPreset === "CUSTOM" && (
          <>
            <div className="employees-filter-group announcement-filter-date-group">
              <label className="employees-filter-label">From</label>
              <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} aria-label="Sent from date" />
            </div>
            <div className="employees-filter-group announcement-filter-date-group">
              <label className="employees-filter-label">To</label>
              <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} aria-label="Sent to date" />
            </div>
          </>
        )}

        <div className="employees-filter-actions">
          {canManage && (
            <button className="add-employee-button" onClick={openCreateForm}>
              <SquarePen size={15} /> New Announcement
            </button>
          )}
        </div>
      </div>

      <section className="table-card utilities-table-card">
        <div className="utilities-table-scroll">
          <table>
            <thead>
              <tr>
                <th>TITLE</th>
                <th>STATUS</th>
                <th>TARGET</th>
                <th>RECIPIENTS</th>
                <th>VIEWED</th>
                <th>ACTION</th>
              </tr>
            </thead>
            <tbody>
              {pagedAnnouncements.length === 0 ? (
                <tr>
                  <td colSpan={6} className="utilities-empty-state">
                    {announcements.length === 0 ? (
                      <div className="utilities-empty-block">
                        <Megaphone size={28} />
                        <p>{showArchived ? "No archived announcements." : "No announcements have been sent yet."}</p>
                      </div>
                    ) : (
                      "No announcements match your current search."
                    )}
                  </td>
                </tr>
              ) : (
                pagedAnnouncements.map((announcement) => (
                  <tr key={announcement.id}>
                    <td data-label="Title">{announcement.title || "(no subject)"}</td>
                    <td data-label="Status">
                      {announcement.status === "PUBLISHED" && (
                        <Badge tone="success">{`Sent ${formatDateTime(announcement.publishedAt ?? announcement.createdAt)}`}</Badge>
                      )}
                      {announcement.status === "SCHEDULED" && (
                        <Badge tone="warning">{`Scheduled ${formatDateTime(announcement.scheduledAt!)}`}</Badge>
                      )}
                      {announcement.status === "DRAFT" && <Badge tone="neutral">Draft</Badge>}
                    </td>
                    <td data-label="Target">{targetLabel(announcement)}</td>
                    <td data-label="Recipients">{announcement.recipientCount}</td>
                    <td data-label="Viewed">
                      <Badge tone={announcement.viewedCount === announcement.recipientCount && announcement.recipientCount > 0 ? "success" : "neutral"}>
                        {`${announcement.viewedCount} / ${announcement.recipientCount}`}
                      </Badge>
                    </td>
                    <td data-label="Actions">
                      {announcement.status === "PUBLISHED" ? (
                        <button type="button" className="utilities-view-button" onClick={() => setViewId(announcement.id)}>
                          <Eye size={13} /> View
                        </button>
                      ) : (
                        canManage && (
                          <div className="utilities-row-actions">
                            <button type="button" className="utilities-view-button" onClick={() => openEditForm(announcement)}>
                              <SquarePen size={13} /> Edit
                            </button>
                            <button
                              type="button"
                              className="utilities-view-button utilities-view-button--danger"
                              onClick={() => deleteAnnouncement(announcement.id)}
                            >
                              <Trash2 size={13} /> Delete
                            </button>
                          </div>
                        )
                      )}
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

      {/* ── New Announcement modal ── */}
      {formOpen && (
        <div className="utilities-modal-backdrop" role="presentation">
          <section className="announcement-compose-modal" role="dialog" aria-modal="true" aria-labelledby="announcement-form-title">
            <div className="announcement-compose-header">
              <h2 id="announcement-form-title">{editingId ? "Edit Announcement" : "Compose Announcement"}</h2>
              <button className="icon-button" onClick={closeForm} aria-label="Close">
                <X size={18} />
              </button>
            </div>

            <div className="announcement-compose-body">
              <div className="announcement-compose-row">
                <span className="announcement-compose-row-label">To</span>
                <div className="announcement-compose-row-content">
                  <MultiSelectDropdown
                    className="announcement-department-select"
                    values={recipientValues}
                    onChange={handleRecipientsChange}
                    options={recipientOptions}
                    placeholder="Select recipients…"
                    menuLabel="Recipients"
                    ariaLabel="Select announcement recipients"
                  />

                  {!allEmployees && (
                    <div className="announcement-employee-picker">
                      {targetSupervisorsOnly && (
                        <span className="announcement-employee-chip">
                          Supervisors
                          <button
                            type="button"
                            onClick={() => setTargetSupervisorsOnly(false)}
                            aria-label="Remove Supervisors"
                          >
                            <X size={11} />
                          </button>
                        </span>
                      )}
                      {Array.from(selectedDepartmentIds).map((id) => (
                        <span key={id} className="announcement-employee-chip">
                          {departmentNameById.get(id) ?? "Unknown department"}
                          <button
                            type="button"
                            onClick={() => removeDepartment(id)}
                            aria-label={`Remove ${departmentNameById.get(id) ?? "department"}`}
                          >
                            <X size={11} />
                          </button>
                        </span>
                      ))}
                      {selectedEmployees.map((employee) => (
                        <span key={employee.id} className="announcement-employee-chip">
                          {employee.firstName} {employee.lastName}
                          <button
                            type="button"
                            onClick={() => removeEmployee(employee.id)}
                            aria-label={`Remove ${employee.firstName} ${employee.lastName}`}
                          >
                            <X size={11} />
                          </button>
                        </span>
                      ))}
                      <div className="announcement-employee-search-wrap">
                        <input
                          type="text"
                          value={employeeSearch}
                          onChange={(e) => setEmployeeSearch(e.target.value)}
                          placeholder="Add a specific employee…"
                          className="announcement-employee-search-input"
                        />
                        {employeeSearchResults.length > 0 && (
                          <div className="announcement-employee-suggestions">
                            {employeeSearchResults.map((employee) => (
                              <button
                                key={employee.id}
                                type="button"
                                className="announcement-employee-suggestion"
                                onClick={() => addEmployee(employee.id)}
                              >
                                <span>{employee.firstName} {employee.lastName}</span>
                                {employee.department?.name && <small>{employee.department.name}</small>}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="announcement-compose-row">
                <span className="announcement-compose-row-label">Subject</span>
                <input
                  className="announcement-compose-subject-input"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Office closure on Dec 25"
                  autoFocus
                />
              </div>

              <div className="announcement-compose-toolbar" role="toolbar" aria-label="Formatting">
                <button type="button" className="announcement-toolbar-body-select" onClick={toggleHeadingLine}>
                  {isHeadingLine ? "Heading" : "Body"} <ChevronDown size={13} />
                </button>
                <span className="announcement-toolbar-divider" />
                <button type="button" aria-label="Bulleted list" onClick={() => prefixLines(() => "• ")}><List size={15} /></button>
                <button type="button" aria-label="Numbered list" onClick={() => prefixLines((i) => `${i + 1}. `)}><ListOrdered size={15} /></button>
                <button type="button" aria-label="Insert link" onClick={insertLink}><Link2 size={15} /></button>
                <button type="button" aria-label="Insert image" onClick={insertImage}><ImageIcon size={15} /></button>
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleImageFileSelected}
                  style={{ display: "none" }}
                />
                <button type="button" aria-label="Indent" onClick={() => prefixLines(() => "\t")}><IndentIncrease size={15} /></button>
                <span className="announcement-toolbar-divider" />
                <button type="button" aria-label="Undo" onClick={handleUndo}><Undo2 size={15} /></button>
                <button type="button" aria-label="Redo" onClick={handleRedo}><Redo2 size={15} /></button>
              </div>

              <textarea
                ref={messageRef}
                className="announcement-compose-message"
                value={message}
                onChange={(e) => commitMessage(e.target.value)}
                onSelect={updateHeadingState}
                onClick={updateHeadingState}
                onKeyUp={updateHeadingState}
                placeholder="Content composition here..."
              />

              <div className="announcement-compose-row announcement-priority-row">
                <span className="announcement-compose-row-label">Priority</span>
                <div className="announcement-priority-options">
                  {PRIORITY_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={`announcement-priority-tag announcement-priority-tag--${option.value.toLowerCase()} ${priority === option.value ? "active" : ""}`}
                      onClick={() => setPriority(option.value)}
                      aria-pressed={priority === option.value}
                    >
                      {option.value === "PINNED" ? <Pin size={12} /> : <Flag size={12} />}
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              {formError && <p className="employee-form-error announcement-compose-error">{formError}</p>}
            </div>

            <div className="announcement-publish-controls">
              <span className="announcement-compose-row-label">Publish Controls</span>
              <div className="announcement-publish-actions">
                <button type="button" className="outline-button" onClick={saveDraft} disabled={isSavingDraft}>
                  {isSavingDraft ? "Saving…" : "Save Draft"}
                </button>
                <div className="announcement-schedule-wrap">
                  <button type="button" className="outline-button" onClick={openSchedulePicker}>
                    <CalendarClock size={13} /> Schedule
                  </button>
                  {showSchedulePicker && (
                    <div className="announcement-schedule-popover" role="dialog" aria-label="Schedule announcement">
                      <label htmlFor="announcement-schedule-input">Send on</label>
                      <input
                        id="announcement-schedule-input"
                        type="datetime-local"
                        value={scheduledAtInput}
                        min={toDatetimeLocalValue(new Date(Date.now() + 60000).toISOString())}
                        onChange={(e) => setScheduledAtInput(e.target.value)}
                      />
                      <div className="announcement-schedule-popover-actions">
                        <button type="button" className="outline-button" onClick={() => setShowSchedulePicker(false)}>
                          Cancel
                        </button>
                        <button type="button" className="announcement-send-button" onClick={confirmSchedule} disabled={isScheduling}>
                          {isScheduling ? "Scheduling…" : "Confirm"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                <button
                  className="announcement-send-button"
                  onClick={submitForm}
                  disabled={isSaving || !title.trim() || !message.trim() || !hasAnyRecipients}
                >
                  {isSaving ? "Publishing…" : "Send"}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}

      {/* ── View Announcement modal ── */}
      {viewId && (
        <div className="utilities-modal-backdrop" role="presentation">
          <section className="utilities-modal utilities-modal--view" role="dialog" aria-modal="true" aria-labelledby="view-announcement-title">
            <div className="utilities-modal-header">
              <div>
                <h2 id="view-announcement-title">{viewDetail?.title || "(no subject)"}</h2>
                {viewDetail && (
                  <p>
                    Sent {formatDateTime(viewDetail.publishedAt ?? viewDetail.createdAt)} by {creatorName(viewDetail.createdBy)}
                  </p>
                )}
              </div>
              <button className="icon-button" onClick={() => setViewId(null)} aria-label="Close">
                <X size={18} />
              </button>
            </div>

            <div className="utilities-modal-body">
              {isViewLoading || !viewDetail ? (
                <p className="employee-form-hint">Loading announcement…</p>
              ) : (
                <>
                  <div className="announcement-view-message">{renderFormattedText(viewDetail.message)}</div>

                  <div className="utilities-audit-detail-grid">
                    <div>
                      <span>Target</span>
                      <strong>{targetLabel(viewDetail)}</strong>
                    </div>
                    <div>
                      <span>Targeted / Delivered</span>
                      <strong>{viewDetail.recipientCount} / {viewDetail.deliveredCount}</strong>
                    </div>
                    <div>
                      <span>Viewed</span>
                      <strong>{viewDetail.viewedCount}</strong>
                    </div>
                    <div>
                      <span>Not Viewed</span>
                      <strong>{viewDetail.notViewedCount}</strong>
                    </div>
                  </div>

                  <div className="announcement-recipient-list">
                    <p className="employee-leave-grants-title">Recipients</p>
                    {viewDetail.recipients.length === 0 ? (
                      <p className="employee-form-hint">No employees were targeted by this announcement.</p>
                    ) : (
                      viewDetail.recipients.map((recipient, index) => (
                        <div key={index} className="announcement-recipient-row">
                          <div>
                            <strong>{recipient.firstName} {recipient.lastName}</strong>
                            <span>{recipient.department}</span>
                          </div>
                          {recipient.viewedAt ? (
                            <span className="announcement-recipient-viewed">
                              <CheckCircle2 size={13} /> Viewed {formatDateTime(recipient.viewedAt)}
                            </span>
                          ) : (
                            <span className="announcement-recipient-unviewed">Not viewed</span>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </>
              )}
            </div>

            <div className="utilities-modal-actions">
              {canManage && viewDetail && (
                viewDetail.archivedAt ? (
                  <button className="outline-button" onClick={() => unarchiveAnnouncement(viewDetail.id)}>
                    <ArchiveRestore size={13} /> Unarchive
                  </button>
                ) : (
                  <button className="outline-button outline-button--danger" onClick={() => archiveAnnouncement(viewDetail.id)}>
                    <Archive size={13} /> Archive
                  </button>
                )
              )}
              <button className="outline-button" onClick={() => setViewId(null)}>
                Close
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
