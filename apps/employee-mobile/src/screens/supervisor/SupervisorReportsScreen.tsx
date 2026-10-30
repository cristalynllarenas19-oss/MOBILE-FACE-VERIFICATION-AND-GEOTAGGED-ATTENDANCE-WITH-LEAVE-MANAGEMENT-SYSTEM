import React, { useMemo, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, SafeAreaView, ActivityIndicator, RefreshControl } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ReportsSummary, getReportsSummary } from "../../api";
import { useCachedData } from "../../utils/dataCache";
import { ReportDocument, ReportSection, exportReportPdf, printReport } from "../../utils/reportExport";
import StatusPill from "../../components/StatusPill";
import AestheticScrollView from "../../components/AestheticScrollView";
import CalendarPickerModal from "../../components/CalendarPickerModal";
import ResultModal, { ResultModalStatus } from "../../components/ResultModal";
import { ui } from "../../styles/ui";

type Props = {
  onClose: () => void;
  departmentName?: string;
};

// The same report types, in the same order, as admin-web's Reports page —
// "All" first.
type ReportTab = "ALL" | "attendance" | "leave" | "undertime" | "schedules" | "employees" | "leaveBalances";

const REPORT_TABS: { key: ReportTab; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "attendance", label: "DTR / Attendance" },
  { key: "leave", label: "Leave" },
  { key: "undertime", label: "Undertime" },
  { key: "schedules", label: "Schedules" },
  { key: "employees", label: "Employees" },
  { key: "leaveBalances", label: "Remaining Leave" },
];

const REPORT_TITLES: Record<ReportTab, string> = {
  ALL: "All Reports",
  attendance: "DTR / Attendance",
  leave: "Leave",
  undertime: "Undertime",
  schedules: "Schedules",
  employees: "List of Employees",
  leaveBalances: "Remaining Leave",
};

// "All Reports" alone doesn't say what's included, so the printed header
// spells it out — same line admin-web prints.
const ALL_REPORTS_INCLUDES = "DTR | Attendance | Leave | Undertime | Schedules";

const LEAVE_STATUS_FILTERS = ["PENDING", "APPROVED", "REJECTED", "CANCELLED", "LAPSED"] as const;
type LeaveStatusBucket = (typeof LEAVE_STATUS_FILTERS)[number];
const UNDERTIME_STATUS_FILTERS = ["PENDING", "APPROVED", "REJECTED"] as const;
type UndertimeStatus = (typeof UNDERTIME_STATUS_FILTERS)[number];

// How many rows of a section are drawn on screen. The export always carries
// every row; this only keeps a long range from rendering thousands of views.
const MAX_ROWS_ON_SCREEN = 60;

type Pill = { status: string; lapseReason?: string | null } | null;
// A report section plus, per row, the raw status behind its "Status" cell
// so the screen can draw the same colored pill the rest of the app uses.
type ScreenSection = ReportSection & { pills?: Pill[] };

function toDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseDateKey(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString();
}

