import React from "react";
import {
  View,
  Text,
  Pressable,
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

  const hasTimedIn = Boolean(todayAttendance?.timeInAt);
  const hasTimedOut = Boolean(todayAttendance?.timeOutAt);

  const statusLabel = hasTimedOut
    ? "Day Completed"
    : hasTimedIn
      ? "Timed In"
      : "Not Timed In";

  const statusColor = hasTimedOut
    ? "#17A34A"
    : hasTimedIn
      ? "#1680D8"
      : "#EF4444";

  const timeInDisabled = isLoading || hasTimedIn;
  const timeOutDisabled = isLoading || !hasTimedIn || hasTimedOut;

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.date}>
          {today}
        </Text>

        <Text style={styles.cardTitle}>
          Attendance Status
        </Text>

        <View style={styles.statusRow}>
          <Ionicons
            name="ellipse"
            size={12}
            color={statusColor}
          />

          <Text style={[styles.statusText, { color: statusColor }]}>
            {statusLabel}
          </Text>
        </View>

        <Text style={styles.welcomeText}>
          Welcome back,
          {" "}
          {user?.displayName}
        </Text>

        <View style={styles.timeRow}>
          <Text style={styles.timeLabel}>
            Time In
          </Text>

          <Text style={styles.timeValue}>
            {formatTime(todayAttendance?.timeInAt)}
          </Text>
        </View>

        <View style={styles.timeRow}>
          <Text style={styles.timeLabel}>
            Time Out
          </Text>

          <Text style={styles.timeValue}>
            {formatTime(todayAttendance?.timeOutAt)}
          </Text>
        </View>
      </View>

      <Pressable
        disabled={timeInDisabled}
        onPress={onTimeIn}
        style={[
          styles.timeInButton,
          timeInDisabled && styles.disabledButtonFilled,
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
            : "TIME IN"}
        </Text>
      </Pressable>

      <Pressable
        disabled={timeOutDisabled}
        onPress={onTimeOut}
        style={[
          styles.timeOutButton,
          timeOutDisabled
            ? styles.disabledButtonOutline
            : styles.timeOutButtonActive,
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
          TIME OUT
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
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

  date: {
    color: "#64748B",
    fontSize: 14,
    marginBottom: 18,
  },

  cardTitle: {
    color: "#062B59",
    fontSize: 20,
    fontWeight: "700",
    marginBottom: 14,
  },

  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 14,
  },

  statusText: {
    color: "#EF4444",
    fontWeight: "700",
    fontSize: 16,
    marginLeft: 8,
  },

  welcomeText: {
    color: "#475569",
    fontSize: 14,
    marginBottom: 20,
  },

  timeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 14,
  },

  timeLabel: {
    color: "#64748B",
    fontSize: 15,
  },

  timeValue: {
    color: "#062B59",
    fontWeight: "700",
    fontSize: 15,
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