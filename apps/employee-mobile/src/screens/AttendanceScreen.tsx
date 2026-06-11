import React from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

type Props = {
  isLoading: boolean;
  onTimeIn: () => void;
  onTimeOut: () => void;
};

export default function AttendanceScreen({
  isLoading,
  onTimeIn,
  onTimeOut,
}: Props) {
  return (
    <View style={styles.card}>
      <Ionicons
        color="#1680d8"
        name="scan-outline"
        size={34}
      />

      <Text style={styles.cardTitle}>
        Face Verification Attendance
      </Text>

      <Text style={styles.bodyText}>
        The production setup should replace
        the demo scores with AWS Rekognition
        Face Liveness and face match results.
      </Text>

      <Pressable
        disabled={isLoading}
        onPress={onTimeIn}
        style={styles.primaryButton}
      >
        <Text style={styles.primaryButtonText}>
          {isLoading ? "Loading..." : "Time In"}
        </Text>
      </Pressable>

      <Pressable
        disabled={isLoading}
        onPress={onTimeOut}
        style={styles.secondaryButton}
      >
        <Text style={styles.secondaryButtonText}>
          Time Out
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: 18,
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#dbe5ef",
    
  },

  cardTitle: {
    color: "#062b59",
    fontSize: 18,
    fontWeight: "900",
    marginTop: 8,
    marginBottom: 8,
  },

  bodyText: {
    color: "#41536b",
    lineHeight: 21,
  },

  primaryButton: {
    minHeight: 46,
    borderRadius: 8,
    backgroundColor: "#244c7a",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 15,
  },

  primaryButtonText: {
    color: "#fff",
    fontWeight: "900",
  },

  secondaryButton: {
    minHeight: 46,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#244c7a",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 10,
  },

  secondaryButtonText: {
    color: "#244c7a",
    fontWeight: "900",
  },
});