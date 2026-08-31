import React, { forwardRef, useRef, useState } from "react";
import { Animated, FlatListProps, LayoutChangeEvent, StyleSheet, View, ViewStyle } from "react-native";

// FlatList counterpart to AestheticScrollView — same themed track/thumb
// overlay, driven off FlatList's own onScroll/onLayout/onContentSizeChange
// (it forwards these from the ScrollView it wraps internally).
type Props<T> = FlatListProps<T> & {
  trackStyle?: ViewStyle;
  thumbColor?: string;
  trackColor?: string;
};

// Animated.FlatList's generated prop types don't play nice with a generic
// `data: T[]` (the animated-props wrapper wants WithAnimatedObject<
// ArrayLike<T>>, which a plain array isn't assignable to under any of its
// call overloads) — cast the component to bypass that overload mismatch.
// The rendered component and its runtime behavior are unchanged; only the
// static typing of this reference is loosened.
const AnimatedFlatListAny = Animated.FlatList as any;

function AestheticFlatListInner<T>(
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
    ...rest
  }: Props<T>,
  ref: React.Ref<Animated.FlatList<T>>
) {
  const scrollPos = useRef(new Animated.Value(0)).current;
  const [metrics, setMetrics] = useState({ containerSize: 0, contentSize: 0 });

  const handleScroll = Animated.event(
    [{ nativeEvent: { contentOffset: { [horizontal ? "x" : "y"]: scrollPos } } }],
    { useNativeDriver: true, listener: onScroll }
  );

  const showBar = metrics.contentSize > metrics.containerSize && metrics.containerSize > 0;
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
    <View style={styles.wrap}>
      <AnimatedFlatListAny
        ref={ref}
        style={style}
        contentContainerStyle={[
          horizontal ? styles.contentHorizontal : styles.contentVertical,
          contentContainerStyle,
        ]}
        horizontal={horizontal}
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={handleScroll}
        onLayout={(e: LayoutChangeEvent) => {
          const size = horizontal ? e.nativeEvent.layout.width : e.nativeEvent.layout.height;
          setMetrics((m) => ({ ...m, containerSize: size }));
          onLayout?.(e);
        }}
        onContentSizeChange={(w: number, h: number) => {
          setMetrics((m) => ({ ...m, contentSize: horizontal ? w : h }));
          onContentSizeChange?.(w, h);
        }}
        {...rest}
      />

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
}

const AestheticFlatList = forwardRef(AestheticFlatListInner) as <T>(
  props: Props<T> & { ref?: React.Ref<Animated.FlatList<T>> }
) => React.ReactElement;

export default AestheticFlatList;

const styles = StyleSheet.create({
  wrap: {
    // flex: 1 is required here, not just on the inner FlatList below — a
    // flex value on a child only has something to grow into if its own
    // immediate parent has a determinate size. Without this, a caller that
    // places this component as a sibling of other content inside a flex
    // column (e.g. DTRScreen's card, with a pinnedHeader sibling above the
    // list) sees this wrapper collapse to ~0 height — the inner FlatList's
    // own flex:1 has nothing to expand into — and the list silently renders
    // nothing and can't even be pulled to refresh, despite having real data.
    flex: 1,
    position: "relative",
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
