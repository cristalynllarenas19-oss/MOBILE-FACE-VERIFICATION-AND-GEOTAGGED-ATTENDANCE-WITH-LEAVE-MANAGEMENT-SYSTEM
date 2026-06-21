import { useState, useEffect, useRef } from "react";
import { View, StyleSheet, Text, ActivityIndicator } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Location from "expo-location";
import { Ionicons } from "@expo/vector-icons";

type CameraScannerProps = {
  logType: "TIME_IN" | "TIME_OUT";
  onComplete: (location: Location.LocationObject, faceBase64?: string) => void;
  onCancel: () => void;
};

export default function CameraScanner({ logType, onComplete, onCancel }: CameraScannerProps) {
  const cameraRef = useRef<CameraView | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);

  useEffect(() => {
    if (!permission?.granted) {
      requestPermission();
    }
  }, [permission]);

  // Simulate a 2.5 second "Face Analysis" scan when the component mounts
  useEffect(() => {
    if (permission?.granted) {
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
  }, [permission]);

  async function finishScan() {
    setIsScanning(true);
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
      console.error("Location error", error);
      onCancel();
    } finally {
      setIsScanning(false);
    }
  }

  if (!permission) return <View style={styles.container} />;
  
  if (!permission.granted) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.errorText}>Camera permission is required for face verification.</Text>
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
            <View style={styles.reticleBox}>
              <View style={[styles.corner, styles.topLeft]} />
              <View style={[styles.corner, styles.topRight]} />
              <View style={[styles.corner, styles.bottomLeft]} />
              <View style={[styles.corner, styles.bottomRight]} />
            </View>
            
            {/* Animated Scan Line */}
            <View style={[styles.scanLine, { top: `${scanProgress}%` }]} />
          </View>

          {/* Bottom Info */}
          <View style={styles.bottomBar}>
            {isScanning ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color="#3b82f6" />
                <Text style={styles.statusText}>Verifying Location & Identity...</Text>
              </View>
            ) : (
              <View style={styles.instructionContainer}>
                <Ionicons name="scan-outline" size={24} color="#60a5fa" />
                <Text style={styles.instructionText}>
                  Please position your face inside the frame.
                </Text>
                <Text style={styles.progressText}>{scanProgress}% Analyzed</Text>
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
  reticleBox: {
    width: 280,
    height: 320,
    position: "relative",
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
  progressText: {
    color: "#60a5fa",
    fontSize: 18,
    fontWeight: "700",
    marginTop: 10,
    fontVariant: ["tabular-nums"],
  },
});
