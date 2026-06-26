import React, { useEffect, useRef } from "react";
import { Asset } from "expo-asset";
import {
  Animated,
  Dimensions,
  Easing,
  Image,
  StyleSheet,
  View,
} from "react-native";

const { width } = Dimensions.get("window");
const FADE_IN_DURATION_MS = 4000;
const LOGIN_LOGO = require("../assets/unileaf-logo.png");
const SPLASH_LOGO = require("../assets/ULPI-logo.png");

type Props = {
  onAnimationComplete: () => void;
};

export default function SplashScreen({ onAnimationComplete }: Props) {
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Asset.loadAsync([LOGIN_LOGO]).catch((error) => {
      console.error("Failed to preload login logo", error);
    });
  }, []);

  useEffect(() => {
    const animation = Animated.timing(opacity, {
      toValue: 1,
      duration: FADE_IN_DURATION_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });

    animation.start(({ finished }) => {
      if (finished) {
        onAnimationComplete();
      }
    });

    return () => animation.stop();
  }, [onAnimationComplete, opacity]);

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.logoWrap, { opacity }]}>
        <Image
          source={SPLASH_LOGO}
          style={styles.logo}
          resizeMode="contain"
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F1F5F9",
  },

  logoWrap: {
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    paddingHorizontal: 32,
  },

  logo: {
    width: Math.min(width * 0.78, 340),
    height: 150,
  },
});
