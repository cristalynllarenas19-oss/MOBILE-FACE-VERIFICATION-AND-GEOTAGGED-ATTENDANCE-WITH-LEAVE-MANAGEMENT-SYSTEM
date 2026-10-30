import { Asset } from "expo-asset";
import { File, Paths } from "expo-file-system";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";

// One table of a report: what admin-web's ReportsPage calls a "section" in
// its PDF export. The same sections feed the list on screen, so what the
// supervisor sees is exactly what prints.
export type ReportSection = {
  title: string;
  head: string[];
  rows: (string | number)[][];
};

export type ReportDocument = {
  title: string;
  // "Includes: DTR | Attendance | Leave ..." under the title of All Reports.
  subtitle?: string;
  // "Generated: 10/11/2026 to 10/11/2026"
  rangeLabel: string;
  departmentLabel?: string;
  sections: ReportSection[];
};

function escapeHtml(value: string | number) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The company logo as a data: URI. The print renderer runs outside the app
// bundle, so it cannot resolve a bundled asset path — the image has to
// travel inside the HTML itself. A report without its logo is still a
// report, so any failure here just leaves it out.
export async function loadLogoDataUri() {
  try {
    const asset = Asset.fromModule(require("../assets/unileaf-logo.png"));
    await asset.downloadAsync();
    if (!asset.localUri) return null;
    const base64 = await new File(asset.localUri).base64();
    return `data:image/png;base64,${base64}`;
  } catch {
    return null;
  }
}

// Same layout as admin-web's printed report and exported PDF: centered
// logo, the report type as the title, the generated range, then one striped
// navy-headed table per section on landscape A4.
function buildReportHtml(report: ReportDocument, logoDataUri: string | null) {
  const sections = report.sections.filter((section) => section.rows.length > 0);

  // "Dates Used" (three ranges per line, ", "-separated) as a three-column
  // grid, so the ranges line up from row to row.
  const cellHtml = (heading: string, cell: string | number) =>
    heading === "Dates Used" && cell !== "—"
      ? `<div class="dates-grid">${String(cell)
          .split(/\n|, /)
          .map((range) => `<span>${escapeHtml(range)}</span>`)
          .join("")}</div>`
      : escapeHtml(cell);

  const tables = sections
    .map(
      (section) => `
      <h2>${escapeHtml(section.title)} <span class="count">${section.rows.length}</span></h2>
      <table>
        <thead><tr>${section.head.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr></thead>
        <tbody>
          ${section.rows
            .map((row) => `<tr>${row.map((cell, col) => `<td>${cellHtml(section.head[col], cell)}</td>`).join("")}</tr>`)
            .join("")}
        </tbody>
      </table>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    @page { size: A4 landscape; margin: 28pt; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif; color: #1E293B; margin: 0; }
    .header { text-align: center; padding-bottom: 12pt; border-bottom: 1pt solid #D7E2EC; margin-bottom: 14pt; }
    .logo { max-width: 140pt; max-height: 70pt; margin-bottom: 8pt; }
    h1 { font-size: 16pt; color: #1A3A5C; margin: 0 0 4pt; }
    .subtitle { font-size: 8pt; color: #6B8299; margin: 0 0 4pt; }
    .meta { font-size: 9pt; color: #2D4A65; margin: 0; }
    h2 { font-size: 10pt; color: #1A3A5C; margin: 14pt 0 6pt; }
    .count { font-weight: 400; color: #6B8299; }
    table { width: 100%; border-collapse: collapse; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
    th { background: #1A3A5C; color: #FFFFFF; font-size: 8pt; font-weight: 700; text-align: left; padding: 5pt 6pt; }
    td { font-size: 8pt; padding: 5pt 6pt; vertical-align: top; white-space: pre-line; }
    .dates-grid { display: grid; grid-template-columns: repeat(3, auto); justify-content: start; column-gap: 10pt; white-space: nowrap; }
    tbody tr:nth-child(even) td { background: #F4F7FB; }
    .empty { text-align: center; font-size: 10pt; color: #6B8299; padding: 30pt 0; }
  </style>
</head>
<body>
  <div class="header">
    ${logoDataUri ? `<img class="logo" src="${logoDataUri}" />` : ""}
    <h1>${escapeHtml(report.title)}</h1>
    ${report.subtitle ? `<p class="subtitle">${escapeHtml(report.subtitle)}</p>` : ""}
    <p class="meta">${escapeHtml(report.rangeLabel)}${
      report.departmentLabel ? ` &nbsp;·&nbsp; ${escapeHtml(report.departmentLabel)}` : ""
    }</p>
  </div>
  ${tables || `<p class="empty">No records for this report and date range.</p>`}
</body>
</html>`;
}

async function renderHtml(report: ReportDocument) {
  return buildReportHtml(report, await loadLogoDataUri());
}

// Opens the system print dialog (AirPrint on iOS, the Android print
// service) with the report laid out for paper.
export async function printReport(report: ReportDocument) {
  await Print.printAsync({ html: await renderHtml(report), orientation: Print.Orientation.landscape });
}

// Renders the report to a PDF file and hands it to the share sheet, where
// it can be saved to Files/Drive, emailed, or sent on — the phone
// equivalent of admin-web's "Export PDF" save dialog.
export async function exportReportPdf(report: ReportDocument, fileName: string) {
  const { uri } = await Print.printToFileAsync({ html: await renderHtml(report) });

  // printToFileAsync names the file with a random id; give it the same
  // readable name admin-web downloads it under.
  let shareUri = uri;
  try {
    const named = new File(Paths.cache, fileName);
    if (named.exists) named.delete();
    new File(uri).copy(named);
    shareUri = named.uri;
  } catch {
    // Sharing the randomly named file still works.
  }

  if (!(await Sharing.isAvailableAsync())) {
    throw new Error("Sharing is not available on this device.");
  }
  await Sharing.shareAsync(shareUri, {
    mimeType: "application/pdf",
    UTI: "com.adobe.pdf",
    dialogTitle: report.title,
  });
}
