import { StyleSheet } from "react-native";

// The employee-facing screens' visual language, in one place so the
// supervisor screens read as the same app instead of each keeping its own
// flatter copy of the same ideas. Every value here is lifted from
// DTRScreen/LeaveScreen (the cards, filter chips, date-filter boxes and
// empty states those two established) — change it here and both sides of
// the app move together.

// Soft, deep navy-tinted shadow so a card reads as hovering above the page
// rather than sitting flush on it (LeaveScreen's card/modalCard treatment).
export const CARD_SHADOW = {
  shadowColor: "#062B59",
  shadowOffset: { width: 0, height: 8 },
  shadowOpacity: 0.12,
  shadowRadius: 16,
  elevation: 6,
} as const;

export const ui = StyleSheet.create({
  // Full-height outer card: a pinned header area plus a scrolling list,
  // exactly how DTRScreen frames its Daily Time Record.
  card: {
    flex: 1,
    backgroundColor: "#FFFFFF",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    ...CARD_SHADOW,
  },
  // Same card, sized to its content (summary tiles, forms).
  panel: {
    backgroundColor: "#FFFFFF",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    padding: 16,
    ...CARD_SHADOW,
  },
  pinnedHeader: {
    padding: 18,
    paddingBottom: 0,
  },
  cardTitle: {
    color: "#062B59",
    fontSize: 18,
    fontWeight: "900",
  },
  cardSubtitle: {
    color: "#64748B",
    fontSize: 12,
    fontWeight: "600",
    marginTop: 2,
  },
  list: {
    flex: 1,
  },
  listContent: {
    padding: 18,
    paddingTop: 4,
    flexGrow: 1,
  },
  // A row inside a card — the quiet inner surface LeaveScreen uses for its
  // request cards, so nested content never competes with the card itself.
  innerCard: {
    backgroundColor: "#F8FAFC",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    padding: 14,
  },
  filterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 14,
  },
  filterChip: {
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: "#F1F5F9",
  },
  filterChipActive: {
    backgroundColor: "#062B59",
  },
  filterChipText: {
    color: "#64748B",
    fontSize: 12,
    fontWeight: "700",
  },
  filterChipTextActive: {
    color: "#FFFFFF",
  },
  // Outlined input-style box with the icon on the right — the trigger look
  // shared by DTR's From/To date filters and admin-web's CalendarPicker.
  inputBox: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    // Lets the box narrow with its row; the label inside gives way first so
    // the trailing icon always stays inside the border.
    minWidth: 0,
    height: 48,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    backgroundColor: "#FFFFFF",
  },
  inputBoxText: {
    flex: 1,
    minWidth: 0,
    color: "#94A3B8",
    fontSize: 14,
    fontWeight: "600",
  },
  inputBoxTextFilled: {
    color: "#0F172A",
  },
  // The small round "clear this filter" button that sits after a filter row.
  iconButton: {
    alignItems: "center",
    justifyContent: "center",
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#F1F5F9",
  },
  emptyState: {
    alignItems: "center",
    gap: 8,
    paddingTop: 30,
  },
  emptyText: {
    color: "#94A3B8",
    fontSize: 13,
    fontWeight: "600",
    textAlign: "center",
  },
  // Centered dialog, not a bottom sheet — what every employee-facing modal
  // (DTR photos, leave details) uses.
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(6, 43, 89, 0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: 12,
  },
  modalCard: {
    width: "100%",
    maxWidth: 480,
    maxHeight: "92%",
    backgroundColor: "#FFFFFF",
    borderRadius: 20,
    padding: 16,
  },
  modalTitle: {
    color: "#062B59",
    fontSize: 16,
    fontWeight: "800",
    marginBottom: 14,
    textAlign: "center",
  },
  tabSwitcher: {
    marginBottom: 12,
  },
});
