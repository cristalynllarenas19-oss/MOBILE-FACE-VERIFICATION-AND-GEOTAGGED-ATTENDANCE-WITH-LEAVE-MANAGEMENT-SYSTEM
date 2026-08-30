import React, { useCallback, useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Modal,
  SafeAreaView,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import ResultModal, { ResultModalStatus } from "../../components/ResultModal";
import EmptyState from "../../components/EmptyState";
import Avatar from "../../components/Avatar";
import AestheticScrollView from "../../components/AestheticScrollView";
import {
  TeamEmployee,
  CreateTeamEmployeeInput,
  getTeamEmployees,
  createTeamEmployee,
  updateTeamEmployee,
  archiveTeamEmployee,
} from "../../api";
import { useCachedData } from "../../utils/dataCache";

type Props = {
  departmentName?: string;
  currentEmployeeId?: string;
};

const EMPLOYMENT_STATUSES = ["REGULAR", "PROBATIONARY", "CONTRACTUAL_SEASONAL", "PIECE_RATE"] as const;

function getEmploymentStatusLabel(status: string) {
  if (status === "REGULAR") return "Regular";
  if (status === "PROBATIONARY") return "Probationary";
  if (status === "CONTRACTUAL_SEASONAL") return "Contractual";
  if (status === "PIECE_RATE") return "Piece-Rate";
  return status;
}

function getName(employee: TeamEmployee) {
  return `${employee.firstName} ${employee.lastName}`;
}

function emptyForm(departmentName?: string): CreateTeamEmployeeInput {
  return {
    firstName: "",
    lastName: "",
    email: "",
    department: departmentName ?? "",
    employmentStatus: "REGULAR",
    sex: "MALE",
  };
}

export default function TeamScreen({ departmentName, currentEmployeeId }: Props) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [search, setSearch] = useState("");

  const [editing, setEditing] = useState<TeamEmployee | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<CreateTeamEmployeeInput>(emptyForm(departmentName));
  const [isSaving, setIsSaving] = useState(false);

  const [resultModal, setResultModal] = useState<{ status: ResultModalStatus; title: string; message: string } | null>(null);

  const { data: roster, isLoading, refresh } = useCachedData<TeamEmployee[]>(
    "team-employees",
    getTeamEmployees,
  );

  // The roster endpoint returns every employee in the department,
  // including the supervisor's own linked employee record — they
  // manage their team, not themselves, so exclude it here.
  const employees = useMemo(
    () => (roster ?? []).filter((e) => e.id !== currentEmployeeId),
    [roster, currentEmployeeId],
  );

  const load = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setIsRefreshing(true);
      try {
        await refresh();
      } catch (error) {
        console.error("Failed to load team", error);
      } finally {
        setIsRefreshing(false);
      }
    },
    [refresh],
  );

  const filtered = useMemo(
    () => employees.filter((e) => getName(e).toLowerCase().includes(search.toLowerCase())),
    [employees, search],
  );

  function openAdd() {
    setEditing(null);
    setForm(emptyForm(departmentName));
    setShowForm(true);
  }

  function openEdit(employee: TeamEmployee) {
    setEditing(employee);
    setForm({
      firstName: employee.firstName,
      lastName: employee.lastName,
      email: employee.email ?? "",
      department: departmentName ?? employee.department?.name ?? "",
      hireDate: employee.hireDate,
      employmentStatus: (employee.employmentStatus as CreateTeamEmployeeInput["employmentStatus"]) ?? "REGULAR",
      attendanceMode: employee.attendanceMode,
      sex: employee.sex ?? "MALE",
    });
    setShowForm(true);
  }

  async function handleSave() {
    if (!form.firstName.trim() || !form.lastName.trim() || (!editing && !form.email.trim())) {
      setResultModal({ status: "info", title: "Missing Information", message: "First name, last name, and email are required." });
      return;
    }

    setIsSaving(true);
    try {
      if (editing) {
        const { email, ...rest } = form;
        await updateTeamEmployee(editing.id, rest);
      } else {
        await createTeamEmployee(form);
      }
      setShowForm(false);
      await load();
      setResultModal({ status: "approved", title: editing ? "Employee Updated" : "Employee Added", message: `${form.firstName} ${form.lastName} was saved.` });
    } catch (error) {
      setResultModal({ status: "error", title: "Save Failed", message: error instanceof Error ? error.message : "Failed to save employee." });
    } finally {
      setIsSaving(false);
    }
  }

  async function handleArchive(employee: TeamEmployee) {
    setIsSaving(true);
    try {
      await archiveTeamEmployee(employee.id);
      await load();
      setResultModal({ status: "approved", title: "Employee Archived", message: `${getName(employee)} was archived.` });
    } catch (error) {
      setResultModal({ status: "error", title: "Archive Failed", message: error instanceof Error ? error.message : "Failed to archive employee." });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <View style={styles.searchBox}>
          <Ionicons name="search-outline" size={16} color="#94A3B8" />
          <TextInput
            style={styles.searchInput}
            placeholder="Search employees..."
            value={search}
            onChangeText={setSearch}
          />
        </View>
        <Pressable style={styles.addButton} onPress={openAdd}>
          <Ionicons name="add" size={22} color="#FFFFFF" />
        </Pressable>
      </View>

      {departmentName && (
        <View style={styles.deptBanner}>
          <Ionicons name="business-outline" size={14} color="#1680D8" />
          <Text style={styles.deptBannerText}>{departmentName}</Text>
        </View>
      )}

      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator color="#062B59" size="large" />
        </View>
      ) : (
        <AestheticScrollView
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={() => load(true)} tintColor="#062B59" />}
        >
          {filtered.length === 0 ? (
            <EmptyState
              icon="people-outline"
              title={search ? "No matching employees" : "No employees yet"}
              message={search ? "Try a different search term." : "Tap + to add your first team member."}
            />
          ) : (
            <>
              <Text style={styles.countLabel}>{filtered.length} employee{filtered.length === 1 ? "" : "s"}</Text>
              {filtered.map((employee) => (
                <View key={employee.id} style={styles.row}>
                  <Avatar firstName={employee.firstName} lastName={employee.lastName} />
                  <View style={{ flex: 1 }}>
                    <View style={styles.rowNameLine}>
                      <Text style={styles.rowName} numberOfLines={1}>{getName(employee)}</Text>
                      <View style={[styles.statusChip, employee.employmentStatus !== "REGULAR" && styles.statusChipMuted]}>
                        <Text style={[styles.statusChipText, employee.employmentStatus !== "REGULAR" && styles.statusChipTextMuted]}>
                          {getEmploymentStatusLabel(employee.employmentStatus)}
                        </Text>
                      </View>
                    </View>
                    <Text style={styles.rowMeta}>{employee.position?.title ?? "—"} · {employee.employeeNo}</Text>
                  </View>
                  <Pressable style={styles.iconButton} onPress={() => openEdit(employee)} hitSlop={6}>
                    <Ionicons name="pencil-outline" size={17} color="#1680D8" />
                  </Pressable>
                  <Pressable style={styles.iconButton} onPress={() => handleArchive(employee)} hitSlop={6}>
                    <Ionicons name="archive-outline" size={17} color="#DC2626" />
                  </Pressable>
                </View>
              ))}
            </>
          )}
        </AestheticScrollView>
      )}

      <Modal visible={showForm} transparent animationType="slide" onRequestClose={() => setShowForm(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHandle} />
            <AestheticScrollView keyboardShouldPersistTaps="handled">
              <Text style={styles.modalTitle}>{editing ? "Edit Employee" : "Add Employee"}</Text>

              <Text style={styles.label}>First Name</Text>
              <TextInput style={styles.input} value={form.firstName} onChangeText={(v) => setForm((f) => ({ ...f, firstName: v }))} />

              <Text style={styles.label}>Last Name</Text>
              <TextInput style={styles.input} value={form.lastName} onChangeText={(v) => setForm((f) => ({ ...f, lastName: v }))} />

              {!editing && (
                <>
                  <Text style={styles.label}>Email</Text>
                  <TextInput
                    style={styles.input}
                    value={form.email}
                    onChangeText={(v) => setForm((f) => ({ ...f, email: v }))}
                    autoCapitalize="none"
                    keyboardType="email-address"
                  />
                </>
              )}

              <Text style={styles.label}>Department</Text>
              <View style={[styles.input, styles.inputDisabled]}>
                <Text style={styles.disabledText}>{form.department || "—"}</Text>
              </View>

              <Text style={styles.label}>Employment Status</Text>
              <View style={styles.chipRow}>
                {EMPLOYMENT_STATUSES.map((status) => (
                  <Pressable
                    key={status}
                    style={[styles.chip, form.employmentStatus === status && styles.chipActive]}
                    onPress={() => setForm((f) => ({ ...f, employmentStatus: status }))}
                  >
                    <Text style={[styles.chipText, form.employmentStatus === status && styles.chipTextActive]}>
                      {status.replace("_", " ")}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <Text style={styles.label}>Sex</Text>
              <View style={styles.chipRow}>
                {(["MALE", "FEMALE"] as const).map((sex) => (
                  <Pressable
                    key={sex}
                    style={[styles.chip, form.sex === sex && styles.chipActive]}
                    onPress={() => setForm((f) => ({ ...f, sex }))}
                  >
                    <Text style={[styles.chipText, form.sex === sex && styles.chipTextActive]}>{sex}</Text>
                  </Pressable>
                ))}
              </View>

              <View style={styles.modalActions}>
                <Pressable style={styles.cancelButton} onPress={() => setShowForm(false)}>
                  <Text style={styles.cancelText}>Cancel</Text>
                </Pressable>
                <Pressable style={[styles.saveButton, isSaving && styles.buttonDisabled]} onPress={handleSave} disabled={isSaving}>
                  {isSaving ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.saveText}>Save</Text>}
                </Pressable>
              </View>
            </AestheticScrollView>
          </View>
        </View>
      </Modal>

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

const cardShadow = {
  shadowColor: "#0F172A",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.06,
  shadowRadius: 8,
  elevation: 2,
};

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: { flexDirection: "row", gap: 10, alignItems: "center" },
  searchBox: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 46,
    borderRadius: 14,
    paddingHorizontal: 14,
    backgroundColor: "#FFFFFF",
    ...cardShadow,
  },
  searchInput: { flex: 1, fontSize: 14 },
  addButton: {
    width: 46,
    height: 46,
    borderRadius: 14,
    backgroundColor: "#062B59",
    alignItems: "center",
    justifyContent: "center",
    ...cardShadow,
    shadowColor: "#062B59",
    shadowOpacity: 0.3,
  },
  deptBanner: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 12, alignSelf: "flex-start", backgroundColor: "#EAF3FC", paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  deptBannerText: { fontSize: 12, color: "#1680D8", fontWeight: "700" },
  countLabel: { fontSize: 12, color: "#94A3B8", fontWeight: "600", marginBottom: 2 },
  list: { paddingTop: 12, paddingBottom: 24, gap: 10 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    padding: 12,
    ...cardShadow,
  },
  rowNameLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowName: { fontSize: 14, fontWeight: "700", color: "#062B59", flexShrink: 1 },
  statusChip: { backgroundColor: "#DCFCE7", paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999 },
  statusChipMuted: { backgroundColor: "#F1F5F9" },
  statusChipText: { fontSize: 9.5, fontWeight: "700", color: "#15803D" },
  statusChipTextMuted: { color: "#64748B" },
  rowMeta: { fontSize: 12, color: "#64748B", marginTop: 2 },
  iconButton: { width: 34, height: 34, borderRadius: 10, backgroundColor: "#F8FAFC", alignItems: "center", justifyContent: "center" },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" },
  modalCard: { maxHeight: "85%", backgroundColor: "#FFFFFF", borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingTop: 12 },
  modalHandle: { width: 40, height: 4, borderRadius: 999, backgroundColor: "#E2E8F0", alignSelf: "center", marginBottom: 14 },
  modalTitle: { fontSize: 18, fontWeight: "700", color: "#062B59", marginBottom: 12 },
  label: { fontWeight: "600", color: "#475569", marginTop: 10, marginBottom: 4 },
  input: { height: 46, borderWidth: 1, borderColor: "#E2E8F0", borderRadius: 12, paddingHorizontal: 12, justifyContent: "center" },
  inputDisabled: { backgroundColor: "#F1F5F9" },
  disabledText: { color: "#64748B" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: "#E2E8F0" },
  chipActive: { backgroundColor: "#062B59", borderColor: "#062B59" },
  chipText: { fontSize: 12, color: "#334155", fontWeight: "600" },
  chipTextActive: { color: "#FFFFFF" },
  modalActions: { flexDirection: "row", gap: 10, marginTop: 20 },
  cancelButton: { flex: 1, height: 48, borderRadius: 12, borderWidth: 1, borderColor: "#E2E8F0", alignItems: "center", justifyContent: "center" },
  cancelText: { color: "#334155", fontWeight: "700" },
  saveButton: { flex: 1, height: 48, borderRadius: 12, backgroundColor: "#062B59", alignItems: "center", justifyContent: "center" },
  saveText: { color: "#FFFFFF", fontWeight: "700" },
  buttonDisabled: { opacity: 0.7 },
});
