import { useState, useEffect, useRef } from "react";
import { View, StyleSheet, Text, ActivityIndicator, Pressable, Linking, Animated, Easing } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Location from "expo-location";
import { Ionicons } from "@expo/vector-icons";

type CameraScannerProps = {
  logType: "TIME_IN" | "TIME_OUT";
  onComplete: (location: Location.LocationObject, faceBase64?: string) => void;
  onCancel: () => void;
};

const SCAN_COLOR_START = { r: 0x3b, g: 0x82, b: 0xf6 }; // blue
const SCAN_COLOR_LOCKED = { r: 0x22, g: 0xc5, b: 0x5e }; // green

function getLockColor(progress: number) {
  const t = Math.min(1, Math.max(0, progress / 100));
  const r = Math.round(SCAN_COLOR_START.r + (SCAN_COLOR_LOCKED.r - SCAN_COLOR_START.r) * t);
  const g = Math.round(SCAN_COLOR_START.g + (SCAN_COLOR_LOCKED.g - SCAN_COLOR_START.g) * t);
  const b = Math.round(SCAN_COLOR_START.b + (SCAN_COLOR_LOCKED.b - SCAN_COLOR_START.b) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

function getStageText(progress: number) {
  if (progress < 25) return "Position your face inside the frame";
  if (progress < 70) return "Hold steady, analyzing...";
  if (progress < 100) return "Almost there...";
  return "Face locked!";
}

export default function CameraScanner({ logType, onComplete, onCancel }: CameraScannerProps) {
  const cameraRef = useRef<CameraView | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [locationPermission, requestLocationPermission] = Location.useForegroundPermissions();
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [scanError, setScanError] = useState<string | null>(null);
  const pulseAnim = useRef(new Animated.Value(0)).current;

  const permissionsReady = permission?.granted && locationPermission?.granted;
  const lockColor = getLockColor(scanProgress);
  const isLocked = scanProgress >= 100;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1, duration: 1100, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 0, duration: 1100, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, []);

  const glowScale = pulseAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] });
  const glowOpacity = pulseAnim.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.75] });
  const boxScale = pulseAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.015] });

  useEffect(() => {
    if (!permission?.granted) {
      requestPermission();
    }
  }, [permission]);

  useEffect(() => {
    if (!locationPermission?.granted) {
      requestLocationPermission();
    }
  }, [locationPermission]);

  // Simulate a 2.5 second "Face Analysis" scan once both permissions are granted
  useEffect(() => {
    if (permissionsReady) {
      let progress = 0;
      const interval = setInterval(() => {
        progress += 4;
        setScanProgress(progress);

        if (progress >= 100) {
          clearInterval(interval);
          finishScan();
        }
      }, 100);
      return () => clearInterval(interval);
    }
  }, [permissionsReady]);

  async function finishScan() {
    setIsScanning(true);
    setScanError(null);
    try {
      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      const photo = await cameraRef.current?.takePictureAsync({
        base64: true,
        quality: 0.7,
        skipProcessing: true,
      });
      onComplete(location, photo?.base64 ? `data:image/jpeg;base64,${photo.base64}` : undefined);
    } catch (error) {
      console.error("Scan error", error);
      setScanError(error instanceof Error ? error.message : "Failed to capture location or photo.");
      setIsScanning(false);
    }
  }

  if (!permission || !locationPermission) return <View style={styles.container} />;

  if (!permission.granted || !locationPermission.granted) {
    const missing = [
      !permission.granted ? "camera" : null,
      !locationPermission.granted ? "location" : null,
    ].filter(Boolean).join(" and ");

    const canAskAgain = permission.canAskAgain && locationPermission.canAskAgain;

    return (
      <View style={styles.centerContainer}>
        <Text style={styles.errorText}>
          {`Please allow ${missing} access to use face verification attendance.`}
        </Text>
        <Pressable
          style={styles.retryButton}
          onPress={() => {
            if (canAskAgain) {
              if (!permission.granted) requestPermission();
              if (!locationPermission.granted) requestLocationPermission();
            } else {
              Linking.openSettings();
            }
          }}
        >
          <Text style={styles.retryButtonText}>
            {canAskAgain ? "Grant Permission" : "Open Settings"}
          </Text>
        </Pressable>
        <Pressable style={styles.cancelLink} onPress={onCancel}>
          <Text style={styles.cancelLinkText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  if (scanError) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.errorText}>{scanError}</Text>
        <Pressable
          style={styles.retryButton}
          onPress={() => {
            setScanProgress(0);
            setScanError(null);
            finishScan();
          }}
        >
          <Text style={styles.retryButtonText}>Try Again</Text>
        </Pressable>
        <Pressable style={styles.cancelLink} onPress={onCancel}>
          <Text style={styles.cancelLinkText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView ref={cameraRef} style={styles.camera} facing="front">
        <View style={styles.overlay}>
          {/* Top Bar */}
          <View style={styles.topBar}>
            <Ionicons name="close" size={32} color="#fff" onPress={onCancel} />
            <Text style={styles.title}>Face Verification</Text>
            <View style={{ width: 32 }} />
          </View>

          {/* Scanning Reticle */}
          <View style={styles.reticleContainer}>
            <Animated.View
              style={[
                styles.glowRing,
                {
                  borderColor: lockColor,
                  opacity: glowOpacity,
                  transform: [{ scale: glowScale }],
                },
              ]}
            />

            <Animated.View style={[styles.reticleBox, { transform: [{ scale: boxScale }] }]}>
              <View style={[styles.corner, styles.topLeft, { borderColor: lockColor }]} />
              <View style={[styles.corner, styles.topRight, { borderColor: lockColor }]} />
              <View style={[styles.corner, styles.bottomLeft, { borderColor: lockColor }]} />
              <View style={[styles.corner, styles.bottomRight, { borderColor: lockColor }]} />
              {isLocked && (
                <View style={styles.lockBadge}>
                  <Ionicons name="checkmark-circle" size={28} color={lockColor} />
                </View>
              )}
            </Animated.View>

            {/* Animated Scan Line */}
            {!isLocked && (
              <View
                style={[
                  styles.scanLine,
                  { top: `${scanProgress}%`, backgroundColor: lockColor, shadowColor: lockColor },
                ]}
              />
            )}
          </View>

          {/* Bottom Info */}
          <View style={styles.bottomBar}>
            {isScanning ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color={lockColor} />
                <Text style={styles.statusText}>Verifying Location & Identity...</Text>
              </View>
            ) : (
              <View style={styles.instructionContainer}>
                <Ionicons
                  name={isLocked ? "checkmark-circle" : "scan-outline"}
                  size={24}
                  color={lockColor}
                />
                <Text style={styles.instructionText}>{getStageText(scanProgress)}</Text>
              </View>
            )}
          </View>
        </View>
      </CameraView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  centerContainer: {
    flex: 1,
    backgroundColor: "#000",
    justifyContent: "center",
    alignItems: "center",
  },
  errorText: {
    color: "#fff",
    fontSize: 16,
    textAlign: "center",
    paddingHorizontal: 32,
    marginBottom: 24,
  },
  retryButton: {
    backgroundColor: "#3b82f6",
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: 12,
  },
  retryButtonText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
  },
  cancelLink: {
    marginTop: 18,
  },
  cancelLinkText: {
    color: "#94a3b8",
    fontSize: 14,
  },
  camera: {
    flex: 1,
  },
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "space-between",
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 60,
    paddingHorizontal: 20,
  },
  title: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  reticleContainer: {
    alignItems: "center",
    justifyContent: "center",
    height: 350,
    position: "relative",
  },
  glowRing: {
    position: "absolute",
    width: 304,
    height: 344,
    borderRadius: 32,
    borderWidth: 2,
  },
  reticleBox: {
    width: 280,
    height: 320,
    position: "relative",
  },
  lockBadge: {
    position: "absolute",
    top: "50%",
    left: "50%",
    marginTop: -14,
    marginLeft: -14,
  },
  corner: {
    position: "absolute",
    width: 40,
    height: 40,
    borderColor: "#3b82f6",
  },
  topLeft: {
    top: 0,
    left: 0,
    borderTopWidth: 4,
    borderLeftWidth: 4,
    borderTopLeftRadius: 20,
  },
  topRight: {
    top: 0,
    right: 0,
    borderTopWidth: 4,
    borderRightWidth: 4,
    borderTopRightRadius: 20,
  },
  bottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 4,
    borderLeftWidth: 4,
    borderBottomLeftRadius: 20,
  },
  bottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 4,
    borderRightWidth: 4,
    borderBottomRightRadius: 20,
  },
  scanLine: {
    position: "absolute",
    width: 260,
    height: 2,
    backgroundColor: "#60a5fa",
    shadowColor: "#3b82f6",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 1,
    shadowRadius: 10,
    elevation: 5,
  },
  bottomBar: {
    backgroundColor: "#1e293b",
    paddingBottom: 40,
    paddingTop: 30,
    paddingHorizontal: 24,
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    alignItems: "center",
    minHeight: 160,
  },
  loadingContainer: {
    alignItems: "center",
    gap: 16,
  },
  statusText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  instructionContainer: {
    alignItems: "center",
    gap: 8,
  },
  instructionText: {
    color: "#fff",
    fontSize: 15,
    textAlign: "center",
  },
});
