import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { AttendanceEligibility, TodayAttendance } from "../api";

type Props = {
  user: any;
  isLoading: boolean;
  todayAttendance: TodayAttendance | null;
  eligibility: AttendanceEligibility | null;
  onTimeIn: () => void;
  onTimeOut: () => void;
  onLunchOut: () => void;
  onLunchIn: () => void;
};

function getEligibilityMessage(eligibility: AttendanceEligibility | null) {
  if (!eligibility) return "Checking your attendance eligibility...";
  if (!eligibility.faceEnrolled && !eligibility.hasWorkLocation) {
    return "Your face is not yet registered and you haven't been assigned a work location. Contact HR to get set up before recording attendance.";
  }
  if (!eligibility.faceEnrolled) {
    return "Your face is not yet registered for attendance verification. Contact HR to complete your face enrollment.";
  }
  if (!eligibility.hasWorkLocation) {
    return "You haven't been assigned a work location yet. Contact HR or your supervisor.";
  }
  return null;
}

// Worked time is Time In → Time Out (or now, while still in), excluding the
// lunch break — an open lunch (started but not ended) pauses the counter.
function getWorkedMs(attendance: TodayAttendance, now: number) {
  if (!attendance.timeInAt) return 0;
  const start = new Date(attendance.timeInAt).getTime();
  const end = attendance.timeOutAt
    ? new Date(attendance.timeOutAt).getTime()
    : now;
  let worked = end - start;
  if (attendance.lunchOutAt) {
    const lunchStart = new Date(attendance.lunchOutAt).getTime();
    const lunchEnd = attendance.lunchInAt
      ? new Date(attendance.lunchInAt).getTime()
      : end;
    worked -= Math.max(0, lunchEnd - lunchStart);
  }
  return Math.max(0, worked);
}

