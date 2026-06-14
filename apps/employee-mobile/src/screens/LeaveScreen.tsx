import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Modal,
  SafeAreaView,
  Dimensions,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import DateTimePickerModal from "react-native-modal-datetime-picker";

const { height: SCREEN_HEIGHT } = Dimensions.get("window");

const leaveTypes = [
  "Vacation Leave", 
  "Sick Leave", 
  "Emergency Leave", 
  "Maternity Leave", 
  "Paternity Leave", 
  "Bereavement Leave"
];

export default function LeaveScreen() {
  const [leaveType, setLeaveType] = useState("");
  const [searchLeave, setSearchLeave] = useState(""); 
  const [reason, setReason] = useState("");
  
  const [startDate, setStartDate] = useState(new Date());
  const [endDate, setEndDate] = useState(new Date());
  
  const [startDateSelected, setStartDateSelected] = useState(false);
  const [endDateSelected, setEndDateSelected] = useState(false);

  const [isStartPickerVisible, setStartPickerVisibility] = useState(false);
  const [isEndPickerVisible, setEndPickerVisibility] = useState(false);

  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  const [showBalance, setShowBalance] = useState(false);
  const [showPending, setShowPending] = useState(false);

  const handleStartDateConfirm = (selectedDate = new Date()) => {
    setStartPickerVisibility(false);
    if (selectedDate) {
      setStartDate(selectedDate);
      setStartDateSelected(true);
    }
  };

  const handleEndDateConfirm = (selectedDate = new Date()) => {
    setEndPickerVisibility(false);
    if (selectedDate) {
      setEndDate(selectedDate);
      setEndDateSelected(true);
    }
  };

  const formatDate = (displayDate = new Date()) => {
    return `${displayDate.getMonth() + 1}/${displayDate.getDate()}/${displayDate.getFullYear()}`;
  };

  const filteredLeaveTypes = leaveTypes.filter((item) =>
    item.toLowerCase().includes(searchLeave.toLowerCase())
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.mainContainer}>
        
        <View style={styles.summaryRow}>
          <Pressable style={styles.summaryCard} onPress={() => setShowBalance(true)}>
            <Ionicons name="wallet-outline" size={20} color="#1680D8" />
            <Text style={styles.summaryLabel}>Leave Balance</Text>
            <Text style={styles.summaryValue}>10</Text>
            <Text style={styles.tapText}>Tap to view</Text>
          </Pressable>

          <Pressable style={styles.summaryCard} onPress={() => setShowPending(true)}>
            <Ionicons name="time-outline" size={20} color="#F59E0B" />
            <Text style={styles.summaryLabel}>Pending Leave</Text>
            <Text style={styles.summaryValue}>2</Text>
            <Text style={styles.tapText}>Tap to view</Text>
          </Pressable>
        </View>

        <View style={styles.card}>
          <View style={styles.formHeader}>
            <Ionicons color="#DC2777" name="document-text-outline" size={32} />
            <Text style={styles.cardTitle}>Leave Request</Text>
          </View>

          <Text style={styles.label}>Leave Type</Text>
          <View style={styles.dropdownWrapper}>
            <Pressable 
              style={[styles.dropdownButton, isDropdownOpen && { borderColor: "#062B59" }]} 
              onPress={() => {
                setIsDropdownOpen(!isDropdownOpen);
                setSearchLeave(""); 
              }}
            >
              <Text style={[styles.dropdownText, !leaveType && { color: "#94A3B8" }]}>
                {leaveType || "Select Leave Type"}
              </Text>
              <Ionicons name={isDropdownOpen ? "chevron-up" : "chevron-down"} size={20} color="#64748B" />
            </Pressable>

            {isDropdownOpen && (
              <View style={styles.inlineDropdownContainer}>
                <View style={styles.searchBarWrapper}>
                  <Ionicons name="search-outline" size={16} color="#94A3B8" style={styles.searchIcon} />
                  <TextInput
                    placeholder="Search leave type..."
                    value={searchLeave}
                    onChangeText={setSearchLeave}
                    style={styles.inlineSearchInput}
                    autoFocus={true} 
                  />
                </View>

                {filteredLeaveTypes.length > 0 ? (
                  filteredLeaveTypes.map((item) => (
                    <Pressable
                      key={item}
                      style={styles.inlineItem}
                      onPress={() => {
                        setLeaveType(item);
                        setIsDropdownOpen(false);
                        setSearchLeave("");
                      }}
                    >
                      <Text style={[styles.inlineItemText, leaveType === item && styles.selectedItemText]}>
                        {item}
                      </Text>
                    </Pressable>
                  ))
                ) : (
                  <View style={styles.noResultsBox}>
                    <Text style={styles.noResultsText}>No leave types found</Text>
                  </View>
                )}
              </View>
            )}
          </View>

          <Text style={styles.label}>Leave Duration</Text>
          <View style={styles.dateRow}>
            <Pressable style={styles.dateBox} onPress={() => setStartPickerVisibility(true)}>
              <Text style={[styles.dateText, !startDateSelected && { color: "#94A3B8" }]}>
                {startDateSelected ? formatDate(startDate) : "Start Date"}
              </Text>
              <Ionicons name="calendar-outline" size={20} color="#64748B" />
            </Pressable>

            <Pressable style={styles.dateBox} onPress={() => setEndPickerVisibility(true)}>
              <Text style={[styles.dateText, !endDateSelected && { color: "#94A3B8" }]}>
                {endDateSelected ? formatDate(endDate) : "End Date"}
              </Text>
              <Ionicons name="calendar-outline" size={20} color="#64748B" />
            </Pressable>
          </View>

          <DateTimePickerModal
            isVisible={isStartPickerVisible}
            mode="date"
            onConfirm={handleStartDateConfirm}
            onCancel={() => setStartPickerVisibility(false)}
          />

          <DateTimePickerModal
            isVisible={isEndPickerVisible}
            mode="date"
            onConfirm={handleEndDateConfirm}
            onCancel={() => setEndPickerVisibility(false)}
          />

          <Text style={styles.label}>Reason</Text>
          <View style={styles.textAreaContainer}>
            <TextInput
              placeholder="Enter reason"
              multiline
              value={reason}
              onChangeText={setReason}
              style={styles.textAreaInput}
            />
          </View>

          <Pressable style={styles.button}>
            <Text style={styles.buttonText}>Submit Leave Request</Text>
          </Pressable>
        </View>
      </View>

      <Modal visible={showBalance} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Leave Balance</Text>
            <View style={styles.balanceRow}><Text>Vacation Leave</Text><Text>10 Days</Text></View>
            <View style={styles.balanceRow}><Text>Sick Leave</Text><Text>5 Days</Text></View>
            <View style={styles.balanceRow}><Text>Emergency Leave</Text><Text>3 Days</Text></View>
            <Pressable style={styles.closeButton} onPress={() => setShowBalance(false)}>
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={showPending} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Pending Leave Requests</Text>
            <View style={styles.requestCard}>
              <Text style={styles.requestTitle}>Vacation Leave</Text>
              <Text>June 20 - June 22, 2026</Text>
              <Text style={styles.pendingText}>Pending Approval</Text>
            </View>
            <Pressable style={styles.closeButton} onPress={() => setShowPending(false)}>
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { 
    flex: 1, 
    backgroundColor: "#FFFFFF" 
  },
  mainContainer: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: SCREEN_HEIGHT < 700 ? 16 : 24,
    justifyContent: "center", 
  },
  summaryRow: { 
    flexDirection: "row", 
    gap: 12, 
    marginBottom: SCREEN_HEIGHT < 700 ? 10 : 16, 
  },
  summaryCard: { 
    flex: 1, 
    backgroundColor: "#FFFFFF", 
    borderRadius: 18, 
    paddingVertical: SCREEN_HEIGHT < 700 ? 8 : 12, 
    paddingHorizontal: 12,
    borderWidth: 1, 
    borderColor: "#E2E8F0", 
    alignItems: "center" 
  },
  summaryLabel: { 
    color: "#64748B", 
    fontSize: 12, 
    marginTop: 4,
  },
  summaryValue: { 
    fontSize: 20, 
    fontWeight: "700", 
    color: "#062B59", 
    marginTop: 2,
  },
  tapText: { 
    marginTop: 2, 
    color: "#1680D8", 
    fontSize: 11, 
    fontWeight: "600" 
  },
  card: { 
    backgroundColor: "#FFFFFF", 
    borderRadius: 18, 
    paddingHorizontal: 20,
    paddingTop: SCREEN_HEIGHT < 700 ? 14 : 20, 
    paddingBottom: SCREEN_HEIGHT < 700 ? 16 : 24, 
    borderWidth: 1, 
    borderColor: "#E2E8F0",
    zIndex: 1, 
  },
  formHeader: { 
    flexDirection: "row", 
    alignItems: "center", 
    gap: 10, 
  },
  cardTitle: { 
    fontSize: 20, 
    fontWeight: "700", 
    color: "#062B59",
  },
  label: { 
    fontWeight: "600", 
    color: "#475569",
    marginTop: SCREEN_HEIGHT < 700 ? 6 : 12,
    marginBottom: SCREEN_HEIGHT < 700 ? 2 : 4,
  },
  
  dropdownWrapper: {
    position: "relative",
    zIndex: 10,
  },
  dropdownButton: { 
    height: SCREEN_HEIGHT < 700 ? 44 : 50, 
    borderWidth: 1, 
    borderColor: "#E2E8F0", 
    borderRadius: 12, 
    paddingHorizontal: 14, 
    flexDirection: "row", 
    alignItems: "center", 
    justifyContent: "space-between",
    backgroundColor: "#FFFFFF",
  },
  dropdownText: { 
    fontSize: 14 
  },
  inlineDropdownContainer: {
    position: "absolute",
    top: SCREEN_HEIGHT < 700 ? 46 : 52,
    left: 0,
    right: 0,
    backgroundColor: "#FFFFFF",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    maxHeight: 200,
    zIndex: 50,
    elevation: 5, 
    shadowColor: "#000", 
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.15,
    shadowRadius: 5,
    overflow: "scroll",
  },
  searchBarWrapper: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: "#E2E8F0",
    paddingHorizontal: 10,
    backgroundColor: "#F8FAFC",
    borderTopLeftRadius: 11,
    borderTopRightRadius: 11,
  },
  searchIcon: {
    marginRight: 6,
  },
  inlineSearchInput: {
    flex: 1,
    height: 40,
    fontSize: 14,
    color: "#000000",
  },
  inlineItem: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#F1F5F9",
  },
  inlineItemText: {
    fontSize: 14,
    color: "#334155",
  },
  selectedItemText: {
    color: "#062B59",
    fontWeight: "700",
  },
  noResultsBox: {
    padding: 16,
    alignItems: "center",
  },
  noResultsText: {
    color: "#94A3B8",
    fontSize: 14,
  },

  dateRow: { flexDirection: "row", gap: 10 },
  dateBox: { flex: 1, height: SCREEN_HEIGHT < 700 ? 44 : 50, borderWidth: 1, borderColor: "#E2E8F0", borderRadius: 12, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: "#FFFFFF" },
  dateText: { fontSize: 14 },
  
  textAreaContainer: {
    height: SCREEN_HEIGHT < 700 ? 80 : 110, 
    borderWidth: 1, 
    borderColor: "#E2E8F0", 
    borderRadius: 12, 
    backgroundColor: "#FFFFFF",
    overflow: "hidden", 
    marginVertical: SCREEN_HEIGHT < 700 ? 4 : 6,       
  },
  textAreaInput: {
    flex: 1,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
    textAlignVertical: "top",  
  },
  button: { 
    height: SCREEN_HEIGHT < 700 ? 46 : 52, 
    borderRadius: 14, 
    backgroundColor: "#062B59", 
    justifyContent: "center", 
    alignItems: "center", 
    marginTop: SCREEN_HEIGHT < 700 ? 10 : 16, 
  },
  buttonText: { 
    color: "#FFFFFF", 
    fontWeight: "700" 
  },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "center", alignItems: "center" },
  modalCard: { width: "88%", backgroundColor: "#FFFFFF", borderRadius: 18, padding: 20 },
  modalTitle: { fontSize: 18, fontWeight: "700", marginBottom: 16, color: "#062B59" },
  balanceRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 12 },
  requestCard: { backgroundColor: "#F8FAFC", borderRadius: 12, padding: 14, marginBottom: 12 },
  requestTitle: { fontWeight: "700", marginBottom: 4 },
  pendingText: { color: "#F59E0B", fontWeight: "600", marginTop: 4 },
  closeButton: { backgroundColor: "#062B59", borderRadius: 12, padding: 12, marginTop: 12 },
  closeText: { color: "#FFFFFF", textAlign: "center", fontWeight: "700" },
});