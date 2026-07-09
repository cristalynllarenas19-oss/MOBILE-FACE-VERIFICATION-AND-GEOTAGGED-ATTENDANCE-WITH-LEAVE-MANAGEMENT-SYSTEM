import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { initials, colorFor } from "../utils/avatar";

type Props = {
  firstName?: string;
  lastName?: string;
  size?: number;
};

export default function Avatar({ firstName, lastName, size = 40 }: Props) {
  const bg = colorFor(`${firstName ?? ""}${lastName ?? ""}`);
  return (
    <View style={[styles.circle, { width: size, height: size, borderRadius: size / 2, backgroundColor: `${bg}1F` }]}>
      <Text style={[styles.text, { color: bg, fontSize: size * 0.38 }]}>{initials(firstName, lastName)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  circle: { alignItems: "center", justifyContent: "center" },
  text: { fontWeight: "800" },
});
