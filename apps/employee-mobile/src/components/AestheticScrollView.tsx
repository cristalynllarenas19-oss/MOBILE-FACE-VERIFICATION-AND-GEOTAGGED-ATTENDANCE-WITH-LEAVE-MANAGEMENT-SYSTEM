import React, { forwardRef, useRef, useState } from "react";
import { Animated, ScrollViewProps, StyleSheet, View, ViewStyle } from "react-native";

// Drop-in replacement for RN's <ScrollView> — RN's built-in scroll
// indicator can't be restyled (no rounding, no color, no hover), so this
// tracks scroll position/content size itself and draws a themed thumb over
// the content instead. Supports vertical (default) and horizontal.
type Props = ScrollViewProps & {
  trackStyle?: ViewStyle;
  thumbColor?: string;
  trackColor?: string;
  hideThumb?: boolean;
};

const AestheticScrollView = forwardRef<any, Props>(function AestheticScrollView(
  {
    style,
    contentContainerStyle,
    onScroll,
    onLayout,
    onContentSizeChange,
    horizontal,
    trackStyle,
    thumbColor = "#94A3B8",
    trackColor = "#F1F5F9",
    hideThumb = false,
    children,
    ...rest
  },
  ref
) {
  const scrollPos = useRef(new Animated.Value(0)).current;
  const [metrics, setMetrics] = useState({ containerSize: 0, contentSize: 0 });

  const handleScroll = Animated.event(
    [{ nativeEvent: { contentOffset: { [horizontal ? "x" : "y"]: scrollPos } } }],
    { useNativeDriver: true, listener: onScroll }
  );

  const showBar = !hideThumb && metrics.contentSize > metrics.containerSize && metrics.containerSize > 0;
  let thumbSize = 0;
  let maxThumbTravel = 0;
  let maxScroll = 1;
  if (showBar) {
    thumbSize = Math.max(24, (metrics.containerSize * metrics.containerSize) / metrics.contentSize);
    maxThumbTravel = metrics.containerSize - thumbSize;
    maxScroll = metrics.contentSize - metrics.containerSize;
  }
  const translate = scrollPos.interpolate({
    inputRange: [0, maxScroll],
    outputRange: [0, maxThumbTravel],
    extrapolate: "clamp",
  });

  return (
    <View style={[styles.wrap, style]}>
      <Animated.ScrollView
        ref={ref}
        style={styles.scroller}
        contentContainerStyle={[
          horizontal ? styles.contentHorizontal : styles.contentVertical,
          contentContainerStyle,
        ]}
        horizontal={horizontal}
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={handleScroll}
        onLayout={(e) => {
          const size = horizontal ? e.nativeEvent.layout.width : e.nativeEvent.layout.height;
          setMetrics((m) => ({ ...m, containerSize: size }));
          onLayout?.(e);
        }}
        onContentSizeChange={(w, h) => {
          setMetrics((m) => ({ ...m, contentSize: horizontal ? w : h }));
          onContentSizeChange?.(w, h);
        }}
        {...rest}
      >
        {children}
      </Animated.ScrollView>

      {showBar && (
        <View
          style={[
            horizontal ? styles.trackHorizontal : styles.trackVertical,
            { backgroundColor: trackColor },
            trackStyle,
          ]}
          pointerEvents="none"
        >
          <Animated.View
            style={[
              horizontal ? styles.thumbHorizontal : styles.thumbVertical,
              { backgroundColor: thumbColor },
              horizontal
                ? { width: thumbSize, transform: [{ translateX: translate }] }
                : { height: thumbSize, transform: [{ translateY: translate }] },
            ]}
          />
        </View>
      )}
    </View>
  );
});

export default AestheticScrollView;

const styles = StyleSheet.create({
  wrap: {
    position: "relative",
  },
  scroller: {
    flexGrow: 1,
    flexShrink: 1,
  },
  contentVertical: {
    paddingRight: 12,
  },
  contentHorizontal: {
    paddingBottom: 12,
  },
  trackVertical: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 2,
    width: 4,
    borderRadius: 2,
  },
  trackHorizontal: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 2,
    height: 4,
    borderRadius: 2,
  },
  thumbVertical: {
    width: 4,
    borderRadius: 2,
  },
  thumbHorizontal: {
    height: 4,
    borderRadius: 2,
  },
});
