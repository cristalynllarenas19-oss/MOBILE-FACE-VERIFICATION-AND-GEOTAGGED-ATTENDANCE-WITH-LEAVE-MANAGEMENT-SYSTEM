import { useState, useEffect, useRef } from "react";
import {
  View,
  StyleSheet,
  Text,
  ActivityIndicator,
  Pressable,
  Linking,
  Image,
  LayoutAnimation,
  Platform,
  UIManager,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Location from "expo-location";
import { Ionicons } from "@expo/vector-icons";
import { captureRef } from "react-native-view-shot";
import { detectFace, FaceBox } from "../api";

if (Platform.OS === "android") {
  UIManager.setLayoutAnimationEnabledExperimental?.(true);
}

// Smoothly glides the tracked box between detections instead of snapping,
// since each new position only arrives every DETECT_POLL_MS.
const BOX_TRANSITION = { duration: 180, update: { type: LayoutAnimation.Types.easeInEaseOut } };

// LayoutAnimation can be unreliable under React Native's New Architecture
// (the Expo SDK 54 default here). It must never be allowed to throw inside
// the detection poll loop — that would land in the surrounding catch block
// and incorrectly reset a real "face detected" result back to false.
function configureBoxTransition() {
  try {
    LayoutAnimation.configureNext(BOX_TRANSITION);
  } catch (error) {
    // Best-effort animation only — safe to skip.
  }
}

type CameraScannerProps = {
  logType: "TIME_IN" | "TIME_OUT";
  onComplete: (location: Location.LocationObject, faceBase64?: string) => void;
  onCancel: () => void;
};

type MapTileCell = { key: string; url: string; left: number; top: number };
type MapGrid = { cells: MapTileCell[] };

type PendingCapture = {
  uri: string;
  width: number;
  height: number;
  label: string;
  dateLabel: string;
  addressLabel: string;
  mapGrid: MapGrid;
};

type ScreenBox = { x: number; y: number; width: number; height: number };

const GUIDE_BOX_COLOR = "#1D4ED8"; // matches the admin web face-registration guide box
const LOCKED_COLOR = "#22C55E";

const DETECT_POLL_MS = 400;
const HOLD_TO_LOCK_MS = 1500;
const TICK_MS = 100;
const WATERMARK_WIDTH = 720;
const TILE_SIZE = 256;
const MAP_ZOOM = 16;
const MAP_THUMBNAIL_DISPLAY_SIZE = 90;

const CAPTURE_STAGES = [
  { title: "Look at the camera", helper: "Keep the face centered inside the guide." },
  { title: "Hold steady...", helper: "Stay still while we verify it's you." },
  { title: "Face locked!", helper: "Tagging your photo with time and location." },
] as const;

function getStageText(faceDetected: boolean, progress: number) {
  if (!faceDetected) return "No face detected — position your face inside the frame";
  if (progress < 100) return "Face detected, hold steady...";
  return "Face locked!";
}

// Maps the backend's relative (0-1) face box onto the on-screen camera
// preview, replicating the same "object-fit: cover" + padding math the
// admin web face-registration page uses to draw its face tracker rectangle.
function computeFaceScreenBox(
  box: FaceBox | null,
  stageSize: { width: number; height: number },
  photoSize: { width: number; height: number },
): ScreenBox | null {
  if (!box || !stageSize.width || !stageSize.height || !photoSize.width || !photoSize.height) return null;

  const scale = Math.max(stageSize.width / photoSize.width, stageSize.height / photoSize.height);
  const renderedWidth = photoSize.width * scale;
  const renderedHeight = photoSize.height * scale;
  const cropX = (renderedWidth - stageSize.width) / 2;
  const cropY = (renderedHeight - stageSize.height) / 2;

  const boxX = box.x * photoSize.width;
  const boxY = box.y * photoSize.height;
  const boxWidth = box.width * photoSize.width;
  const boxHeight = box.height * photoSize.height;

  const padX = boxWidth * 0.03;
  const padY = boxHeight * 0.03;

  const rawX = Math.max(0, boxX * scale - cropX - padX);
  const y = Math.max(0, boxY * scale - cropY - padY);
  const width = Math.min(stageSize.width - rawX, boxWidth * scale + padX * 2);
  const height = Math.min(stageSize.height - y, boxHeight * scale + padY * 2);

  // The front camera preview is mirrored (selfie view) while detection runs
  // on the unmirrored captured frame, so flip the box horizontally to land
  // on the same side as the face actually appears on screen.
  const x = Math.max(0, stageSize.width - rawX - width);

  return { x, y, width, height };
}

function formatStampDate(date: Date) {
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatStampCoords(latitude: number, longitude: number) {
  const lat = `${Math.abs(latitude).toFixed(6)}°${latitude >= 0 ? "N" : "S"}`;
  const lng = `${Math.abs(longitude).toFixed(6)}°${longitude >= 0 ? "E" : "W"}`;
  return `${lat}, ${lng}`;
}

function formatAddress(addr: Location.LocationGeocodedAddress | null | undefined) {
  if (!addr) return null;
  if (addr.formattedAddress) return addr.formattedAddress;

  const streetLine = [addr.streetNumber, addr.street].filter(Boolean).join(" ");
  const parts = [streetLine || addr.name, addr.city, addr.subregion, addr.region, addr.country].filter(
    (part): part is string => Boolean(part && part.trim()),
  );
  const unique = parts.filter((part, index) => parts.indexOf(part) === index);
  return unique.length ? unique.join(", ") : null;
}

// Free, no-API-key map source: raw raster tiles from Carto's free Voyager
// basemap — cream/tan built-up areas, rounded green park shapes, and blue
// water, redistributed by Carto specifically for embedding in apps
// (tile.openstreetmap.org itself returns 403 "Access blocked" for app
// traffic, since its own tile usage policy reserves it for OpenStreetMap's
// website). No custom headers are required for Carto.
//
// Rather than squashing one whole 256px tile into the small thumbnail (which
// only puts the pin near the middle by coincidence), this renders a 2x2 grid
// of raw tiles clipped to a small window centered exactly on the captured
// coordinate, so the pin can simply be drawn fixed in the middle.
function buildMapGrid(latitude: number, longitude: number): MapGrid {
  const worldSize = TILE_SIZE * Math.pow(2, MAP_ZOOM);
  const globalX = ((longitude + 180) / 360) * worldSize;
  const latRad = (latitude * Math.PI) / 180;
  const globalY = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * worldSize;

  const half = MAP_THUMBNAIL_DISPLAY_SIZE / 2;
  const windowLeft = globalX - half;
  const windowTop = globalY - half;

  const tileX0 = Math.floor(windowLeft / TILE_SIZE);
  const tileY0 = Math.floor(windowTop / TILE_SIZE);

  const cells: MapTileCell[] = [];
  for (let dx = 0; dx <= 1; dx++) {
    for (let dy = 0; dy <= 1; dy++) {
      const tx = tileX0 + dx;
      const ty = tileY0 + dy;
      cells.push({
        key: `${tx}_${ty}`,
        url: `https://a.basemaps.cartocdn.com/rastertiles/voyager/${MAP_ZOOM}/${tx}/${ty}.png`,
        left: tx * TILE_SIZE - windowLeft,
        top: ty * TILE_SIZE - windowTop,
      });
    }
  }

  return { cells };
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}


export default function CameraScanner({ logType, onComplete, onCancel }: CameraScannerProps) {
  const cameraRef = useRef<CameraView | null>(null);
  const shotRef = useRef<View>(null);
  const mainImageReadyRef = useRef<(() => void) | null>(null);
  const mapImageReadyRef = useRef<(() => void) | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [locationPermission, requestLocationPermission] = Location.useForegroundPermissions();
  const [isScanning, setIsScanning] = useState(false);
  const [faceDetected, setFaceDetected] = useState(false);
  const [faceBox, setFaceBox] = useState<FaceBox | null>(null);
  const [photoSize, setPhotoSize] = useState({ width: 0, height: 0 });
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [confidence, setConfidence] = useState(0);
  const [scanProgress, setScanProgress] = useState(0);
  const [scanError, setScanError] = useState<string | null>(null);
  const [pendingCapture, setPendingCapture] = useState<PendingCapture | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [liveCoords, setLiveCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [liveAddress, setLiveAddress] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  const isFinishingRef = useRef(false);
  const faceDetectedRef = useRef(false);

  const permissionsReady = permission?.granted && locationPermission?.granted;
  const isLocked = scanProgress >= 100;
  const activeStage = CAPTURE_STAGES[isLocked ? 2 : faceDetected ? 1 : 0];
  const secondsLeft = faceDetected && !isLocked
    ? Math.max(1, Math.ceil(((100 - scanProgress) / 100) * (HOLD_TO_LOCK_MS / 1000)))
    : null;
  const screenBox = computeFaceScreenBox(faceBox, stageSize, photoSize);
  const liveMapGrid = liveCoords ? buildMapGrid(liveCoords.latitude, liveCoords.longitude) : null;

  // Live clock for the on-screen GPS-camera-style stamp preview.
  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(tick);
  }, []);

  // Best-effort approximate location for the live stamp preview, refreshed
  // periodically. The final submitted photo always re-fetches a fresh
  // high-accuracy fix at the moment of capture (see finishScan).
  useEffect(() => {
    if (!locationPermission?.granted) return;
    let cancelled = false;

    async function refreshLivePreview() {
      try {
        const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (cancelled) return;
        setLiveCoords({ latitude: location.coords.latitude, longitude: location.coords.longitude });
        const addressResults = await Location.reverseGeocodeAsync({
          latitude: location.coords.latitude,
          longitude: location.coords.longitude,
        }).catch(() => []);
        if (cancelled) return;
        setLiveAddress(
          formatAddress(addressResults?.[0]) ?? formatStampCoords(location.coords.latitude, location.coords.longitude),
        );
      } catch (error) {
        // Best-effort preview only — leave the previous value on screen.
      }
    }

    refreshLivePreview();
    const interval = setInterval(refreshLivePreview, 20000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [locationPermission?.granted]);

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

  // Poll the backend's real face detector on a low-res snapshot. This is the
  // actual "is a face here?" signal — the camera never fakes detection — and
  // it now also returns the face's bounding box so the guide can track it.
  //
  // This deliberately schedules the NEXT attempt only after the current one
  // fully resolves (rather than a fixed setInterval cadence), and fires the
  // first attempt immediately on mount. A fixed interval wastes time waiting
  // for the next aligned tick even after a request already finished, which
  // was the main cause of the box feeling slow to appear.
  useEffect(() => {
    if (!permissionsReady || !cameraReady || isScanning || scanError) return;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout>;

    async function pollOnce() {
      if (cancelled || isFinishingRef.current) return;
      let failed = false;
      try {
        // skipProcessing is intentionally NOT set here: it skips orientation
        // correction, which would return raw sensor pixels (often landscape,
        // even held in portrait) while the preview is shown in portrait —
        // that mismatch alone was enough to make the tracked box's geometry
        // come out wrong.
        const photo = await cameraRef.current?.takePictureAsync({
          base64: true,
          quality: 0.3,
          shutterSound: false,
        });
        if (cancelled) return;
        if (photo?.width && photo.height) {
          setPhotoSize({ width: photo.width, height: photo.height });
        }
        if (photo?.base64) {
          const result = await detectFace(`data:image/jpeg;base64,${photo.base64}`);
          if (cancelled) return;
          faceDetectedRef.current = result.detected;
          setFaceDetected(result.detected);
          setConfidence(result.detected ? result.confidence : 0);
          configureBoxTransition();
          setFaceBox(result.detected ? result.box : null);
        }
      } catch (error) {
        if (cancelled) return;
        failed = true;
        console.error("Face detection poll failed", error);
        faceDetectedRef.current = false;
        setFaceDetected(false);
        setConfidence(0);
        configureBoxTransition();
        setFaceBox(null);
      } finally {
        if (!cancelled) {
          // Back off after a failure (e.g. a stale camera view reference
          // from a hot reload) instead of hammering retries at full speed.
          timeoutId = setTimeout(pollOnce, failed ? DETECT_POLL_MS * 3 : DETECT_POLL_MS);
        }
      }
    }

    pollOnce();
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [permissionsReady, cameraReady, isScanning, scanError]);

  // Drives the visual "hold steady" progress: only advances while a face is
  // actually detected, and resets the moment it's lost.
  useEffect(() => {
    if (!permissionsReady || isScanning || scanError) return;

    const tick = setInterval(() => {
      setScanProgress((progress) => {
        if (!faceDetectedRef.current) return 0;
        const next = Math.min(100, progress + (TICK_MS / HOLD_TO_LOCK_MS) * 100);
        if (next >= 100 && !isFinishingRef.current) {
          isFinishingRef.current = true;
          finishScan();
        }
        return next;
      });
    }, TICK_MS);

    return () => clearInterval(tick);
  }, [permissionsReady, isScanning, scanError]);

  // Renders the captured photo plus a GPS-camera-style stamp (map thumbnail,
  // date/time badge, address) into an off-screen view, then flattens that
  // view into a single jpeg so the stamp is burned into the image pixels.
  async function applyWatermark(
    uri: string,
    location: Location.LocationObject,
    label: string,
    addressLabel: string,
  ): Promise<string | null> {
    try {
      const { width, height } = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        Image.getSize(uri, (w, h) => resolve({ width: w, height: h }), reject);
      });

      const targetWidth = WATERMARK_WIDTH;
      const targetHeight = Math.round((height / width) * targetWidth);

      const mapGrid = buildMapGrid(location.coords.latitude, location.coords.longitude);

      const mainImageReady = createDeferred();
      const mapImageReady = createDeferred();
      mainImageReadyRef.current = mainImageReady.resolve;

      // The map is now a 2x2 grid of tile images instead of one, so wait for
      // all of them to settle (loaded or errored) before treating it ready.
      let mapTilesPending = mapGrid.cells.length;
      mapImageReadyRef.current = () => {
        mapTilesPending -= 1;
        if (mapTilesPending <= 0) mapImageReady.resolve();
      };

      setPendingCapture({
        uri,
        width: targetWidth,
        height: targetHeight,
        label,
        dateLabel: formatStampDate(new Date()),
        addressLabel,
        mapGrid,
      });

      await Promise.race([
        Promise.all([mainImageReady.promise, mapImageReady.promise]),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      if (!shotRef.current) return null;
      return await captureRef(shotRef, { format: "jpg", quality: 0.9, result: "data-uri" });
    } catch (error) {
      console.error("Failed to apply photo watermark", error);
      return null;
    } finally {
      setPendingCapture(null);
      mainImageReadyRef.current = null;
      mapImageReadyRef.current = null;
    }
  }

  async function finishScan() {
    setIsScanning(true);
    setScanError(null);
    try {
      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      const [photo, addressResults] = await Promise.all([
        cameraRef.current?.takePictureAsync({
          base64: true,
          quality: 0.7,
          shutterSound: false,
        }),
        Location.reverseGeocodeAsync({
          latitude: location.coords.latitude,
          longitude: location.coords.longitude,
        }).catch(() => []),
      ]);
      if (!photo?.uri) throw new Error("Failed to capture photo.");

      const addressLabel =
        formatAddress(addressResults?.[0]) ?? formatStampCoords(location.coords.latitude, location.coords.longitude);
      const label = logType === "TIME_IN" ? "TIME IN" : "TIME OUT";

      const watermarked = await applyWatermark(photo.uri, location, label, addressLabel);
      const finalImage = watermarked ?? (photo.base64 ? `data:image/jpeg;base64,${photo.base64}` : undefined);
      onComplete(location, finalImage);
    } catch (error) {
      console.error("Scan error", error);
      setScanError(error instanceof Error ? error.message : "Failed to capture location or photo.");
      setIsScanning(false);
      isFinishingRef.current = false;
    }
  }

  function retryScan() {
    isFinishingRef.current = false;
    faceDetectedRef.current = false;
    setFaceDetected(false);
    setFaceBox(null);
    setConfidence(0);
    setScanProgress(0);
    setScanError(null);
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
        <Pressable style={styles.retryButton} onPress={retryScan}>
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
      {/* Top Bar */}
      <View style={styles.topBar}>
        <Pressable onPress={onCancel} style={styles.closeButton}>
          <Ionicons name="close" size={26} color="#0F172A" />
        </Pressable>
        <Text style={styles.title}>{logType === "TIME_IN" ? "Time In" : "Time Out"} Verification</Text>
        <View style={{ width: 26 }} />
      </View>

      {/* Capture Stage */}
      <View style={styles.stageWrapper}>
        <View
          style={styles.captureStage}
          onLayout={(event) => setStageSize({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}
        >
          <CameraView
            ref={cameraRef}
            style={styles.camera}
            facing="front"
            animateShutter={false}
            onCameraReady={() => setCameraReady(true)}
          >
            <View style={styles.stageOverlay}>
              <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
                {screenBox && (
                  <>
                    <View
                      style={[
                        styles.trackedBox,
                        {
                          left: screenBox.x,
                          top: screenBox.y,
                          width: screenBox.width,
                          height: screenBox.height,
                        },
                      ]}
                    >
                      {isLocked && (
                        <View style={styles.lockBadge}>
                          <Ionicons name="checkmark-circle" size={28} color={LOCKED_COLOR} />
                        </View>
                      )}
                    </View>
                    <Text style={styles.confidenceLabel}>{Math.round(confidence * 100)}%</Text>
                  </>
                )}
              </View>

              <View style={styles.captureHeader}>
                <Text style={styles.captureHeaderTitle}>{activeStage.title}</Text>
                <Text style={styles.captureHeaderCountdown}>{secondsLeft ?? ""}</Text>
                <Text style={styles.captureHeaderHelper}>{activeStage.helper}</Text>
              </View>

              {/* Live preview of the geotag stamp that will be burned into the captured photo */}
              {liveCoords && liveMapGrid && (
                <View style={styles.gpsWatermarkRow} pointerEvents="none">
                  <View style={styles.mapThumbnailWrap}>
                    {liveMapGrid.cells.map((cell) => (
                      <Image
                        key={cell.key}
                        source={{ uri: cell.url }}
                        style={[styles.mapTileImage, { left: cell.left, top: cell.top }]}
                      />
                    ))}
                    <Ionicons name="location" size={24} color="#DC2626" style={styles.mapPinIcon} />
                  </View>
                  <View style={styles.gpsTextColumn}>
                    <View style={styles.dateBadge}>
                      <Text style={styles.dateBadgeText}>
                        {logType === "TIME_IN" ? "TIME IN" : "TIME OUT"} · {formatStampDate(now)}
                      </Text>
                    </View>
                    <Text style={styles.addressText} numberOfLines={2}>{liveAddress ?? "Locating..."}</Text>
                  </View>
                </View>
              )}
            </View>
          </CameraView>
        </View>
      </View>

      {/* Footer: status message only */}
      <View style={styles.footer}>
        <View style={styles.statusBar}>
          {isScanning ? (
            <>
              <ActivityIndicator size="small" color="#1D4ED8" />
              <Text style={styles.statusText}>Verifying Location & Identity...</Text>
            </>
          ) : (
            <>
              <Ionicons
                name={isLocked ? "checkmark-circle" : faceDetected ? "scan-outline" : "alert-circle-outline"}
                size={18}
                color="#1D4ED8"
              />
              <Text style={styles.statusText}>{getStageText(faceDetected, scanProgress)}</Text>
            </>
          )}
        </View>
      </View>

      {/* Off-screen host used only to bake the GPS-camera-style stamp into the final photo */}
      {pendingCapture && (
        <View style={styles.hiddenCaptureHost} pointerEvents="none">
          <View ref={shotRef} collapsable={false} style={{ width: pendingCapture.width, height: pendingCapture.height }}>
            <Image
              source={{ uri: pendingCapture.uri }}
              style={{ width: pendingCapture.width, height: pendingCapture.height }}
              resizeMode="cover"
              onLoadEnd={() => mainImageReadyRef.current?.()}
              onError={() => mainImageReadyRef.current?.()}
            />
            <View style={styles.gpsWatermarkRow}>
              <View style={styles.mapThumbnailWrap}>
                {pendingCapture.mapGrid.cells.map((cell) => (
                  <Image
                    key={cell.key}
                    source={{ uri: cell.url }}
                    style={[styles.mapTileImage, { left: cell.left, top: cell.top }]}
                    onLoadEnd={() => mapImageReadyRef.current?.()}
                    onError={() => mapImageReadyRef.current?.()}
                  />
                ))}
                <Ionicons name="location" size={26} color="#DC2626" style={styles.mapPinIcon} />
              </View>
              <View style={styles.gpsTextColumn}>
                <View style={styles.dateBadge}>
                  <Text style={styles.dateBadgeText}>{pendingCapture.label} · {pendingCapture.dateLabel}</Text>
                </View>
                <Text style={styles.addressText} numberOfLines={3}>{pendingCapture.addressLabel}</Text>
              </View>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F1F5F9",
  },
  centerContainer: {
    flex: 1,
    backgroundColor: "#F1F5F9",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 24,
  },
  errorText: {
    color: "#0F172A",
    fontSize: 16,
    textAlign: "center",
    marginBottom: 24,
  },
  retryButton: {
    backgroundColor: "#1D4ED8",
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
    color: "#64748B",
    fontSize: 14,
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 56,
    paddingHorizontal: 20,
    paddingBottom: 14,
    backgroundColor: "#FFFFFF",
    borderBottomWidth: 1,
    borderBottomColor: "#E2E8F0",
  },
  closeButton: {
    padding: 4,
  },
  title: {
    color: "#193D69",
    fontSize: 17,
    fontWeight: "700",
  },
  stageWrapper: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 8,
  },
  captureStage: {
    flex: 1,
    borderRadius: 24,
    overflow: "hidden",
    backgroundColor: "#050816",
    borderWidth: 1,
    borderColor: "rgba(148,163,184,0.18)",
    shadowColor: "#020617",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.25,
    shadowRadius: 20,
    elevation: 8,
  },
  camera: {
    flex: 1,
  },
  stageOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.25)",
  },
  captureHeader: {
    alignItems: "center",
    paddingTop: 18,
    paddingHorizontal: 20,
    gap: 2,
  },
  captureHeaderTitle: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
  },
  captureHeaderCountdown: {
    color: "#fff",
    fontSize: 38,
    fontWeight: "800",
    lineHeight: 42,
    minHeight: 42,
  },
  captureHeaderHelper: {
    color: "rgba(255,255,255,0.86)",
    fontSize: 12,
    fontWeight: "500",
    textAlign: "center",
  },
  trackedBox: {
    position: "absolute",
    borderWidth: 4,
    borderRadius: 18,
    borderColor: GUIDE_BOX_COLOR,
  },
  confidenceLabel: {
    position: "absolute",
    top: 12,
    left: 14,
    color: "#EFF6FF",
    fontSize: 13,
    fontWeight: "800",
    textShadowColor: "rgba(30,64,175,0.9)",
    textShadowRadius: 4,
    textShadowOffset: { width: 0, height: 0 },
  },
  lockBadge: {
    position: "absolute",
    top: "50%",
    left: "50%",
    marginTop: -14,
    marginLeft: -14,
  },
  footer: {
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 28,
    backgroundColor: "#FFFFFF",
    borderTopWidth: 1,
    borderTopColor: "#E2E8F0",
    gap: 12,
  },
  statusBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#EFF6FF",
    borderLeftWidth: 3,
    borderLeftColor: "#3B82F6",
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  statusText: {
    flex: 1,
    color: "#1E3A8A",
    fontSize: 13,
    lineHeight: 18,
  },
  hiddenCaptureHost: {
    position: "absolute",
    top: 0,
    left: -9999,
  },
  gpsWatermarkRow: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 16,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 12,
  },
  mapThumbnailWrap: {
    width: MAP_THUMBNAIL_DISPLAY_SIZE,
    height: MAP_THUMBNAIL_DISPLAY_SIZE,
    borderRadius: 16,
    overflow: "hidden",
    borderWidth: 2,
    borderColor: "#FFFFFF",
    // Light neutral instead of dark navy, so a tile that fails to load
    // doesn't look like a black hole on screen.
    backgroundColor: "#CBD5E1",
    position: "relative",
  },
  mapTileImage: {
    position: "absolute",
    width: TILE_SIZE,
    height: TILE_SIZE,
  },
  mapPinIcon: {
    position: "absolute",
    left: MAP_THUMBNAIL_DISPLAY_SIZE / 2 - 12,
    top: MAP_THUMBNAIL_DISPLAY_SIZE / 2 - 22,
    textShadowColor: "#FFFFFF",
    textShadowRadius: 3,
    textShadowOffset: { width: 0, height: 0 },
  },
  gpsTextColumn: {
    flex: 1,
    justifyContent: "flex-end",
    gap: 6,
  },
  dateBadge: {
    alignSelf: "flex-start",
    backgroundColor: "#DC2626",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
  },
  dateBadgeText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "800",
  },
  addressText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 17,
    textShadowColor: "rgba(0,0,0,0.85)",
    textShadowRadius: 4,
    textShadowOffset: { width: 0, height: 1 },
  },
});