function formatShortDate(value: string) {
  return parseDateKey(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatTime(value?: string | null, status?: string) {
  if (value) return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  // An absent day will never get a punch, so "Pending" would be misleading.
  return status === "ABSENT" ? "—" : "Pending";
}

function employeeName(row: { employee: { firstName: string; lastName: string } }) {
  return `${row.employee.firstName} ${row.employee.lastName}`;
}

// Matches on the employee's name, in either order, case-insensitively —
// same rule as admin-web's Reports search.
function matchesEmployeeSearch(person: { firstName: string; lastName: string }, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [`${person.firstName} ${person.lastName}`, `${person.lastName} ${person.firstName}`].some((name) =>
    name.toLowerCase().includes(needle),
  );
}

function formatSex(sex?: string | null) {
  if (sex === "MALE") return "Male";
  if (sex === "FEMALE") return "Female";
  return "—";
}

function formatEmploymentStatus(status?: string | null) {
  if (!status) return "Unspecified";
  return status
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// Each approved filing as "8/26/26-8/28/26" (a one-day leave too:
// "8/27/26-8/27/26"), oldest first.
function usedDateRanges(dates: { startDate: string; endDate: string }[]) {
  const short = (value: string) => {
    const d = new Date(value);
    return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(-2)}`;
  };
  return [...dates]
    .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime())
    .map((d) => `${short(d.startDate)}-${short(d.endDate)}`);
}

// Plain-text form for exports: three ranges per line.
function formatUsedDates(dates: { startDate: string; endDate: string }[]) {
  const ranges = usedDateRanges(dates);
  if (ranges.length === 0) return "—";
  const lines: string[] = [];
  for (let i = 0; i < ranges.length; i += 3) lines.push(ranges.slice(i, i + 3).join(", "));
  return lines.join("\n");
}

// Every leave status lands in exactly one filter, so the counts always add
// up to the total under "All".
function leaveStatusBucket(status: string): LeaveStatusBucket {
  if (status === "APPROVED" || status === "SUPERVISOR_APPROVED") return "APPROVED";
  if (status === "REJECTED" || status === "NEEDS_REVISION") return "REJECTED";
  if (status === "CANCELLED") return "CANCELLED";
  if (status === "LAPSED") return "LAPSED";
  // PENDING, plus an approved leave still awaiting a cancellation decision.
  return "PENDING";
}

// Same wording as the Leave pages — a lapsed request always says whether
// the employee came to work anyway or the days stand as absent.
function leaveStatusText(request: { status: string; lapseReason?: string | null }) {
  if (request.status === "LAPSED") {
    return request.lapseReason === "REPORTED_FOR_WORK" ? "LAPSED - REPORTED TO WORK" : "LAPSED - ABSENT";
  }
  if (request.status === "CANCELLATION_PENDING") return "PENDING CANCELLATION";
  return request.status.replace(/_/g, " ");
}

function startOfDay(key: string) {
  return key ? parseDateKey(key).getTime() : -Infinity;
}

function endOfDay(key: string) {
  return key ? parseDateKey(key).getTime() + 86_399_999 : Infinity;
}

function isInDateRange(dateStr: string, from: string, to: string) {
  const time = new Date(dateStr).getTime();
  return time >= startOfDay(from) && time <= endOfDay(to);
}

function titleCase(value: string) {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

export default function SupervisorReportsScreen({ onClose, departmentName }: Props) {
  const today = toDateKey(new Date());

  const [tab, setTab] = useState<ReportTab>("ALL");
  // Both default to today, like admin-web: a same-day range is what lets
  // the backend rebuild Absent / On Leave rows, so today's report shows
  // real statuses instead of only the employees who already have a record.
  const [dateFrom, setDateFrom] = useState(today);
  const [dateTo, setDateTo] = useState(today);
  const [pickingDate, setPickingDate] = useState<"from" | "to" | null>(null);
  // Like the status filters, this also narrows what prints and exports.
  const [search, setSearch] = useState("");
  const [leaveStatusFilter, setLeaveStatusFilter] = useState<"ALL" | LeaveStatusBucket>("ALL");
  const [undertimeStatusFilter, setUndertimeStatusFilter] = useState<"ALL" | UndertimeStatus>("ALL");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [exporting, setExporting] = useState<"print" | "pdf" | null>(null);
  const [resultModal, setResultModal] = useState<{ status: ResultModalStatus; title: string; message: string } | null>(
    null,
  );

  const { data, isLoading, refresh } = useCachedData<ReportsSummary>(
    `team-reports:${dateFrom || "any"}:${dateTo || "any"}`,
    () => getReportsSummary({ ...(dateFrom ? { from: dateFrom } : {}), ...(dateTo ? { to: dateTo } : {}) }),
  );

  // --- The same client-side passes admin-web makes over the payload ---
  const attendance = useMemo(
    () =>
      (data?.attendance ?? []).filter(
        (record) =>
          isInDateRange(record.attendanceDate, dateFrom, dateTo) && matchesEmployeeSearch(record.employee, search),
      ),
    [data, dateFrom, dateTo, search],
  );

  // A leave counts if it overlaps the range at all.
  const leavesInRange = useMemo(
    () =>
      (data?.leaves ?? []).filter(
        (request) =>
          new Date(request.startDate).getTime() <= endOfDay(dateTo) &&
          new Date(request.endDate).getTime() >= startOfDay(dateFrom) &&
          matchesEmployeeSearch(request.employee, search),
      ),
    [data, dateFrom, dateTo, search],
  );
  const leaves = useMemo(
    () =>
      leaveStatusFilter === "ALL"
        ? leavesInRange
        : leavesInRange.filter((request) => leaveStatusBucket(request.status) === leaveStatusFilter),
    [leavesInRange, leaveStatusFilter],
  );

  const undertimeInRange = useMemo(
    () =>
      (data?.undertime ?? []).filter(
        (filing) =>
          isInDateRange(filing.attendanceRecord.attendanceDate, dateFrom, dateTo) &&
          matchesEmployeeSearch(filing.employee, search),
      ),
    [data, dateFrom, dateTo, search],
  );
  const undertime = useMemo(
    () =>
      undertimeStatusFilter === "ALL"
        ? undertimeInRange
        : undertimeInRange.filter((filing) => filing.status === undertimeStatusFilter),
    [undertimeInRange, undertimeStatusFilter],
  );

  // A schedule counts while it is in effect at any point of the range.
  const schedules = useMemo(
    () =>
      (data?.schedules ?? []).filter(
        (schedule) =>
          new Date(schedule.startsOn).getTime() <= endOfDay(dateTo) &&
          (!schedule.endsOn || new Date(schedule.endsOn).getTime() >= startOfDay(dateFrom)) &&
          matchesEmployeeSearch(schedule.employee, search),
      ),
    [data, dateFrom, dateTo, search],
  );

  // The directory and leave balances are point-in-time snapshots, not
  // bounded by the date range.
  const employees = useMemo(
    () => (data?.employees ?? []).filter((employee) => matchesEmployeeSearch(employee, search)),
    [data, search],
  );
  const leaveBalances = useMemo(
    () => (data?.leaveBalances ?? []).filter((balance) => matchesEmployeeSearch(balance.employee, search)),
    [data, search],
  );

  const sections = useMemo<ScreenSection[]>(() => {
    const attendanceSection: ScreenSection = {
      title: "DTR / Attendance",
      head: ["Employee", "Department", "Site", "Date", "Time In", "Time Out", "Lunch / Break", "Status"],
      rows: attendance.map((r) => [
        employeeName(r),
        r.employee.department.name,
        r.workLocation?.name ?? "—",
        formatDate(r.attendanceDate),
        formatTime(r.timeInAt, r.status),
        formatTime(r.timeOutAt, r.status),
        r.lunchOutAt
          ? `${r.breakKind === "BREAK" ? "Break " : ""}${formatTime(r.lunchOutAt)} - ${formatTime(r.lunchInAt)}`
          : "—",
        r.status.replace(/_/g, " "),
      ]),
      pills: attendance.map((r) => ({ status: r.status })),
    };
    const leaveSection: ScreenSection = {
      title: "Leave",
      head: ["Employee", "Department", "Classification", "Leave Type", "Start Date", "End Date", "Days", "Status"],
      rows: leaves.map((r) => [
        employeeName(r),
        r.employee.department.name,
        formatEmploymentStatus(r.employee.employmentStatus),
        r.leaveType.name,
        formatDate(r.startDate),
        formatDate(r.endDate),
        r.totalDays,
        leaveStatusText(r),
      ]),
      pills: leaves.map((r) => ({ status: r.status, lapseReason: r.lapseReason })),
    };
    const undertimeSection: ScreenSection = {
      title: "Undertime",
      head: ["Employee", "Department", "Undertime Date", "Minutes", "Reason", "Date Filed", "Status", "Reviewed By"],
      rows: undertime.map((r) => [
        employeeName(r),
        r.employee.department.name,
        formatDate(r.attendanceRecord.attendanceDate),
        // Minutes late plus minutes timed out early — the same total the
        // Leave pages show for a filing.
        r.attendanceRecord.lateMinutes + (r.attendanceRecord.undertimeMinutes ?? 0),
        r.reason ?? "—",
        formatDate(r.filingDate),
        r.status,
        !r.reviewer
          ? "—"
          : r.reviewer.employee
            ? `${r.reviewer.employee.firstName} ${r.reviewer.employee.lastName}`
            : r.reviewer.email,
      ]),
      pills: undertime.map((r) => ({ status: r.status })),
    };
    const scheduleSection: ScreenSection = {
      title: "Schedules",
      head: ["Employee", "Department", "Position", "Shift", "Time", "Effective Dates"],
      rows: schedules.map((s) => [
        employeeName(s),
        s.employee.department.name,
        s.employee.position?.title ?? "—",
        s.shift.name,
        `${s.shift.startTime} - ${s.shift.endTime}`,
        `${formatDate(s.startsOn)} - ${s.endsOn ? formatDate(s.endsOn) : "Present"}`,
      ]),
    };
    const employeeSection: ScreenSection = {
      title: "List of Employees",
      head: ["Name", "Department", "Sex", "Hired Date"],
      rows: employees.map((e) => [`${e.firstName} ${e.lastName}`, e.department.name, formatSex(e.sex), formatDate(e.hireDate)]),
    };
    const balanceSection: ScreenSection = {
      title: "Remaining Leave",
      head: ["Name", "Department", "Sex", "Leave Type", "Remaining", "Used", "Dates Used"],
      rows: leaveBalances.map((b) => [
        `${b.employee.firstName} ${b.employee.lastName}`,
        b.employee.department.name,
        formatSex(b.employee.sex),
        b.leaveTypeName,
        Number(b.remainingDays).toFixed(0),
        Number(b.usedDays).toFixed(0),
        formatUsedDates(b.usedDates),
      ]),
    };

    if (tab === "attendance") return [attendanceSection];
    if (tab === "leave") return [leaveSection];
    if (tab === "undertime") return [undertimeSection];
    if (tab === "schedules") return [scheduleSection];
    if (tab === "employees") return [employeeSection];
    if (tab === "leaveBalances") return [balanceSection];
    return [attendanceSection, leaveSection, undertimeSection, scheduleSection];
  }, [tab, attendance, leaves, undertime, schedules, employees, leaveBalances]);

  const resultCount = sections.reduce((sum, section) => sum + section.rows.length, 0);

  const leaveStatusCounts = useMemo(() => {
    const counts: Record<LeaveStatusBucket, number> = { PENDING: 0, APPROVED: 0, REJECTED: 0, CANCELLED: 0, LAPSED: 0 };
    for (const request of leavesInRange) counts[leaveStatusBucket(request.status)] += 1;
    return counts;
  }, [leavesInRange]);

  const undertimeStatusCounts = useMemo(() => {
    const counts: Record<UndertimeStatus, number> = { PENDING: 0, APPROVED: 0, REJECTED: 0 };
    for (const filing of undertimeInRange) {
      if (filing.status in counts) counts[filing.status as UndertimeStatus] += 1;
    }
    return counts;
  }, [undertimeInRange]);

  const rangeLabel = `Generated: ${dateFrom ? formatDate(parseDateKey(dateFrom).toISOString()) : "—"} to ${
    dateTo ? formatDate(parseDateKey(dateTo).toISOString()) : "—"
  }`;

  const reportDocument: ReportDocument = {
    title: REPORT_TITLES[tab],
    subtitle: tab === "ALL" ? `Includes: ${ALL_REPORTS_INCLUDES}` : undefined,
    rangeLabel,
    departmentLabel: departmentName ? `Department: ${departmentName}` : undefined,
    sections,
  };

  async function handleExport(kind: "print" | "pdf") {
    setExporting(kind);
    try {
      if (kind === "print") await printReport(reportDocument);
      else await exportReportPdf(reportDocument, `${tab === "ALL" ? "all" : tab}-report.pdf`);
    } catch (error) {
      // Backing out of the print dialog rejects too; that is not a failure.
      const message = error instanceof Error ? error.message : "";
      if (!/cancel|did not complete|dismiss/i.test(message)) {
        setResultModal({
          status: "error",
          title: kind === "print" ? "Print Failed" : "Export Failed",
          message: message || "The report could not be prepared. Please try again.",
        });
      }
    } finally {
      setExporting(null);
    }
  }

  async function handleRefresh() {
    setIsRefreshing(true);
    try {
      await refresh();
    } catch (error) {
      console.error("Failed to load reports", error);
    } finally {
      setIsRefreshing(false);
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.headerRow}>
        <Pressable onPress={onClose} style={styles.backButton} hitSlop={10}>
          <Ionicons name="chevron-back" size={24} color="#062B59" />
        </Pressable>
        <Text style={styles.headerTitle}>Reports</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={ui.card}>
        <View style={ui.pinnedHeader}>
          <View style={styles.titleRow}>
            <View style={{ flex: 1 }}>
              <Text style={ui.cardTitle}>{REPORT_TITLES[tab]}</Text>
              <Text style={ui.cardSubtitle} numberOfLines={1}>
                {resultCount} result{resultCount === 1 ? "" : "s"}
                {departmentName ? ` · ${departmentName}` : ""}
              </Text>
            </View>
          </View>

          <View style={styles.searchRow}>
            <View style={styles.searchBox}>
              <Ionicons name="search-outline" size={16} color="#94A3B8" />
              <TextInput
                style={styles.searchInput}
                placeholder="Search employees..."
                placeholderTextColor="#94A3B8"
                value={search}
                onChangeText={setSearch}
              />
            </View>
          </View>

          <View style={ui.filterRow}>
            <Pressable style={ui.inputBox} onPress={() => setPickingDate("from")}>
              <Text style={[ui.inputBoxText, !!dateFrom && ui.inputBoxTextFilled]} numberOfLines={1}>
                {dateFrom ? formatShortDate(dateFrom) : "From"}
              </Text>
              <Ionicons name="calendar-outline" size={16} color="#64748B" />
            </Pressable>
            <Pressable style={ui.inputBox} onPress={() => setPickingDate("to")}>
              <Text style={[ui.inputBoxText, !!dateTo && ui.inputBoxTextFilled]} numberOfLines={1}>
                {dateTo ? formatShortDate(dateTo) : "To"}
              </Text>
              <Ionicons name="calendar-outline" size={16} color="#64748B" />
            </Pressable>
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
            {REPORT_TABS.map((entry) => {
              const isActive = tab === entry.key;
              return (
                <Pressable
                  key={entry.key}
                  style={[ui.filterChip, isActive && ui.filterChipActive]}
                  onPress={() => setTab(entry.key)}
                >
                  <Text style={[ui.filterChipText, isActive && ui.filterChipTextActive]}>{entry.label}</Text>
                </Pressable>
              );
            })}
          </ScrollView>

          {/* Like admin-web's status tabs, these also narrow what prints
              and exports, not just the list on screen. */}
          {tab === "leave" && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
              {(["ALL", ...LEAVE_STATUS_FILTERS] as const).map((status) => {
                const isActive = leaveStatusFilter === status;
                const count = status === "ALL" ? leavesInRange.length : leaveStatusCounts[status];
                return (
                  <Pressable
                    key={status}
                    style={[styles.subChip, isActive && styles.subChipActive]}
                    onPress={() => setLeaveStatusFilter(status)}
                  >
                    <Text style={[styles.subChipText, isActive && styles.subChipTextActive]}>
                      {status === "ALL" ? "All" : titleCase(status)} · {count}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          )}
          {tab === "undertime" && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
              {(["ALL", ...UNDERTIME_STATUS_FILTERS] as const).map((status) => {
                const isActive = undertimeStatusFilter === status;
                const count = status === "ALL" ? undertimeInRange.length : undertimeStatusCounts[status];
                return (
                  <Pressable
                    key={status}
                    style={[styles.subChip, isActive && styles.subChipActive]}
                    onPress={() => setUndertimeStatusFilter(status)}
                  >
                    <Text style={[styles.subChipText, isActive && styles.subChipTextActive]}>
                      {status === "ALL" ? "All" : titleCase(status)} · {count}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          )}

          <View style={styles.exportRow}>
            <Pressable
              style={({ pressed }) => [styles.printButton, (pressed || !!exporting || !data) && styles.buttonDim]}
              disabled={!!exporting || !data}
              onPress={() => handleExport("print")}
            >
              {exporting === "print" ? (
                <ActivityIndicator size="small" color="#062B59" />
              ) : (
                <Ionicons name="print-outline" size={16} color="#062B59" />
              )}
              <Text style={styles.printButtonText}>Print</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.pdfButton, (pressed || !!exporting || !data) && styles.buttonDim]}
              disabled={!!exporting || !data}
              onPress={() => handleExport("pdf")}
            >
              {exporting === "pdf" ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Ionicons name="document-text-outline" size={16} color="#FFFFFF" />
              )}
              <Text style={styles.pdfButtonText}>Export PDF</Text>
            </Pressable>
          </View>
        </View>

        {isLoading ? (
          <View style={styles.centered}>
            <ActivityIndicator color="#062B59" size="large" />
          </View>
        ) : (
          <AestheticScrollView
            style={ui.list}
            contentContainerStyle={ui.listContent}
            refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} colors={["#1680D8"]} />}
          >
            {resultCount === 0 ? (
              <View style={ui.emptyState}>
                <Ionicons name="document-text-outline" size={36} color="#CBD5E1" />
                <Text style={ui.emptyText}>
                  {search.trim() ? "No employees match your search." : "No records for this report and date range."}
                </Text>
              </View>
            ) : (
              sections
                .filter((section) => section.rows.length > 0)
                .map((section) => {
                  const statusIndex = section.pills ? section.head.indexOf("Status") : -1;
                  const shownRows = section.rows.slice(0, MAX_ROWS_ON_SCREEN);
                  return (
                    <View key={section.title} style={styles.section}>
                      {sections.length > 1 && (
                        <View style={styles.sectionHeader}>
                          <Text style={styles.sectionTitle}>{section.title}</Text>
                          <Text style={styles.sectionCount}>{section.rows.length}</Text>
                        </View>
                      )}

                      {shownRows.map((row, rowIndex) => {
                        const pill = section.pills?.[rowIndex] ?? null;
                        return (
                          <View key={rowIndex} style={[styles.row, rowIndex > 0 && styles.rowDivider]}>
                            <View style={styles.rowTop}>
                              <Text style={styles.rowTitle} numberOfLines={1}>
                                {row[0]}
                              </Text>
                              {pill && <StatusPill status={pill.status} lapseReason={pill.lapseReason} />}
                            </View>
                            <View style={styles.fieldWrap}>
                              {row.map((cell, cellIndex) => {
                                // The name is the row title and the status
                                // is the pill; everything else is a field.
                                if (cellIndex === 0 || cellIndex === statusIndex) return null;
                                return (
                                  <View key={cellIndex} style={styles.field}>
                                    <Text style={styles.fieldLabel} numberOfLines={1}>
                                      {section.head[cellIndex]}
                                    </Text>
                                    <Text style={styles.fieldValue} numberOfLines={4}>
                                      {cell}
                                    </Text>
                                  </View>
                                );
                              })}
                            </View>
                          </View>
                        );
                      })}

                      {section.rows.length > shownRows.length && (
                        <Text style={styles.moreNote}>
                          + {section.rows.length - shownRows.length} more — all rows are included when you print or
                          export.
                        </Text>
                      )}
                    </View>
                  );
                })
            )}
          </AestheticScrollView>
        )}
      </View>

      <CalendarPickerModal
        visible={pickingDate !== null}
        title={pickingDate === "to" ? "Select To Date" : "Select From Date"}
        selectedDate={parseDateKey(pickingDate === "to" ? dateTo : dateFrom)}
        minimumDate={pickingDate === "to" ? parseDateKey(dateFrom) : undefined}
        maximumDate={pickingDate === "from" ? parseDateKey(dateTo) : undefined}
        onSelect={(date) => {
          if (pickingDate === "to") setDateTo(toDateKey(date));
          else setDateFrom(toDateKey(date));
          setPickingDate(null);
        }}
        onClose={() => setPickingDate(null)}
      />

      <ResultModal
        visible={!!resultModal}
        status={resultModal?.status ?? "info"}
        title={resultModal?.title ?? ""}
        message={resultModal?.message ?? ""}
        onClose={() => setResultModal(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 40 },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 14 },
  backButton: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: "#F1F5F9" },
  headerSpacer: { width: 36 },
  headerTitle: { fontSize: 16, fontWeight: "800", color: "#062B59" },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 14 },
  searchRow: { flexDirection: "row", marginBottom: 14 },
  searchBox: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 48,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    backgroundColor: "#FFFFFF",
  },
  searchInput: { flex: 1, fontSize: 14, fontWeight: "600", color: "#0F172A" },
  chipRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingBottom: 12, paddingRight: 4 },
  subChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    backgroundColor: "#FFFFFF",
  },
  subChipActive: { borderColor: "#062B59", backgroundColor: "#F0F7FF" },
  subChipText: { fontSize: 11.5, fontWeight: "700", color: "#64748B" },
  subChipTextActive: { color: "#062B59" },
  exportRow: { flexDirection: "row", gap: 8, marginBottom: 14 },
  printButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#062B59",
    backgroundColor: "#FFFFFF",
  },
  printButtonText: { fontSize: 13.5, fontWeight: "800", color: "#062B59" },
  pdfButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    height: 44,
    borderRadius: 12,
    backgroundColor: "#062B59",
  },
  pdfButtonText: { fontSize: 13.5, fontWeight: "800", color: "#FFFFFF" },
  buttonDim: { opacity: 0.6 },
  section: { marginBottom: 18 },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: "#F1F5F9",
    marginBottom: 2,
  },
  sectionTitle: { flex: 1, fontSize: 12.5, fontWeight: "800", color: "#062B59" },
  sectionCount: { fontSize: 11.5, fontWeight: "800", color: "#64748B" },
  row: { paddingVertical: 12 },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#E2E8F0" },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowTitle: { flex: 1, fontSize: 14, fontWeight: "800", color: "#062B59" },
  fieldWrap: { flexDirection: "row", flexWrap: "wrap", marginTop: 6, rowGap: 6 },
  field: { width: "50%", paddingRight: 10 },
  fieldLabel: { fontSize: 9.5, fontWeight: "700", color: "#94A3B8", textTransform: "uppercase", letterSpacing: 0.3 },
  fieldValue: { fontSize: 12, fontWeight: "600", color: "#334155", marginTop: 1 },
  moreNote: { fontSize: 11, fontWeight: "600", color: "#94A3B8", textAlign: "center", paddingTop: 10 },
});