function formatElapsed(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return [
    pad(Math.floor(totalSeconds / 3600)),
    pad(Math.floor((totalSeconds % 3600) / 60)),
    pad(totalSeconds % 60),
  ].join(":");
}

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
  eligibility,
  onTimeIn,
  onTimeOut,
  onLunchOut,
  onLunchIn,
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

  // Sunday is a company-wide rest day for every role — no attendance is
  // taken or required from anyone, mirrored from the same rule enforced
  // server-side in AttendanceService.submit().
  const isTodayDayOff = new Date().getDay() === 0;

  const hasTimedIn = Boolean(todayAttendance?.timeInAt);
  const hasTimedOut = Boolean(todayAttendance?.timeOutAt);
  // For FIELD employees, todayAttendance is the latest visit of the day —
  // an "open" visit is one that's started but hasn't been ended yet.
  const hasOpenVisit = hasTimedIn && !hasTimedOut;

  // Live worked-time counter (OFFICE-only): ticks every second while the
  // session is open, then holds the final Time In → Time Out total once
  // timed out.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (isField || !hasOpenVisit) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [isField, hasOpenVisit]);

  const workedMs = todayAttendance ? getWorkedMs(todayAttendance, now) : 0;
  const isOnLunch = Boolean(
    hasOpenVisit && todayAttendance?.lunchOutAt && !todayAttendance?.lunchInAt,
  );

  const statusLabel = isTodayDayOff && !hasTimedIn
    ? "Day Off"
    : isField
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

  const statusColor = isTodayDayOff && !hasTimedIn
    ? "#64748B"
    : isField
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

  // Time In/Out (and therefore Lunch, which requires having timed in) is
  // unavailable until the employee has completed face registration and been
  // assigned a work location — mirrors the same gate enforced server-side.
  const isEligible = Boolean(eligibility?.faceEnrolled && eligibility?.hasWorkLocation);
  const eligibilityMessage = getEligibilityMessage(eligibility);

  const timeInDisabled = isLoading || !isEligible || isTodayDayOff || (isField ? hasOpenVisit : hasTimedIn);
  const timeOutDisabled = isField
    ? isLoading || !isEligible || isTodayDayOff || !hasOpenVisit
    : isLoading || !isEligible || isTodayDayOff || !hasTimedIn || hasTimedOut;

  // Lunch break is optional and OFFICE-only: shown once timed in, hidden for
  // FIELD employees entirely. The single button toggles between logging the
  // start and the end of the break, then goes inert once both are logged —
  // it never blocks Time Out either way.
  const hasLunchOut = Boolean(todayAttendance?.lunchOutAt);
  const hasLunchIn = Boolean(todayAttendance?.lunchInAt);
  const showLunchSection = !isField && hasTimedIn;
  const lunchCompleted = hasLunchOut && hasLunchIn;
  const lunchButtonDisabled = isLoading || !isEligible || hasTimedOut || lunchCompleted;
  const lunchButtonLabel = lunchCompleted ? "LUNCH COMPLETED" : hasLunchOut ? "LUNCH END" : "LUNCH START";
  const handleLunchPress = hasLunchOut && !hasLunchIn ? onLunchIn : onLunchOut;

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

        <Text
          style={[
            styles.welcomeText,
            !isField && hasTimedIn && { marginBottom: 12 },
          ]}
        >
          Welcome back,
          {" "}
          {user?.displayName}
        </Text>

        {!isField && hasTimedIn && (
          <View style={styles.workedTimeRow}>
            <View style={styles.workedTimeHeader}>
              {hasOpenVisit && (
                <Ionicons
                  name="ellipse"
                  size={7}
                  color={isOnLunch ? "#EA580C" : "#17A34A"}
                />
              )}

              <Text style={styles.workedTimeLabel}>
                {hasTimedOut
                  ? "Total Time Worked"
                  : isOnLunch
                    ? "Time Worked (On Lunch)"
                    : "Time Worked"}
              </Text>
            </View>

            <Text
              style={[
                styles.workedTimeValue,
                hasTimedOut && { color: "#17A34A" },
              ]}
            >
              {formatElapsed(workedMs)}
            </Text>
          </View>
        )}

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

        {showLunchSection && (
          <View style={styles.timeStatsRow}>
            <View style={styles.timeStatCard}>
              <View style={[styles.timeStatIcon, { backgroundColor: "#FFF7ED" }]}>
                <Ionicons
                  name="cafe-outline"
                  size={18}
                  color="#EA580C"
                />
              </View>

              <Text style={styles.timeLabel}>
                Lunch Start
              </Text>

              <Text style={styles.timeValue}>
                {formatTime(todayAttendance?.lunchOutAt)}
              </Text>
            </View>

            <View style={styles.timeStatDivider} />

            <View style={styles.timeStatCard}>
              <View style={[styles.timeStatIcon, { backgroundColor: "#FFF7ED" }]}>
                <Ionicons
                  name="cafe"
                  size={18}
                  color="#EA580C"
                />
              </View>

              <Text style={styles.timeLabel}>
                Lunch End
              </Text>

              <Text style={styles.timeValue}>
                {formatTime(todayAttendance?.lunchInAt)}
              </Text>
            </View>
          </View>
        )}
      </View>

      {isTodayDayOff && !hasTimedIn && (
        <View style={styles.dayOffCard}>
          <Ionicons
            name="moon-outline"
            size={22}
            color="#64748B"
          />

          <Text style={styles.dayOffText}>
            Today is your day off (Sunday). Attendance is not required.
          </Text>
        </View>
      )}

      {eligibilityMessage && (
        <View style={styles.eligibilityWarningCard}>
          <Ionicons
            name="alert-circle-outline"
            size={22}
            color="#DC2626"
          />

          <Text style={styles.eligibilityWarningText}>
            {eligibilityMessage}
          </Text>
        </View>
      )}

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

      {showLunchSection && (
        <Pressable
          disabled={lunchButtonDisabled}
          onPress={handleLunchPress}
          style={({ pressed }) => [
            styles.lunchButton,
            lunchButtonDisabled
              ? styles.disabledButtonOutline
              : styles.lunchButtonActive,
            pressed && !lunchButtonDisabled && styles.buttonPressed,
          ]}
        >
          <Ionicons
            name="cafe-outline"
            size={20}
            color={lunchButtonDisabled ? "#94A3B8" : "#EA580C"}
          />

          <Text
            style={[
              styles.lunchButtonText,
              { color: lunchButtonDisabled ? "#94A3B8" : "#EA580C" },
            ]}
          >
            {isLoading ? "Loading..." : lunchButtonLabel}
          </Text>
        </Pressable>
      )}

      {isEligible && (
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
      )}
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

  workedTimeRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",

    backgroundColor: "#F8FAFC",

    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 10,

    paddingVertical: 8,
    paddingHorizontal: 12,

    marginBottom: 14,
  },

  workedTimeHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },

  workedTimeLabel: {
    color: "#64748B",
    fontSize: 13,
    fontWeight: "600",
  },

  workedTimeValue: {
    color: "#062B59",
    fontSize: 16,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
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

  lunchButton: {
    height: 54,
    borderRadius: 14,

    justifyContent: "center",
    alignItems: "center",

    flexDirection: "row",

    marginTop: 12,

    borderWidth: 1,
  },

  lunchButtonActive: {
    borderColor: "#EA580C",
    backgroundColor: "#FFF7ED",
  },

  lunchButtonText: {
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

  eligibilityWarningCard: {
    flexDirection: "row",
    alignItems: "center",

    backgroundColor: "#FEF2F2",

    borderWidth: 1,
    borderColor: "#FECACA",

    borderRadius: 14,

    padding: 14,

    marginTop: 20,
  },

  eligibilityWarningText: {
    flex: 1,
    marginLeft: 10,
    color: "#991B1B",
    fontSize: 13,
    lineHeight: 18,
  },

  dayOffCard: {
    flexDirection: "row",
    alignItems: "center",

    backgroundColor: "#F1F5F9",

    borderWidth: 1,
    borderColor: "#CBD5E1",

    borderRadius: 14,

    padding: 14,

    marginTop: 20,
  },

  dayOffText: {
    flex: 1,
    marginLeft: 10,
    color: "#475569",
    fontSize: 13,
    lineHeight: 18,
  },
});
