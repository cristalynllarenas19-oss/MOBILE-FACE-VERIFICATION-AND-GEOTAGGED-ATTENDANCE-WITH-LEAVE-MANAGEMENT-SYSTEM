import React from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { TodayAttendance } from "../api";

type Props = {
  user: any;
  isLoading: boolean;
  todayAttendance: TodayAttendance | null;
  onTimeIn: () => void;
  onTimeOut: () => void;
};

function formatTime(value: string | null | undefined) {
  if (!value) return "--:--";
  return new Date(value).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function AttendanceScreen({
  user,
  isLoading,
  todayAttendance,
  onTimeIn,
  onTimeOut,
}: Props) {
  const today = new Date().toLocaleDateString(
    "en-US",
    {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    }
  );

  const isField = user?.attendanceMode === "FIELD";

  const hasTimedIn = Boolean(todayAttendance?.timeInAt);
  const hasTimedOut = Boolean(todayAttendance?.timeOutAt);
  // For FIELD employees, todayAttendance is the latest visit of the day —
  // an "open" visit is one that's started but hasn't been ended yet.
  const hasOpenVisit = hasTimedIn && !hasTimedOut;

  const statusLabel = isField
    ? hasOpenVisit
      ? "Visit In Progress"
      : hasTimedIn
        ? "No Active Visit"
        : "No Visit Started"
    : hasTimedOut
      ? "Day Completed"
      : hasTimedIn
        ? "Timed In"
        : "Not Timed In";

  const statusColor = isField
    ? hasOpenVisit
      ? "#1680D8"
      : hasTimedIn
        ? "#17A34A"
        : "#EF4444"
    : hasTimedOut
      ? "#17A34A"
      : hasTimedIn
        ? "#1680D8"
        : "#EF4444";

  const timeInDisabled = isLoading || (isField ? hasOpenVisit : hasTimedIn);
  const timeOutDisabled = isField ? isLoading || !hasOpenVisit : isLoading || !hasTimedIn || hasTimedOut;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.contentContainer}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.cardHeaderText}>
            <Text style={styles.date}>
              {today}
            </Text>

            <Text style={styles.cardTitle}>
              Attendance Status
            </Text>
          </View>

          <View
            style={[
              styles.statusBadge,
              {
                backgroundColor: `${statusColor}1A`,
                borderColor: statusColor,
              },
            ]}
          >
            <Ionicons
              name="ellipse"
              size={8}
              color={statusColor}
            />

            <Text style={[styles.statusBadgeText, { color: statusColor }]}>
              {statusLabel}
            </Text>
          </View>
        </View>

        <Text style={styles.welcomeText}>
          Welcome back,
          {" "}
          {user?.displayName}
        </Text>

        <View style={styles.timeStatsRow}>
          <View style={styles.timeStatCard}>
            <View style={[styles.timeStatIcon, { backgroundColor: "#EFF6FF" }]}>
              <Ionicons
                name="log-in-outline"
                size={18}
                color="#1680D8"
              />
            </View>

            <Text style={styles.timeLabel}>
              {isField ? "Visit Start" : "Time In"}
            </Text>

            <Text style={styles.timeValue}>
              {formatTime(todayAttendance?.timeInAt)}
            </Text>
          </View>

          <View style={styles.timeStatDivider} />

          <View style={styles.timeStatCard}>
            <View style={[styles.timeStatIcon, { backgroundColor: "#F0FDF4" }]}>
              <Ionicons
                name="log-out-outline"
                size={18}
                color="#17A34A"
              />
            </View>

            <Text style={styles.timeLabel}>
              {isField ? "Visit End" : "Time Out"}
            </Text>

            <Text style={styles.timeValue}>
              {formatTime(todayAttendance?.timeOutAt)}
            </Text>
          </View>
        </View>
      </View>

      <Pressable
        disabled={timeInDisabled}
        onPress={onTimeIn}
        style={({ pressed }) => [
          styles.timeInButton,
          timeInDisabled && styles.disabledButtonFilled,
          pressed && !timeInDisabled && styles.buttonPressed,
        ]}
      >
        <Ionicons
          name="log-in-outline"
          size={20}
          color="#FFFFFF"
        />

        <Text style={styles.buttonText}>
          {isLoading
            ? "Loading..."
            : isField
              ? "START VISIT"
              : "TIME IN"}
        </Text>
      </Pressable>

      <Pressable
        disabled={timeOutDisabled}
        onPress={onTimeOut}
        style={({ pressed }) => [
          styles.timeOutButton,
          timeOutDisabled
            ? styles.disabledButtonOutline
            : styles.timeOutButtonActive,
          pressed && !timeOutDisabled && styles.buttonPressed,
        ]}
      >
        <Ionicons
          name="log-out-outline"
          size={20}
          color={timeOutDisabled ? "#94A3B8" : "#FFFFFF"}
        />

        <Text
          style={[
            styles.timeOutText,
            { color: timeOutDisabled ? "#94A3B8" : "#FFFFFF" },
          ]}
        >
          {isField ? "END VISIT" : "TIME OUT"}
        </Text>
      </Pressable>

      <View style={styles.infoCard}>
        <Ionicons
          name="information-circle-outline"
          size={22}
          color="#1680D8"
        />

        <Text style={styles.infoText}>
          Please ensure your location and
          camera permissions are enabled
          before recording attendance.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },

  contentContainer: {
    flexGrow: 1,
    paddingBottom: 24,
  },

  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 18,
    padding: 20,

    borderWidth: 1,
    borderColor: "#E2E8F0",

    shadowColor: "#000",
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 3,
  },

  cardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
  },

  cardHeaderText: {
    flexShrink: 1,
  },

  date: {
    color: "#64748B",
    fontSize: 14,
    marginBottom: 6,
  },

  cardTitle: {
    color: "#062B59",
    fontSize: 20,
    fontWeight: "700",
  },

  statusBadge: {
    flexDirection: "row",
    alignItems: "center",

    paddingVertical: 6,
    paddingHorizontal: 10,

    borderRadius: 20,
    borderWidth: 1,

    gap: 6,
  },

  statusBadgeText: {
    fontWeight: "700",
    fontSize: 12,
  },

  welcomeText: {
    color: "#475569",
    fontSize: 14,
    marginTop: 16,
    marginBottom: 20,
  },

  timeStatsRow: {
    flexDirection: "row",
    alignItems: "center",

    paddingTop: 18,
    borderTopWidth: 1,
    borderTopColor: "#EDF1F6",
  },

  timeStatCard: {
    flex: 1,
    alignItems: "center",
  },

  timeStatDivider: {
    width: 1,
    height: 52,
    backgroundColor: "#E2E8F0",
    marginHorizontal: 8,
  },

  timeStatIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,

    justifyContent: "center",
    alignItems: "center",

    marginBottom: 8,
  },

  timeLabel: {
    color: "#64748B",
    fontSize: 13,
    marginBottom: 4,
  },

  timeValue: {
    color: "#062B59",
    fontWeight: "700",
    fontSize: 16,
  },

  timeInButton: {
    height: 54,
    borderRadius: 14,
    backgroundColor: "#062B59",

    justifyContent: "center",
    alignItems: "center",

    flexDirection: "row",

    marginTop: 20,
  },

  buttonPressed: {
    opacity: 0.85,
  },

  buttonText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "700",
    marginLeft: 8,
  },

  timeOutButton: {
    height: 54,
    borderRadius: 14,

    justifyContent: "center",
    alignItems: "center",

    flexDirection: "row",

    marginTop: 12,

    borderWidth: 1,
  },

  timeOutText: {
    fontSize: 15,
    fontWeight: "700",
    marginLeft: 8,
  },

  disabledButtonOutline: {
    borderColor: "#CBD5E1",
    backgroundColor: "#F8FAFC",
  },

  disabledButtonFilled: {
    backgroundColor: "#94A3B8",
  },

  timeOutButtonActive: {
    borderColor: "#062B59",
    backgroundColor: "#062B59",
  },

  infoCard: {
    flexDirection: "row",
    alignItems: "center",

    backgroundColor: "#EFF6FF",

    borderWidth: 1,
    borderColor: "#BFDBFE",

    borderRadius: 14,

    padding: 14,

    marginTop: 20,
  },

  infoText: {
    flex: 1,
    marginLeft: 10,
    color: "#1E3A8A",
    fontSize: 13,
    lineHeight: 18,
  },
});
