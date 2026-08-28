import React, { useEffect, useRef, useState } from "react";
import { Animated, LayoutChangeEvent, Pressable, StyleSheet, Text, View, ViewStyle } from "react-native";

const PADDING = 4;

export type SegmentedControlOption = { key: string; label: string };

export default function SegmentedControl({
  segments,
  value,
  onChange,
  style,
}: {
  segments: SegmentedControlOption[];
  value: string;
  onChange: (key: string) => void;
  style?: ViewStyle;
}) {
  const activeIndex = Math.max(0, segments.findIndex((s) => s.key === value));
  const [trackWidth, setTrackWidth] = useState(0);
  const anim = useRef(new Animated.Value(activeIndex)).current;

  useEffect(() => {
    Animated.spring(anim, {
      toValue: activeIndex,
      useNativeDriver: true,
      speed: 20,
      bounciness: 6,
    }).start();
  }, [activeIndex, anim]);

  function handleLayout(e: LayoutChangeEvent) {
    setTrackWidth(e.nativeEvent.layout.width);
  }

  const segmentWidth = segments.length > 0 ? (trackWidth - PADDING * 2) / segments.length : 0;
  // interpolate needs >=2 points even for a single-segment control
  const inputRange = segments.length > 1 ? segments.map((_, i) => i) : [0, 1];
  const outputRange = segments.length > 1 ? segments.map((_, i) => i * segmentWidth) : [0, 0];

  return (
    <View style={[styles.track, style]} onLayout={handleLayout}>
      {trackWidth > 0 && (
        <Animated.View
          style={[
            styles.thumb,
            {
              width: segmentWidth,
              transform: [{ translateX: anim.interpolate({ inputRange, outputRange }) }],
            },
          ]}
        />
      )}
      {segments.map((segment) => {
        const isActive = segment.key === value;
        return (
          <Pressable key={segment.key} style={styles.button} onPress={() => onChange(segment.key)} hitSlop={4}>
            <Text
              style={[styles.label, isActive && styles.labelActive]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.82}
            >
              {segment.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: "row",
    backgroundColor: "#F1F5F9",
    borderRadius: 999,
    padding: PADDING,
  },
  thumb: {
    position: "absolute",
    top: PADDING,
    bottom: PADDING,
    left: PADDING,
    backgroundColor: "#062B59",
    borderRadius: 999,
    shadowColor: "#062B59",
    shadowOpacity: 0.25,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  button: {
    flex: 1,
    paddingVertical: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  label: {
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: 0.2,
    color: "#64748B",
  },
  labelActive: {
    color: "#FFFFFF",
  },
});
