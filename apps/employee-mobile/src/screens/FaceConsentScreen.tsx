import React, { useState } from "react";
import { View, Text, Pressable, StyleSheet, Alert, NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { acceptFaceConsent } from "../api";
import AestheticScrollView from "../components/AestheticScrollView";

type Props = {
  onAccepted: (faceConsentAcceptedAt: string) => void;
};

const CONSENT_POINTS = [
  "Your facial biometric data will be captured by an authorized administrator during face registration and stored securely for attendance verification.",
  "Your face may be scanned during time in and time out to verify your identity and confirm that the attendance action belongs to you.",
  "Your location is collected when you perform an attendance action to verify that you are within an authorized work area. The location is associated with your attendance record for geotagged attendance verification.",
  "Your attendance information — including time in, time out, date, location, and related records — will be recorded for attendance monitoring and reporting.",
  "Your leave applications and related records may be collected and processed for leave management and administrative purposes.",
  "Your personal information will only be accessed and used by authorized personnel such as your supervisor and HR administrator for legitimate attendance monitoring and leave management purposes.",
  "Your data will not be sold, rented, or disclosed to any third party outside the company without your consent, except when required by law.",
];

// Layout: fixed header / independently scrolling notice card / fixed footer,
// so "I Agree" is always on screen no matter how long the notice is.
export default function FaceConsentScreen({ onAccepted }: Props) {
  const insets = useSafeAreaInsets();
  const [isLoading, setIsLoading] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  // Tall screens may fit the whole notice — no hint needed then.
  const fitsWithoutScroll = viewportHeight > 0 && contentHeight > 0 && contentHeight <= viewportHeight;

  async function handleAccept() {
    setIsLoading(true);
    try {
      const faceConsentAcceptedAt = await acceptFaceConsent();
      onAccepted(faceConsentAcceptedAt);
    } catch (error) {
      Alert.alert("Something Went Wrong", error instanceof Error ? error.message : "Please try again.");
    } finally {
      setIsLoading(false);
    }
  }

  // Only drives the "scroll to read" hint — agreeing is never gated on it.
  function handleScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    if (reachedEnd) return;
    const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
    if (layoutMeasurement.height + contentOffset.y >= contentSize.height - 24) setReachedEnd(true);
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top + 20 }]}>
      <View style={styles.header}>
        <View style={styles.iconBadge}>
          <Ionicons name="shield-checkmark-outline" size={28} color="#062B59" />
        </View>
        <Text style={styles.title}>Data Privacy Consent</Text>
        <Text style={styles.subtitle}>
          Before your account can be used for attendance and other employee services, we need your consent to
          collect and use your personal information.
        </Text>
      </View>

      <View style={styles.card}>
        <AestheticScrollView
          style={styles.cardScroll}
          contentContainerStyle={styles.cardContent}
          onScroll={handleScroll}
          onLayout={(e) => setViewportHeight(e.nativeEvent.layout.height)}
          onContentSizeChange={(_, h) => setContentHeight(h)}
        >
          <Text style={styles.sectionHeading}>What this means</Text>
          {CONSENT_POINTS.map((text, i) => (
            <ConsentPoint key={i} text={text} last={i === CONSENT_POINTS.length - 1} />
          ))}

          <View style={styles.divider} />

          <Text style={styles.sectionHeading}>Your rights</Text>
          <Text style={styles.bodyText}>
            Your personal information is processed in accordance with the Data Privacy Act of 2012 (Republic Act
            No. 10173). You may review this consent again anytime from Settings.
          </Text>
        </AestheticScrollView>

        {!reachedEnd && !fitsWithoutScroll && contentHeight > 0 && (
          <View style={styles.scrollHint} pointerEvents="none">
            <Ionicons name="chevron-down" size={14} color="#64748B" />
            <Text style={styles.scrollHintText}>Scroll to review the full notice</Text>
          </View>
        )}
      </View>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
        <Text style={styles.disclaimer}>
          By tapping "I Agree", you consent to the collection, processing, and storage of your personal
          information including facial biometric data, geolocation, attendance, and leave records in accordance
          with the Data Privacy Act of 2012 (Republic Act No. 10173).
        </Text>
        <Pressable
          style={({ pressed }) => [styles.button, pressed && styles.buttonPressed, isLoading && styles.buttonDisabled]}
          onPress={handleAccept}
          disabled={isLoading}
        >
          <Text style={styles.buttonText}>{isLoading ? "Saving..." : "I Agree"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ConsentPoint({ text, last }: { text: string; last?: boolean }) {
  return (
    <View style={[styles.pointRow, last && { marginBottom: 0 }]}>
      <Ionicons name="checkmark-circle" size={18} color="#16A34A" style={{ marginTop: 1 }} />
      <Text style={styles.pointText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F1F5F9" },
  header: { paddingHorizontal: 24, marginBottom: 16 },
  iconBadge: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: "#E6EDF5",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 12,
  },
  title: { fontSize: 24, fontWeight: "700", color: "#062B59" },
  subtitle: { color: "#64748B", marginTop: 6, fontSize: 14, lineHeight: 20 },
  card: {
    flex: 1,
    marginHorizontal: 16,
    marginBottom: 12,
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#D9E2EC",
    overflow: "hidden",
  },
  cardScroll: { flex: 1 },
  cardContent: { paddingHorizontal: 18, paddingTop: 18, paddingBottom: 36 },
  sectionHeading: { fontWeight: "700", color: "#0F172A", fontSize: 15, marginBottom: 12 },
  pointRow: { flexDirection: "row", gap: 10, marginBottom: 14 },
  pointText: { flex: 1, color: "#334155", fontSize: 14, lineHeight: 20 },
  divider: { height: 1, backgroundColor: "#E2E8F0", marginVertical: 18 },
  bodyText: { color: "#334155", fontSize: 14, lineHeight: 20 },
  scrollHint: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 4,
    paddingVertical: 8,
    backgroundColor: "rgba(255,255,255,0.94)",
    borderTopWidth: 1,
    borderTopColor: "#EEF2F6",
  },
  scrollHintText: { color: "#64748B", fontSize: 12, fontWeight: "600" },
  footer: {
    paddingHorizontal: 20,
    paddingTop: 14,
    backgroundColor: "#FFFFFF",
    borderTopWidth: 1,
    borderTopColor: "#D9E2EC",
    shadowColor: "#0F172A",
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 8,
  },
  disclaimer: { color: "#64748B", fontSize: 12, lineHeight: 17, marginBottom: 12 },
  button: {
    height: 54,
    borderRadius: 14,
    backgroundColor: "#062B59",
    justifyContent: "center",
    alignItems: "center",
  },
  buttonPressed: { opacity: 0.9 },
  buttonDisabled: { backgroundColor: "#94A3B8" },
  buttonText: { color: "#FFFFFF", fontWeight: "700", fontSize: 16 },
});
