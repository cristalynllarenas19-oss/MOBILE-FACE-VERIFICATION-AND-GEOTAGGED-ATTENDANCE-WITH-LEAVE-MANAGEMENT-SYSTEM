import React from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

export default function LeaveScreen() {
  return (
    <View style={styles.card}>
      <Ionicons
        color="#dc2777"
        name="document-text-outline"
        size={34}
      />

      <Text style={styles.cardTitle}>
        Leave Filing
      </Text>

      <TextInput
        placeholder="Leave Type"
        style={styles.input}
      />

      <TextInput
        placeholder="Reason"
        multiline
        style={[styles.input, styles.textArea]}
      />

      <Pressable style={styles.button}>
        <Text style={styles.buttonText}>
          Submit Leave Request
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
    marginVertical: 10,
  },

  input: {
    minHeight: 46,
    borderWidth: 1,
    borderColor: "#dbe5ef",
    borderRadius: 8,
    backgroundColor: "#fff",
    paddingHorizontal: 12,
    marginBottom: 12,
  },

  textArea: {
    minHeight: 100,
    textAlignVertical: "top",
    paddingTop: 12,
  },

  button: {
    minHeight: 46,
    borderRadius: 8,
    backgroundColor: "#244c7a",
    alignItems: "center",
    justifyContent: "center",
  },

  buttonText: {
    color: "#fff",
    fontWeight: "900",
  },
});