import React, { useState } from "react";
import { SafeAreaView, View, Text, Pressable, StyleSheet, Alert, ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { acceptFaceConsent } from "../api";

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
      <ScrollView contentContainerStyle={styles.content}>
        <Ionicons name="scan-outline" size={48} color="#062B59" style={{ marginBottom: 12 }} />
        <Text style={styles.title}>Face Data Consent</Text>
        <Text style={styles.subtitle}>
          Before your account can be used for attendance, we need your consent to collect and use your facial
          data.
        </Text>

        <View style={styles.card}>
          <Text style={styles.cardHeading}>What this means</Text>
          <ConsentPoint text="Your facial data will be captured by an administrator and stored securely for face verification purposes." />
          <ConsentPoint text="Every time you time in or time out, your face will be scanned and matched against this data to confirm it's really you." />
          <ConsentPoint text="This data is used only for attendance authentication and will not be shared with third parties." />
          <ConsentPoint text="You are not required to capture your own face on this app — an administrator handles face registration on your behalf, but only after you accept this consent." />
        </View>

        <Text style={styles.disclaimer}>
          By tapping "I Accept", you consent to the collection, storage, and use of your facial data for
          attendance verification, in accordance with the Data Privacy Act of 2012.
        </Text>

        <Pressable style={[styles.button, isLoading && styles.buttonDisabled]} onPress={handleAccept} disabled={isLoading}>
          <Text style={styles.buttonText}>{isLoading ? "Saving..." : "I Accept"}</Text>
        </Pressable>
      </ScrollView>
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
