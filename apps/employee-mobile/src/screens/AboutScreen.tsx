import React from "react";
import { View, Text, Pressable, StyleSheet, ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import appConfig from "../../app.json";

type Props = {
  onClose: () => void;
};

export default function AboutScreen({ onClose }: Props) {
  const version = appConfig.expo.version ?? "1.0.0";

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <Pressable onPress={onClose} style={styles.backButton} hitSlop={10}>
        <Ionicons name="arrow-back" size={24} color="#062B59" />
      </Pressable>

      <Text style={styles.title}>About</Text>
      <Text style={styles.appName}>Universal Leaf Attendance</Text>
      <Text style={styles.version}>Version {version}</Text>

      <Text style={styles.sectionHeading}>Data Privacy Consent</Text>

      <Text style={styles.paragraph}>
        In compliance with the requirements of the Data Privacy Act of 2012 (Republic Act No. 10173), Universal
        Leaf hereby informs you that this application collects, processes, and stores your personal information —
        including your facial biometric data, real-time location, and attendance and leave records — solely for
        the purpose of verifying your identity, recording your attendance, and administering leave management.
      </Text>

      <Text style={styles.paragraph}>
        Your facial biometric data is captured during face registration and is used exclusively to verify your
        identity when you time in, time out, or file attendance-related requests. Your geolocation is captured at
        the time of each attendance action to confirm that it was made within an authorized work area.
      </Text>

      <Text style={styles.paragraph}>
        We understand and agree that this information may be disclosed or shared with authorized personnel within
        the company (such as your supervisor and HR administrators) for legitimate attendance monitoring, payroll,
        and leave management purposes only. Your data will not be sold, rented, or disclosed to any third party
        outside the company without your consent, except when required by law.
      </Text>

      <Text style={styles.paragraph}>
        Your personal information will continue to be stored for as long as your employment record is active, or
        until the retention period required by applicable law has lapsed, whichever comes later.
      </Text>

      <Text style={styles.paragraph}>
        You may request access to, correction of, or withdrawal of consent to process your personal data by
        contacting your HR department. By using this application, you confirm that you have read, understood, and
        agree to this Data Privacy Consent.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#FFFFFF" },
  content: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 40 },
  backButton: { width: 40, height: 40, justifyContent: "center" },
  title: { fontSize: 22, fontWeight: "700", color: "#062B59", marginTop: 0 },
  appName: { fontSize: 15, fontWeight: "700", color: "#334155", marginTop: 14 },
  version: { fontSize: 12, color: "#64748B", marginTop: 2, marginBottom: 20 },
  sectionHeading: {
    fontSize: 13,
    fontWeight: "700",
    color: "#062B59",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 10,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: "#EDF3F8",
  },
  paragraph: { fontSize: 13, lineHeight: 20, color: "#334155", marginBottom: 14 },
});
