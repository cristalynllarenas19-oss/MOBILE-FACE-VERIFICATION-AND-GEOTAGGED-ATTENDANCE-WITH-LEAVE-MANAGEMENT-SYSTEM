// Download / Print DTR — builds the employee's monthly Daily Time Record as
// a printable A4 document and either prints it (Android print service /
// AirPrint), or saves it as a PDF to a folder the employee picks.
// Same expo-print + expo-sharing approach as reportExport.ts, so nothing
// here needs a native module the installed APK doesn't already have.
import { Platform } from "react-native";
import { File, Paths } from "expo-file-system";
import { EncodingType, StorageAccessFramework } from "expo-file-system/legacy";
import * as Print from "expo-print";
import * as SecureStore from "expo-secure-store";
import * as Sharing from "expo-sharing";
import type { MonthlyDtr, MonthlyDtrRow } from "../api";
import { loadLogoDataUri } from "./reportExport";

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// A4 portrait in points (expo-print's "pixels" are 1/72 in).
const A4 = { width: 595, height: 842 };

// The folder the employee granted on their first download, so every later
// download goes straight there instead of asking again.
const SAVE_DIR_KEY = "dtrSaveDirectoryUri";

const STATUS_LABELS: Record<string, string> = {
  PRESENT: "Present",
  LATE: "Late",
  ABSENT: "Absent",
  ON_LEAVE: "On Leave",
  LEAVE_PENDING: "Leave Pending",
  PENDING_REVIEW: "Pending Review",
  FLAGGED: "Pending Review",
};

export function dtrStatusLabel(status: string) {
  return STATUS_LABELS[status] ?? status;
}

