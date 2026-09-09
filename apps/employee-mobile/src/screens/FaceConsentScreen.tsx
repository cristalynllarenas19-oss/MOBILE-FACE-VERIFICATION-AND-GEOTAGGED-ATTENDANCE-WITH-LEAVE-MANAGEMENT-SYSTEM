import React, { useState } from "react";
import { SafeAreaView, View, Text, Pressable, StyleSheet, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { acceptFaceConsent } from "../api";
import AestheticScrollView from "../components/AestheticScrollView";

type Props = {
  onAccepted: (faceConsentAcceptedAt: string) => void;
};

export default function FaceConsentScreen({ onAccepted }: Props) {
  const [isLoading, setIsLoading] = useState(false);

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

  return (
    <SafeAreaView style={styles.container}>
      <AestheticScrollView contentContainerStyle={styles.content}>
        <Ionicons name="shield-checkmark-outline" size={48} color="#062B59" style={{ marginBottom: 12 }} />
        <Text style={styles.title}>Data Privacy Consent</Text>
        <Text style={styles.subtitle}>
          Before your account can be used for attendance and other employee services, we need your consent to
          collect and use your personal information.
        </Text>

        <View style={styles.card}>
          <Text style={styles.cardHeading}>What this means</Text>
          <ConsentPoint text="Your facial biometric data will be captured by an authorized administrator during face registration and stored securely for attendance verification." />
          <ConsentPoint text="Your face may be scanned during time in and time out to verify your identity and confirm that the attendance action belongs to you." />
          <ConsentPoint text="Your location is collected when you perform an attendance action to verify that you are within an authorized work area. The location is associated with your attendance record for geotagged attendance verification." />
          <ConsentPoint text="Your attendance information — including time in, time out, date, location, and related records — will be recorded for attendance monitoring and reporting." />
          <ConsentPoint text="Your leave applications and related records may be collected and processed for leave management and administrative purposes." />
          <ConsentPoint text="Your personal information will only be accessed and used by authorized personnel such as your supervisor and HR administrator for legitimate attendance monitoring, and leave management purposes." />
          <ConsentPoint text="Your data will not be sold, rented, or disclosed to any third party outside the company without your consent, except when required by law." />
        </View>

        <Text style={styles.disclaimer}>
          By tapping "I Agree", you consent to the collection, processing, and storage of your personal
          information including facial biometric data, geolocation, attendance, and leave records  in
          accordance with the Data Privacy Act of 2012 (Republic Act No. 10173). You may review this consent
          again anytime from Settings.
        </Text>

        <Pressable style={[styles.button, isLoading && styles.buttonDisabled]} onPress={handleAccept} disabled={isLoading}>
          <Text style={styles.buttonText}>{isLoading ? "Saving..." : "I Agree"}</Text>
        </Pressable>
      </AestheticScrollView>
    </SafeAreaView>
  );
}

function ConsentPoint({ text }: { text: string }) {
  return (
    <View style={styles.pointRow}>
      <Ionicons name="checkmark-circle" size={18} color="#16A34A" style={{ marginTop: 1 }} />
      <Text style={styles.pointText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F1F5F9" },
  content: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 60, paddingBottom: 40 },
  title: { fontSize: 26, fontWeight: "700", color: "#062B59" },
  subtitle: { color: "#64748B", marginTop: 8, marginBottom: 20, fontSize: 14, lineHeight: 20 },
  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#D9E2EC",
    padding: 18,
    marginBottom: 18,
  },
  cardHeading: { fontWeight: "700", color: "#0F172A", fontSize: 15, marginBottom: 12 },
  pointRow: { flexDirection: "row", gap: 10, marginBottom: 12 },
  pointText: { flex: 1, color: "#334155", fontSize: 13.5, lineHeight: 19 },
  disclaimer: { color: "#94A3B8", fontSize: 12, lineHeight: 18, marginBottom: 24 },
  button: {
    height: 58,
    borderRadius: 16,
    backgroundColor: "#062B59",
    justifyContent: "center",
    alignItems: "center",
  },
  buttonDisabled: { backgroundColor: "#94A3B8" },
  buttonText: { color: "#FFFFFF", fontWeight: "700", fontSize: 16 },
});
