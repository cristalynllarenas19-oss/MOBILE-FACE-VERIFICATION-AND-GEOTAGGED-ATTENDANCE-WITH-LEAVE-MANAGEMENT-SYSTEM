import { useEffect, useRef } from "react";
import { Animated, PanResponder, View } from "react-native";

// Pinch-to-zoom + pan for a viewed image. Deliberately a plain RN <Image>
// (not a WebView with the data embedded in an html string) — a multi-MB
// image blown up as an inline data: URI inside html source silently fails
// to render on Android (WebView's loadDataWithBaseURL has a low size
// ceiling), where a plain <Image source={{ uri }}> has no such limit. RN's
// own ScrollView zoom props (minimumZoomScale etc.) are iOS-only, hence
// this hand-rolled PanResponder version instead.
export function ZoomableImage({ uri, style }: { uri: string; style?: any }) {
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const currentScale = useRef(1);
  const currentTranslate = useRef({ x: 0, y: 0 });
  const gestureStartDistance = useRef<number | null>(null);
  const gestureStartScale = useRef(1);
  const gestureStartTranslate = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const scaleSub = scale.addListener(({ value }) => { currentScale.current = value; });
    const xSub = translateX.addListener(({ value }) => { currentTranslate.current.x = value; });
    const ySub = translateY.addListener(({ value }) => { currentTranslate.current.y = value; });
    return () => {
      scale.removeListener(scaleSub);
      translateX.removeListener(xSub);
      translateY.removeListener(ySub);
    };
  }, []);

  function distanceBetween(touches: { pageX: number; pageY: number }[]) {
    const [a, b] = touches;
    return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
  }

  function resetZoom() {
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, useNativeDriver: false }),
      Animated.spring(translateX, { toValue: 0, useNativeDriver: false }),
      Animated.spring(translateY, { toValue: 0, useNativeDriver: false }),
    ]).start();
  }

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponderCapture: (evt) =>
        evt.nativeEvent.touches.length === 2 || currentScale.current > 1,
      onPanResponderGrant: (evt) => {
        gestureStartScale.current = currentScale.current;
        gestureStartTranslate.current = { ...currentTranslate.current };
        gestureStartDistance.current = evt.nativeEvent.touches.length === 2 ? distanceBetween(evt.nativeEvent.touches) : null;
      },
      onPanResponderMove: (evt, gesture) => {
        const touches = evt.nativeEvent.touches;
        if (touches.length === 2) {
          if (!gestureStartDistance.current) {
            gestureStartDistance.current = distanceBetween(touches);
            return;
          }
          const nextScale = Math.min(
            4,
            Math.max(1, gestureStartScale.current * (distanceBetween(touches) / gestureStartDistance.current)),
          );
          scale.setValue(nextScale);
        } else if (touches.length === 1 && gestureStartScale.current > 1) {
          translateX.setValue(gestureStartTranslate.current.x + gesture.dx);
          translateY.setValue(gestureStartTranslate.current.y + gesture.dy);
        }
      },
      onPanResponderRelease: () => {
        gestureStartDistance.current = null;
        if (currentScale.current <= 1) resetZoom();
      },
    }),
  ).current;

  return (
    <View style={[style, { overflow: "hidden" }]} {...panResponder.panHandlers}>
      <Animated.Image
        source={{ uri }}
        resizeMode="contain"
        style={{
          width: "100%",
          height: "100%",
          transform: [{ scale }, { translateX }, { translateY }],
        }}
      />
    </View>
  );
}
