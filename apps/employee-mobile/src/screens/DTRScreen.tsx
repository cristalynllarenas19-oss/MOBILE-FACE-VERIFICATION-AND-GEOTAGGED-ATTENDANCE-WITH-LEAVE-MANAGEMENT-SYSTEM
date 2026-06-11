import React from "react";
import {
  View,
  Text,
  StyleSheet,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

export default function DTRScreen() {
  const records = [
    "Today - Present",
    "Yesterday - Present",
    "June 8 - Rest Day",
  ];

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>
        Daily Time Record
      </Text>

      {records.map((item) => (
        <View
          key={item}
          style={styles.listRow}
        >
          <Text style={styles.bodyText}>
            {item}
          </Text>

          <Ionicons
            name="checkmark-circle"
            size={20}
            color="#17a34a"
          />
        </View>
      ))}
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
    marginBottom: 10,
  },

  bodyText: {
    color: "#41536b",
  },

  listRow: {
    minHeight: 46,
    borderBottomWidth: 1,
    borderColor: "#edf3f8",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
});