function escapeHtml(value: string | number) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatDtrTime(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function formatMinutes(totalMinutes: number) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

// Hours are only shown for a record with both a time in and a time out —
// totalMinutes is the server's own figure (breaks/shift rules already
// applied at time-out); an open or missing punch never gets an hour count.
export function isCompleteRow(row: MonthlyDtrRow) {
  return Boolean(row.timeInAt && row.timeOutAt);
}

export function dtrHoursLabel(row: MonthlyDtrRow) {
  if (!isCompleteRow(row)) return "—";
  return formatMinutes(row.totalMinutes ?? 0);
}

export function dtrTotalMinutes(dtr: MonthlyDtr) {
  return dtr.rows.reduce((sum, row) => sum + (isCompleteRow(row) ? row.totalMinutes ?? 0 : 0), 0);
}

export function dtrTotalHoursLabel(dtr: MonthlyDtr) {
  return formatMinutes(dtrTotalMinutes(dtr));
}

function isToday(value: string) {
  const d = new Date(value);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

// Facts only, taken from the record itself.
export function dtrRemarks(row: MonthlyDtrRow) {
  const parts: string[] = [];
  if (row.recordType === "FIELD") {
    parts.push(`Visit ${row.visitNumber ?? 1}${row.workLocation?.name ? ` · ${row.workLocation.name}` : ""}`);
  }
  if (row.status === "ON_LEAVE") parts.push(row.leaveTypeName ? `${row.leaveTypeName} (approved)` : "Approved leave");
  if (row.status === "LEAVE_PENDING") parts.push(`${row.leaveTypeName ?? "Leave"} awaiting approval`);
  if (row.status === "ABSENT" && row.isSynthetic) parts.push("No time in/out recorded");
  if (row.status === "PENDING_REVIEW") parts.push("Under review");
  if (row.timeInAt && !row.timeOutAt) parts.push(isToday(row.attendanceDate) ? "In progress" : "No time out recorded");
  if (!row.timeInAt && row.timeOutAt) parts.push("No time in recorded");
  if (row.lateMinutes) parts.push(`Late ${formatMinutes(row.lateMinutes)}`);
  if (row.hasApprovedUndertime) parts.push("Approved undertime");
  else if (row.timeOutAt && row.undertimeMinutes) parts.push(`Early out ${formatMinutes(row.undertimeMinutes)}`);
  if (row.overtimeMinutes) parts.push(`OT ${formatMinutes(row.overtimeMinutes)}`);
  return parts.join("; ");
}

export function dtrFileName(dtr: MonthlyDtr) {
  const name = `${dtr.employee.firstName}${dtr.employee.lastName}`.replace(/[^A-Za-z0-9]/g, "") || "Employee";
  return `DTR_${name}_${MONTH_NAMES[dtr.month - 1]}_${dtr.year}.pdf`;
}

function buildDtrHtml(dtr: MonthlyDtr, logoDataUri: string | null) {
  const period = `${MONTH_NAMES[dtr.month - 1]} ${dtr.year}`;
  const prepared = new Date(dtr.generatedAt).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const info: [string, string | null][] = [
    ["Employee ID", dtr.employee.employeeNo],
    ["Employee Name", dtr.employee.name],
    ["Department", dtr.employee.department],
    ["Position", dtr.employee.position],
    ["Employment Type", dtr.employee.employeeType],
    ["Period", period],
  ];
  const infoRows = [0, 2, 4]
    .map(
      (i) => `<tr>${[info[i], info[i + 1]]
        .map(([label, value]) => `<td class="lbl">${escapeHtml(label)}</td><td class="val">${escapeHtml(value || "—")}</td>`)
        .join("")}</tr>`,
    )
    .join("");

  const bodyRows = dtr.rows
    .map((row) => {
      const date = new Date(row.attendanceDate);
      return `<tr>
        <td>${escapeHtml(date.toLocaleDateString("en-US", { month: "short", day: "numeric" }))}</td>
        <td>${escapeHtml(date.toLocaleDateString("en-US", { weekday: "short" }))}</td>
        <td class="c">${escapeHtml(formatDtrTime(row.timeInAt))}</td>
        <td class="c">${escapeHtml(formatDtrTime(row.timeOutAt))}</td>
        <td class="c">${escapeHtml(dtrHoursLabel(row))}</td>
        <td>${escapeHtml(dtrStatusLabel(row.status))}</td>
        <td class="rmk">${escapeHtml(dtrRemarks(row))}</td>
      </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    @page { size: A4 portrait; margin: 36pt 32pt; }
    * { box-sizing: border-box; }
    body { font-family: Arial, Helvetica, sans-serif; color: #000; margin: 0; font-size: 9pt; }
    /* Same header as the Reports PDF (reportExport.ts): centered logo,
       title, one meta line, divider. */
    .head { text-align: center; padding-bottom: 12pt; border-bottom: 1pt solid #D7E2EC; margin-bottom: 14pt; }
    .logo { max-width: 140pt; max-height: 70pt; margin-bottom: 8pt; }
    .title { font-size: 16pt; font-weight: 700; color: #1A3A5C; margin: 0 0 4pt; }
    .meta { font-size: 9pt; color: #2D4A65; margin: 0; }
    .info { width: 100%; border-collapse: collapse; margin-bottom: 12pt; }
    .info td { padding: 3pt 4pt; font-size: 9pt; vertical-align: top; }
    .info .lbl { width: 17%; font-weight: 700; white-space: nowrap; }
    .info .val { width: 33%; border-bottom: 0.75pt solid #000; }
    table.dtr { width: 100%; border-collapse: collapse; table-layout: fixed; }
    table.dtr thead { display: table-header-group; }
    table.dtr tr { page-break-inside: avoid; }
    table.dtr th, table.dtr td { border: 0.75pt solid #000; padding: 4pt 4pt; font-size: 8.5pt; text-align: center; vertical-align: middle; word-wrap: break-word; overflow-wrap: break-word; }
    table.dtr th { background: #E5E5E5; font-weight: 700; text-align: center; }
    .c { text-align: center; white-space: nowrap; }
    .rmk { font-size: 8pt; }
    .total td { font-weight: 700; }
    .empty { text-align: center; padding: 18pt 0; }
    .closing { page-break-inside: avoid; break-inside: avoid; }
    .sign { width: 100%; margin-top: 8pt; border-collapse: collapse; }
    .sign td { width: 50%; padding: 0 16pt; text-align: center; vertical-align: bottom; font-size: 9pt; }
    .line { border-top: 0.75pt solid #000; margin-top: 30pt; padding-top: 3pt; }
    .cert { font-size: 8.5pt; margin: 12pt 0 0; }
    .prepared { margin: 8pt 0 0; font-size: 9pt; }
  </style>
</head>
<body>
  <div class="head">
    ${logoDataUri ? `<img class="logo" src="${logoDataUri}" />` : ""}
    <p class="title">DAILY TIME RECORD</p>
    <p class="meta">Universal Leaf Philippines Inc. &nbsp;·&nbsp; ${escapeHtml(period)}</p>
  </div>
  <table class="info">${infoRows}</table>
  <table class="dtr">
    <colgroup>
      <col style="width:10%" /><col style="width:7%" /><col style="width:12%" /><col style="width:12%" />
      <col style="width:11%" /><col style="width:14%" /><col style="width:34%" />
    </colgroup>
    <thead>
      <tr><th>Date</th><th>Day</th><th>Time In</th><th>Time Out</th><th>Hours Worked</th><th>Status</th><th>Remarks</th></tr>
    </thead>
    <tbody>
      ${bodyRows || `<tr><td colspan="7" class="empty">No attendance records for this period.</td></tr>`}
      <tr class="total">
        <td colspan="4" style="text-align:right">Total Hours Worked (complete records only)</td>
        <td class="c">${escapeHtml(dtrTotalHoursLabel(dtr))}</td>
        <td colspan="2"></td>
      </tr>
    </tbody>
  </table>
  <div class="closing">
    <p class="cert">I certify on my honor that the above is a true and correct report of the hours of work performed, recorded through the e-TALA attendance system.</p>
    <p class="prepared"><strong>Date Prepared:</strong> ${escapeHtml(prepared)}</p>
    <table class="sign">
      <tr>
        <td><div class="line">${escapeHtml(dtr.employee.name)}<br />Employee Signature</div></td>
        <td><div class="line">Supervisor / Authorized Approver<br />Signature over Printed Name</div></td>
      </tr>
    </table>
  </div>
</body>
</html>`;
}

// Margins come from the HTML's @page rule (expo-print's own margins option
// is iOS-only and would stack on top of it there).
const PRINT_OPTIONS = { width: A4.width, height: A4.height };

async function renderPdf(dtr: MonthlyDtr) {
  const { uri } = await Print.printToFileAsync({ html: buildDtrHtml(dtr, await loadLogoDataUri()), ...PRINT_OPTIONS });
  // printToFileAsync names the file with a random id; give it the readable
  // DTR_Name_Month_Year.pdf name so a shared copy keeps it too.
  try {
    const named = new File(Paths.cache, dtrFileName(dtr));
    if (named.exists) named.delete();
    new File(uri).copy(named);
    return named.uri;
  } catch {
    return uri;
  }
}

// Opens the system print dialog, where the employee picks a printer or
// "Save as PDF".
export async function printDtr(dtr: MonthlyDtr) {
  await Print.printAsync({ html: buildDtrHtml(dtr, await loadLogoDataUri()), ...PRINT_OPTIONS });
}

// Hands a generated PDF to the share sheet — open it in a PDF viewer,
// send it on, or print from another app.
export async function shareDtrPdf(fileUri: string, title: string) {
  if (!(await Sharing.isAvailableAsync())) throw new Error("Sharing is not available on this device.");
  await Sharing.shareAsync(fileUri, { mimeType: "application/pdf", UTI: "com.adobe.pdf", dialogTitle: title });
}

export type SavedDtr = {
  // Readable copy in the app's cache — what Open/Share uses.
  cacheUri: string;
  fileName: string;
  // Where it landed on the device; null when only the share sheet was used
  // (iOS, or the employee closed the folder picker).
  savedTo: string | null;
};

async function writeToFolder(directoryUri: string, fileName: string, base64: string) {
  const target = await StorageAccessFramework.createFileAsync(directoryUri, fileName.replace(/\.pdf$/, ""), "application/pdf");
  await StorageAccessFramework.writeAsStringAsync(target, base64, { encoding: EncodingType.Base64 });
  return target;
}

function folderLabel(directoryUri: string) {
  // content://…/tree/primary%3ADownload → "Download"
  const decoded = decodeURIComponent(directoryUri);
  const tail = decoded.split(":").pop() ?? "";
  return tail.split("/").filter(Boolean).pop() || "the selected folder";
}

// Android: saves through the Storage Access Framework into a folder the
// employee picks once (e.g. Download) — needs no storage permission in the
// manifest and works on every Android version the app supports. The
// folder grant is remembered; if it's later revoked, it asks again.
export async function downloadDtrPdf(dtr: MonthlyDtr): Promise<SavedDtr> {
  const fileName = dtrFileName(dtr);
  const cacheUri = await renderPdf(dtr);

  if (Platform.OS !== "android") {
    await shareDtrPdf(cacheUri, fileName);
    return { cacheUri, fileName, savedTo: null };
  }

  const base64 = await new File(cacheUri).base64();
  const remembered = await SecureStore.getItemAsync(SAVE_DIR_KEY);
  if (remembered) {
    try {
      await writeToFolder(remembered, fileName, base64);
      return { cacheUri, fileName, savedTo: folderLabel(remembered) };
    } catch {
      await SecureStore.deleteItemAsync(SAVE_DIR_KEY);
    }
  }

  const permission = await StorageAccessFramework.requestDirectoryPermissionsAsync(
    StorageAccessFramework.getUriForDirectoryInRoot("Download"),
  );
  if (!permission.granted) {
    throw new Error("No folder was selected, so the PDF was not saved.");
  }
  await writeToFolder(permission.directoryUri, fileName, base64);
  await SecureStore.setItemAsync(SAVE_DIR_KEY, permission.directoryUri);
  return { cacheUri, fileName, savedTo: folderLabel(permission.directoryUri) };
}
