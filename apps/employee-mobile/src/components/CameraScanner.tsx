import { useState, useEffect, useRef } from "react";
import {
  View,
  StyleSheet,
  Text,
  ActivityIndicator,
  Pressable,
  Linking,
  Image,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Location from "expo-location";
import { Ionicons } from "@expo/vector-icons";
import { captureRef } from "react-native-view-shot";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import { detectFace, FaceBox } from "../api";

type CameraScannerProps = {
  logType: "TIME_IN" | "TIME_OUT" | "LUNCH_OUT" | "LUNCH_IN";
  onComplete: (location: Location.LocationObject, faceBase64?: string) => void;
  onCancel: () => void;
};

const LOG_TYPE_LABEL: Record<CameraScannerProps["logType"], string> = {
  TIME_IN: "Time In",
  TIME_OUT: "Time Out",
  LUNCH_OUT: "Lunch Out",
  LUNCH_IN: "Lunch In",
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

// Matches admin web face-registration's own tracking loop interval
// (FaceRegistrationPage.tsx's startFaceTracking polls every 250ms) as
// closely as this architecture allows.
const DETECT_POLL_MS = 250;
// While sampling for a blink, captures are decoupled from the network (see
// the capture/send loops below) and re-fire almost immediately — this is
// just a floor to avoid hammering the native camera bridge back-to-back.
const BLINK_CAPTURE_FLOOR_MS = 30;
const HOLD_TO_LOCK_MS = 800;
const TICK_MS = 100;
// Blink-based liveness check: this has to pass *before* the hold-to-lock
// step even starts (and therefore before capture), not after — the user
// should never be able to fool this with a held-up photo that's never
// blinked. Deliberately as simple as this signal allows: track a running
// "how open do this person's eyes normally read" baseline, and the moment
// any single sample reads meaningfully lower than that, count it as a
// blink immediately. No open/closed/reopen state machine, no waiting for
// eyes to visibly reopen again — that older design could get stuck forever
// waiting on a "reopen" sample that a fast blink or one dropped frame meant
// never arrived. This is one comparison per sample, nothing to get stuck in.
const REQUIRED_BLINKS = 1;
// How many baseline samples to collect before dip-checking starts, so the
// very first (often still-settling) frame can't be compared against nothing.
const MIN_BASELINE_SAMPLES = 2;
// A sample this much below baseline counts as a blink. Deliberately loose —
// the goal is "did the eyes move at all," not a precise measurement. Real
// device data showed genuine blinks only dip ~5-8% (the landmark model
// doesn't track closed eyelids precisely), so this has to sit above that,
// not at a textbook EAR-drop value.
const EAR_DIP_RATIO = 0.95;
// Detection frames are shrunk to this width before being sent anywhere —
// the backend's own detector resizes internally to ~224-416px regardless,
// so anything bigger here only adds encode/transfer/decode latency without
// improving accuracy.
const DETECTION_FRAME_WIDTH = 480;
// Static on-screen face guide, always shown at a fixed spot/size so the
// user lines their face up consistently — closer and more consistently
// framed input gives the backend's landmark model a much easier time
// locating the eyes accurately for the blink check.
const FACE_GUIDE_WIDTH_RATIO = 0.62;
const FACE_GUIDE_ASPECT_RATIO = 0.75; // width / height — a bit taller than wide, like a face
// Higher base resolution for the composited photo, since it's now shown
// large (full width) in the DTR history view rather than as a tiny thumbnail.
const WATERMARK_WIDTH = 1080;
const TILE_SIZE = 256;
const MAP_ZOOM = 16;
// On-screen live verification stamp stays at its original, smaller size —
// only the saved photo (baked in below, shown big in DTR) is enlarged.
const MAP_THUMBNAIL_DISPLAY_SIZE = 90;
const SAVED_MAP_THUMBNAIL_DISPLAY_SIZE = 210;
// How long the captured photo stays frozen on screen (with the GPS stamp
// already baked in) before handing off, so the capture feels like a real
// snapshot instead of the live preview just continuing to move.
const FREEZE_DISPLAY_MS = 900;

function getStageText(faceDetected: boolean, progress: number, blinkCount: number) {
  if (!faceDetected) return "No face detected — line your face up with the outline";
  if (blinkCount < REQUIRED_BLINKS) {
    return "Please blink to verify you're not a photo";
  }
  if (progress < 100) return "Liveness verified — hold steady...";
  return "Face verified!";
}

// Maps the backend's relative (0-1) face box onto the on-screen camera
// preview. This is a direct port of admin web face-registration's own
// startFaceTracking math (FaceRegistrationPage.tsx) — same "object-fit:
// cover" scale, same 8%/12% padding, same raw-snap-every-tick update with
// no extra smoothing — so the guide behaves identically on both surfaces.
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

  const padX = boxWidth * 0.08;
  const padY = boxHeight * 0.12;

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
function buildMapGrid(latitude: number, longitude: number, displaySize: number): MapGrid {
  const worldSize = TILE_SIZE * Math.pow(2, MAP_ZOOM);
  const globalX = ((longitude + 180) / 360) * worldSize;
  const latRad = (latitude * Math.PI) / 180;
  const globalY = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * worldSize;

  const half = displaySize / 2;
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
        // "@2x" requests Carto's retina tile (512x512px for the same
        // geographic area as a normal 256x256 tile). The cell is still laid
        // out at TILE_SIZE (256) style points below, so this just gives the
        // image component more source pixels to downscale from instead of
        // upscaling a 1x tile, which was the main source of map blur.
        url: `https://a.basemaps.cartocdn.com/rastertiles/voyager/${MAP_ZOOM}/${tx}/${ty}@2x.png`,
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
  const [blinkCount, setBlinkCount] = useState(0);
  const [scanError, setScanError] = useState<string | null>(null);
  const [pendingCapture, setPendingCapture] = useState<PendingCapture | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  // One fixed picture size for the whole scan session (see
  // handleCameraReady): the smallest the camera offers that's still big
  // enough for the final watermarked photo. Capturing at ~2MP instead of
  // the sensor's full ~12MP makes every capture far faster — which is what
  // raises the odds of photographing the closed-eye moment of a blink —
  // while never switching sizes mid-session: switching (small for sampling,
  // full for capture) reconfigures the camera each time, and captures fail
  // during every reconfiguration window on slower devices. Null until (or
  // unless) the size list has been queried successfully.
  const [scanPictureSize, setScanPictureSize] = useState<string | null>(null);
  const scanPictureSizeRef = useRef<string | null>(null);
  const [liveCoords, setLiveCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [liveAddress, setLiveAddress] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [frozenPreviewUri, setFrozenPreviewUri] = useState<string | null>(null);
  const [isFrozenStamped, setIsFrozenStamped] = useState(false);
  const [frozenStamp, setFrozenStamp] = useState<{ date: Date; address: string | null; mapGrid: MapGrid } | null>(null);

  const isFinishingRef = useRef(false);
  const faceDetectedRef = useRef(false);
  // Blink liveness state. This runs as soon as a face is detected — before
  // the hold-to-lock step even starts — so a held-up photo (which can never
  // blink) can't get anywhere near capture. blinkCountRef mirrors the
  // blinkCount state so the interval-driven hold-to-lock tick (below) can
  // read the latest value without becoming stale-closure-dependent on it.
  const blinkCountRef = useRef(0);
  // Running "eyes open" reference for this attempt — a sample reading
  // meaningfully below this counts as a blink (see EAR_DIP_RATIO above).
  const openBaselineRef = useRef<number | null>(null);
  const openSampleCountRef = useRef(0);
  // Dev-only: when the previous eye sample arrived, so the [liveness] log
  // shows the real gap between samples — the number that says whether missed
  // blinks are a sampling-cadence problem or a threshold problem.
  const lastEyeSampleAtRef = useRef<number | null>(null);

  const permissionsReady = permission?.granted && locationPermission?.granted;
  // The blink check must pass before the hold-to-lock step is even allowed
  // to start counting (enforced in the tick effect below), so scanProgress
  // can only reach 100 after liveness is verified — isLocked therefore
  // already implies livenessVerified, but both are kept for readable intent
  // at each call site below.
  const livenessVerified = blinkCount >= REQUIRED_BLINKS;
  const isLocked = scanProgress >= 100;
  const secondsLeft = faceDetected && livenessVerified && !isLocked
    ? Math.max(1, Math.ceil(((100 - scanProgress) / 100) * (HOLD_TO_LOCK_MS / 1000)))
    : null;
  const screenBox = computeFaceScreenBox(faceBox, stageSize, photoSize);
  const faceGuideRect = (() => {
    if (!stageSize.width || !stageSize.height) return null;
    const width = stageSize.width * FACE_GUIDE_WIDTH_RATIO;
    const height = width / FACE_GUIDE_ASPECT_RATIO;
    return { width, height, left: (stageSize.width - width) / 2, top: (stageSize.height - height) / 2 };
  })();
  const liveMapGrid = liveCoords
    ? buildMapGrid(liveCoords.latitude, liveCoords.longitude, MAP_THUMBNAIL_DISPLAY_SIZE)
    : null;
  // Once a photo is captured, the on-screen stamp preview should hold still
  // at the exact moment of capture instead of continuing to tick/update —
  // it's standing in for a frozen snapshot, not a live readout.
  const overlayDate = frozenStamp ? frozenStamp.date : now;
  const overlayAddress = frozenStamp ? frozenStamp.address : liveAddress;
  const overlayMapGrid = frozenStamp ? frozenStamp.mapGrid : liveMapGrid;

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

  // Picks the smallest picture size the camera offers whose short side is
  // still at least WATERMARK_WIDTH — so the final stamped photo (rendered
  // at WATERMARK_WIDTH wide, in portrait the photo's short side) never has
  // to upscale, while detection frames (resized down to
  // DETECTION_FRAME_WIDTH anyway) start from a several-times-smaller
  // capture. Sizes come back as "WIDTHxHEIGHT" strings; anything else (some
  // iOS preset names) is skipped, and any failure just leaves the camera's
  // default full-resolution capture in place.
  async function handleCameraReady() {
    setCameraReady(true);
    try {
      const sizes = (await cameraRef.current?.getAvailablePictureSizesAsync()) ?? [];
      const candidates = sizes
        .map((label) => {
          const match = /^(\d+)x(\d+)$/.exec(label);
          if (!match) return null;
          const width = Number(match[1]);
          const height = Number(match[2]);
          return { label, shortSide: Math.min(width, height), area: width * height };
        })
        .filter((size): size is NonNullable<typeof size> => size !== null && size.shortSide >= WATERMARK_WIDTH)
        .sort((a, b) => a.area - b.area);
      if (candidates.length > 0) {
        scanPictureSizeRef.current = candidates[0].label;
        setScanPictureSize(candidates[0].label);
        if (__DEV__) console.log(`[liveness] scan pictureSize=${candidates[0].label}`);
      }
    } catch (error) {
      if (__DEV__) console.log("[liveness] getAvailablePictureSizesAsync failed, keeping default size", error);
    }
  }

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
    let captureTimeoutId: ReturnType<typeof setTimeout>;
    // While sampling for a blink, the camera used to sit idle for the
    // entire network round trip before taking its next photo — exactly the
    // dead time a fast blink falls into. These two loops decouple capture
    // from sending: captureLoop takes photos back-to-back as fast as the
    // device allows, and sendLoop (only one in flight at a time) always
    // grabs whatever the freshest captured frame is the instant the network
    // is free, instead of a frame that's stale by a full round trip.
    let latestBlinkFrame: { base64: string; seq: number } | null = null;
    let blinkFrameSeq = 0;
    let sendInFlight = false;
    // Consecutive takePictureAsync failures while the custom scan
    // pictureSize is active — used to detect devices that can't capture at
    // that size and revert them to the default size (see the catch below).
    let captureFailStreak = 0;

    function applyDetectionResult(result: {
      detected: boolean;
      confidence: number;
      box: FaceBox | null;
      ear: number | null;
    }) {
      faceDetectedRef.current = result.detected;
      setFaceDetected(result.detected);
      setConfidence(result.detected ? result.confidence : 0);
      // Set the raw detection directly on every tick, same as admin web's
      // tracking loop — no smoothing/interpolation layered on top.
      setFaceBox(result.detected ? result.box : null);
    }

    // Sends whatever the latest captured blink frame is, then immediately
    // checks again for an even-newer one that arrived while that request
    // was in flight — this is what keeps the network always working on the
    // freshest available frame instead of queueing up stale ones.
    async function sendLatestBlinkFrame() {
      if (sendInFlight || cancelled || !latestBlinkFrame) return;
      const frame = latestBlinkFrame;
      sendInFlight = true;
      try {
        const result = await detectFace(`data:image/jpeg;base64,${frame.base64}`, true);
        if (cancelled) return;
        applyDetectionResult(result);
        if (result.detected) registerEyeSample(result.ear);
      } catch (error) {
        if (!cancelled) console.error("Blink sample failed", error);
      } finally {
        sendInFlight = false;
        if (!cancelled && latestBlinkFrame && latestBlinkFrame.seq > frame.seq) {
          sendLatestBlinkFrame();
        }
      }
    }

    async function captureLoop() {
      if (cancelled || isFinishingRef.current) return;
      let failed = false;
      // While the blink check hasn't passed yet, this poll's only job is
      // sampling eye state as accurately and quickly as possible — sharper
      // photo, faster cadence, and (below) no longer waiting on the network
      // before taking the next photo.
      const samplingBlink = blinkCountRef.current < REQUIRED_BLINKS;
      try {
        // skipProcessing is intentionally NOT set here: it skips orientation
        // correction, which would return raw sensor pixels (often landscape,
        // even held in portrait) while the preview is shown in portrait —
        // that mismatch alone was enough to make the tracked box's geometry
        // come out wrong. base64 is intentionally NOT requested here either
        // — that encode is wasted time at capture resolution, the resize
        // below produces a far smaller base64 string instead. The capture
        // itself is already fast because the whole session runs at the
        // small fixed pictureSize (see the CameraView props).
        const photo = await cameraRef.current?.takePictureAsync({
          quality: samplingBlink ? 0.5 : 0.3,
          shutterSound: false,
        });
        if (cancelled) return;
        captureFailStreak = 0;
        if (photo?.width && photo.height) {
          setPhotoSize({ width: photo.width, height: photo.height });
        }
        if (photo?.uri) {
          // The backend's detector resizes internally to ~224-416px no
          // matter what we send, so shrinking here first cuts encode,
          // transfer, and backend decode/resize time all at once — this is
          // the fast path to actually catching a blink instead of just
          // making the model looking at it more precise.
          const resized = await manipulateAsync(photo.uri, [{ resize: { width: DETECTION_FRAME_WIDTH } }], {
            base64: true,
            compress: 0.7,
            format: SaveFormat.JPEG,
          });
          if (cancelled) return;
          const frameBase64 = resized.base64 ?? null;
          if (frameBase64) {
            if (samplingBlink) {
              // Hand off to the decoupled send loop instead of awaiting the
              // network here — that's the whole point: keep capturing while
              // a previous frame is still in flight on the backend.
              blinkFrameSeq += 1;
              latestBlinkFrame = { base64: frameBase64, seq: blinkFrameSeq };
              sendLatestBlinkFrame();
            } else {
              const result = await detectFace(`data:image/jpeg;base64,${frameBase64}`, false);
              if (cancelled) return;
              applyDetectionResult(result);
            }
          }
        }
      } catch (error) {
        if (cancelled) return;
        failed = true;
        console.error("Face detection poll failed", error);
        faceDetectedRef.current = false;
        setFaceDetected(false);
        setConfidence(0);
        setFaceBox(null);
        // Some devices reject captures at a non-default pictureSize (or
        // fail while the session is reconfiguring to it, which happens once
        // when the size is first applied after camera-ready). One or two
        // failures are tolerable churn; a streak means this device can't
        // capture at the chosen size at all, so permanently fall back to
        // the camera's default size rather than erroring forever.
        if (scanPictureSizeRef.current !== null) {
          captureFailStreak += 1;
          if (captureFailStreak >= 3) {
            if (__DEV__) console.log("[liveness] custom pictureSize keeps failing, reverting to default size");
            scanPictureSizeRef.current = null;
            setScanPictureSize(null);
          }
        }
      } finally {
        if (!cancelled) {
          // Back off after a failure (e.g. a stale camera view reference
          // from a hot reload) instead of hammering retries at full speed.
          // Otherwise: during blink sampling, re-fire almost immediately
          // (a small floor just to avoid saturating the native camera
          // bridge back-to-back) since the network is no longer the pacing
          // factor for how often a photo gets taken; plain tracking keeps
          // its original, more relaxed cadence.
          const nextDelay = failed ? DETECT_POLL_MS * 3 : samplingBlink ? BLINK_CAPTURE_FLOOR_MS : DETECT_POLL_MS;
          captureTimeoutId = setTimeout(captureLoop, nextDelay);
        }
      }
    }

    captureLoop();
    return () => {
      cancelled = true;
      clearTimeout(captureTimeoutId);
    };
  }, [permissionsReady, cameraReady, isScanning, scanError]);

  // Drives the visual "hold steady" progress. This only starts advancing
  // once the blink liveness check has passed (blinkCountRef reaching
  // REQUIRED_BLINKS) — capture/lock always comes after liveness, never
  // before or concurrently with it — and resets, along with the whole
  // liveness attempt, the moment the face is lost.
  useEffect(() => {
    if (!permissionsReady || isScanning || scanError) return;

    const tick = setInterval(() => {
      setScanProgress((progress) => {
        if (!faceDetectedRef.current) {
          if (blinkCountRef.current > 0 || progress > 0) {
            openBaselineRef.current = null;
            openSampleCountRef.current = 0;
            blinkCountRef.current = 0;
            setBlinkCount(0);
          }
          return 0;
        }
        if (blinkCountRef.current < REQUIRED_BLINKS) return 0;
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

  // One comparison, nothing to get stuck in: if this sample reads
  // meaningfully lower than the running "eyes open" baseline, it's a blink.
  // The dip sample itself is never folded into the baseline (that would
  // drag the baseline down and make the next blink harder to trigger).
  function registerEyeSample(ear: number | null) {
    // Gap since the previous sample, dev-log only. This is the number that
    // matters most when a blink is missed: gaps much above ~250ms mean the
    // closed-eye moment is falling between samples (a cadence problem),
    // while small gaps with no dip in the ear values mean the threshold or
    // landmarks are the problem.
    let gapLabel = "";
    if (__DEV__) {
      const nowMs = Date.now();
      gapLabel = lastEyeSampleAtRef.current === null ? " +first" : ` +${nowMs - lastEyeSampleAtRef.current}ms`;
      lastEyeSampleAtRef.current = nowMs;
    }
    if (ear === null) {
      if (__DEV__) console.log(`[liveness]${gapLabel} ear=null (no landmarks this frame)`);
      return;
    }

    const baseline = openBaselineRef.current;
    const ready = openSampleCountRef.current >= MIN_BASELINE_SAMPLES && baseline !== null;
    const isBlink = ready && ear < (baseline as number) * EAR_DIP_RATIO;

    if (__DEV__) {
      console.log(
        `[liveness]${gapLabel} ear=${ear.toFixed(3)} baseline=${(baseline ?? 0).toFixed(3)} cutoff=${ready ? ((baseline as number) * EAR_DIP_RATIO).toFixed(3) : "n/a"}${isBlink ? " -> BLINK" : ""}`,
      );
    }

    if (isBlink) {
      blinkCountRef.current = Math.min(REQUIRED_BLINKS, blinkCountRef.current + 1);
      setBlinkCount(blinkCountRef.current);
      return;
    }

    openBaselineRef.current = baseline === null ? ear : baseline * 0.7 + ear * 0.3;
    openSampleCountRef.current += 1;
  }

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

      const mapGrid = buildMapGrid(location.coords.latitude, location.coords.longitude, SAVED_MAP_THUMBNAIL_DISPLAY_SIZE);

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
      // Capture the final photo first, before anything else — this is the
      // moment face verification actually succeeds, so the freeze has to
      // happen right here, not after the (often slow) GPS fix below.
      const captureFinalPhoto = async () =>
        (await cameraRef.current?.takePictureAsync({
          base64: true,
          quality: 0.7,
          shutterSound: false,
        })) ?? null;
      // Captures can transiently fail (e.g. right after the custom scan
      // pictureSize is applied, or under camera-session pressure); this is
      // the one capture that must not give up on the first hiccup.
      let photo = await captureFinalPhoto().catch(() => null);
      if (!photo?.uri) photo = await captureFinalPhoto();
      if (!photo?.uri) throw new Error("Failed to capture photo.");

      setIsFrozenStamped(false);
      setFrozenPreviewUri(photo.uri);
      // Hold the on-screen stamp preview (map/time/address) at this exact
      // instant — without this it kept ticking the live clock forward even
      // though the photo itself had already frozen.
      if (liveCoords) {
        setFrozenStamp({
          date: new Date(),
          address: liveAddress,
          mapGrid: buildMapGrid(liveCoords.latitude, liveCoords.longitude, MAP_THUMBNAIL_DISPLAY_SIZE),
        });
      }

      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      const addressResults = await Location.reverseGeocodeAsync({
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
      }).catch(() => []);

      const addressLabel =
        formatAddress(addressResults?.[0]) ?? formatStampCoords(location.coords.latitude, location.coords.longitude);
      const label = LOG_TYPE_LABEL[logType].toUpperCase();

      const watermarked = await applyWatermark(photo.uri, location, label, addressLabel);
      const finalImage = watermarked ?? (photo.base64 ? `data:image/jpeg;base64,${photo.base64}` : undefined);

      // Swap in the fully GPS-stamped version once it's ready, and hold on
      // it briefly so the snapshot actually registers as a still photo
      // before handing off to the result screen. The live GPS overlay (see
      // render below) stays visible on top of the frozen raw photo right up
      // until this point, so the map/date/address are never missing from
      // what's on screen, even during the brief gap while this composes.
      if (watermarked) {
        setFrozenPreviewUri(watermarked);
        setIsFrozenStamped(true);
      }
      await new Promise((resolve) => setTimeout(resolve, FREEZE_DISPLAY_MS));

      onComplete(location, finalImage);
    } catch (error) {
      setFrozenPreviewUri(null);
      setIsFrozenStamped(false);
      setFrozenStamp(null);
      console.error("Scan error", error);
      setScanError(error instanceof Error ? error.message : "Failed to capture location or photo.");
      setIsScanning(false);
      isFinishingRef.current = false;
    }
  }

  function retryScan() {
    isFinishingRef.current = false;
    faceDetectedRef.current = false;
    openBaselineRef.current = null;
    openSampleCountRef.current = 0;
    blinkCountRef.current = 0;
    setFaceDetected(false);
    setFaceBox(null);
    setConfidence(0);
    setScanProgress(0);
    setBlinkCount(0);
    setScanError(null);
    setFrozenPreviewUri(null);
    setIsFrozenStamped(false);
    setFrozenStamp(null);
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
        <View style={styles.errorCard}>
          <View style={styles.errorIconWrap}>
            <Ionicons name="shield-outline" size={28} color="#2563EB" />
          </View>
          <Text style={styles.errorTitle}>Permissions needed</Text>
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
            <Text style={styles.retryButtonText}>{canAskAgain ? "Grant Permission" : "Open Settings"}</Text>
          </Pressable>
          <Pressable style={styles.cancelLink} onPress={onCancel}>
            <Text style={styles.cancelLinkText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (scanError) {
    return (
      <View style={styles.centerContainer}>
        <View style={styles.errorCard}>
          <View style={styles.errorIconWrap}>
            <Ionicons name="warning-outline" size={28} color="#DC2626" />
          </View>
          <Text style={styles.errorTitle}>Verification interrupted</Text>
          <Text style={styles.errorText}>{scanError}</Text>
          <Pressable style={styles.retryButton} onPress={retryScan}>
            <Text style={styles.retryButtonText}>Try Again</Text>
          </Pressable>
          <Pressable style={styles.cancelLink} onPress={onCancel}>
            <Text style={styles.cancelLinkText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.topBar}>
        <Pressable onPress={onCancel} style={styles.closeButton}>
          <View style={styles.iconButton}>
            <Ionicons name="close" size={20} color="#0F172A" />
          </View>
        </Pressable>
        <View style={styles.topBarTextWrap}>
          <Text style={styles.title}>{LOG_TYPE_LABEL[logType]} Verification</Text>
          <Text style={styles.subtitle}>Secure face check with location confirmation</Text>
        </View>
        <View style={styles.topBarSpacer} />
      </View>

      <View style={styles.stageWrapper}>
        <View
          style={[
            styles.captureStage,
            photoSize.width && photoSize.height
              ? { aspectRatio: photoSize.width / photoSize.height }
              : { aspectRatio: 3 / 4 },
          ]}
          onLayout={(event) => setStageSize({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}
        >
          <CameraView
            ref={cameraRef}
            style={styles.camera}
            facing="front"
            animateShutter={false}
            // One fixed size for the whole session — fast captures for
            // blink sampling, still big enough for the final watermarked
            // photo, and never switched mid-session (each switch would
            // reconfigure the camera, and captures fail during that window
            // on slower devices).
            pictureSize={scanPictureSize ?? undefined}
            onCameraReady={handleCameraReady}
          >
            <View style={styles.stageOverlay}>
              <View style={styles.overlayHeader}>
                <View style={styles.overlayPill}>
                  <Ionicons name="scan-outline" size={14} color="#EFF6FF" />
                  <Text style={styles.overlayPillText}>
                    {faceDetected ? "Face detected" : "Position your face"}
                  </Text>
                </View>
                <View style={styles.overlayHint}>
                  <Ionicons name="sparkles-outline" size={14} color="#93C5FD" />
                  <Text style={styles.overlayHintText}>Blink once to confirm</Text>
                </View>
              </View>

              {frozenPreviewUri && (
                <Image
                  source={{ uri: frozenPreviewUri }}
                  style={StyleSheet.absoluteFillObject}
                  resizeMode="cover"
                />
              )}

              {!frozenPreviewUri && faceGuideRect && (
                <View
                  pointerEvents="none"
                  style={[
                    styles.faceGuide,
                    {
                      left: faceGuideRect.left,
                      top: faceGuideRect.top,
                      width: faceGuideRect.width,
                      height: faceGuideRect.height,
                      borderColor: faceDetected ? LOCKED_COLOR : GUIDE_BOX_COLOR,
                    },
                  ]}
                />
              )}


              {secondsLeft != null && (
                <View style={styles.captureHeader}>
                  <View style={styles.countdownChip}>
                    <Ionicons name="timer-outline" size={16} color="#FFFFFF" />
                    <Text style={styles.captureHeaderCountdown}>{secondsLeft}</Text>
                  </View>
                </View>
              )}

              {!isFrozenStamped && overlayMapGrid && (
                <View style={styles.gpsWatermarkRow} pointerEvents="none">
                  <View style={styles.mapThumbnailWrap}>
                    {overlayMapGrid.cells.map((cell) => (
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
                        {LOG_TYPE_LABEL[logType].toUpperCase()} · {formatStampDate(overlayDate)}
                      </Text>
                    </View>
                    <Text style={styles.addressText} numberOfLines={2}>{overlayAddress ?? "Locating..."}</Text>
                  </View>
                </View>
              )}
            </View>
          </CameraView>
        </View>
      </View>

      <View style={styles.footer}>
        <View style={styles.statusCard}>
          <View style={styles.statusCardRow}>
            <View style={styles.statusIconWrap}>
              {isScanning ? (
                <ActivityIndicator size="small" color="#2563EB" />
              ) : (
                <Ionicons
                  name={isLocked ? "checkmark-circle" : faceDetected ? "scan-outline" : "alert-circle-outline"}
                  size={18}
                  color="#2563EB"
                />
              )}
            </View>
            <View style={styles.statusCopy}>
              <Text style={styles.statusLabel}>
                {isScanning ? "Processing" : isLocked ? "Ready" : faceDetected ? "Tracking" : "Preparing"}
              </Text>
              <Text style={styles.statusText}>{getStageText(faceDetected, scanProgress, blinkCount)}</Text>
            </View>
          </View>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.min(100, Math.max(6, scanProgress))}%` }]} />
          </View>
        </View>
        <View style={styles.footerCard}>
          <Ionicons name="shield-checkmark-outline" size={18} color="#2563EB" />
          <Text style={styles.footerText}>Your face and location are verified securely before attendance is recorded.</Text>
        </View>
      </View>

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
            <View style={styles.gpsWatermarkRowSaved}>
              <View style={styles.mapThumbnailWrapSaved}>
                {pendingCapture.mapGrid.cells.map((cell) => (
                  <Image
                    key={cell.key}
                    source={{ uri: cell.url }}
                    style={[styles.mapTileImage, { left: cell.left, top: cell.top }]}
                    onLoadEnd={() => mapImageReadyRef.current?.()}
                    onError={() => mapImageReadyRef.current?.()}
                  />
                ))}
                <Ionicons name="location" size={50} color="#DC2626" style={styles.mapPinIconSaved} />
              </View>
              <View style={styles.gpsTextColumnSaved}>
                <View style={styles.dateBadgeSaved}>
                  <Text style={styles.dateBadgeTextSaved}>{pendingCapture.label} · {pendingCapture.dateLabel}</Text>
                </View>
                <Text style={styles.addressTextSaved} numberOfLines={3}>{pendingCapture.addressLabel}</Text>
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
    backgroundColor: "#F8FAFC",
  },
  centerContainer: {
    flex: 1,
    backgroundColor: "#F8FAFC",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 24,
  },
  errorCard: {
    width: "100%",
    backgroundColor: "#FFFFFF",
    borderRadius: 24,
    padding: 24,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#E2E8F0",
    shadowColor: "#020617",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 4,
  },
  errorIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: "#EFF6FF",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 14,
  },
  errorTitle: {
    color: "#0F172A",
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 8,
  },
  errorText: {
    color: "#475569",
    fontSize: 14,
    textAlign: "center",
    marginBottom: 20,
    lineHeight: 20,
  },
  retryButton: {
    backgroundColor: "#2563EB",
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 999,
    minWidth: 180,
    alignItems: "center",
  },
  retryButtonText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "700",
  },
  cancelLink: {
    marginTop: 14,
  },
  cancelLinkText: {
    color: "#64748B",
    fontSize: 14,
    fontWeight: "600",
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 54,
    paddingHorizontal: 20,
    paddingBottom: 16,
    backgroundColor: "#FFFFFF",
    borderBottomWidth: 1,
    borderBottomColor: "#E2E8F0",
  },
  closeButton: {
    padding: 4,
  },
  iconButton: {
    width: 38,
    height: 38,
    borderRadius: 999,
    backgroundColor: "#F1F5F9",
    justifyContent: "center",
    alignItems: "center",
  },
  topBarTextWrap: {
    flex: 1,
    alignItems: "center",
  },
  topBarSpacer: {
    width: 38,
  },
  title: {
    color: "#0F172A",
    fontSize: 17,
    fontWeight: "700",
  },
  subtitle: {
    color: "#64748B",
    fontSize: 12,
    marginTop: 2,
  },
  stageWrapper: {
    flex: 1,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 6,
    justifyContent: "center",
  },
  captureStage: {
    width: "100%",
    borderRadius: 24,
    overflow: "hidden",
    backgroundColor: "#020617",
    borderWidth: 1,
    borderColor: "rgba(148,163,184,0.2)",
    shadowColor: "#020617",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.2,
    shadowRadius: 24,
    elevation: 8,
  },
  camera: {
    flex: 1,
  },
  stageOverlay: {
    flex: 1,
    backgroundColor: "rgba(2,6,23,0.18)",
  },
  overlayHeader: {
    position: "absolute",
    top: 16,
    left: 16,
    right: 16,
    zIndex: 2,
    gap: 8,
  },
  overlayPill: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(10, 15, 26, 0.72)",
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
  },
  overlayPillText: {
    color: "#F8FAFC",
    fontSize: 12,
    fontWeight: "700",
  },
  overlayHint: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(255,255,255,0.12)",
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
  },
  overlayHintText: {
    color: "#E0F2FE",
    fontSize: 12,
    fontWeight: "600",
  },
  captureHeader: {
    position: "absolute",
    top: 16,
    right: 16,
    zIndex: 2,
  },
  countdownChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(220,38,38,0.9)",
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
  },
  captureHeaderCountdown: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "800",
    lineHeight: 16,
  },
  faceGuide: {
    position: "absolute",
    borderWidth: 2,
    borderStyle: "dashed",
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  statusCard: {
    backgroundColor: "rgba(255,255,255,0.95)",
    borderRadius: 12,
    padding: 8,
    borderWidth: 1,
    borderColor: "rgba(226,232,240,0.9)",
  },
  statusCardRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  statusIconWrap: {
    width: 28,
    height: 28,
    borderRadius: 999,
    backgroundColor: "#EFF6FF",
    justifyContent: "center",
    alignItems: "center",
  },
  statusCopy: {
    flex: 1,
  },
  statusLabel: {
    color: "#0F172A",
    fontSize: 11,
    fontWeight: "700",
    marginBottom: 1,
  },
  statusText: {
    color: "#475569",
    fontSize: 10.5,
    lineHeight: 13,
  },
  progressTrack: {
    height: 4,
    marginTop: 6,
    borderRadius: 999,
    backgroundColor: "#E2E8F0",
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: 999,
    backgroundColor: "#2563EB",
  },
  footer: {
    paddingHorizontal: 18,
    paddingTop: 8,
    paddingBottom: 22,
    backgroundColor: "#FFFFFF",
    borderTopWidth: 1,
    borderTopColor: "#E2E8F0",
    gap: 8,
  },
  footerCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#F8FAFC",
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: "#E2E8F0",
  },
  footerText: {
    flex: 1,
    color: "#475569",
    fontSize: 12.5,
    lineHeight: 18,
  },
  hiddenCaptureHost: {
    position: "absolute",
    top: 0,
    left: 0,
    opacity: 0,
  },
  gpsWatermarkRow: {
    position: "absolute",
    left: 10,
    right: 10,
    bottom: 10,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    zIndex: 3,
  },
  mapThumbnailWrap: {
    width: 74,
    height: 74,
    borderRadius: 14,
    overflow: "hidden",
    borderWidth: 2,
    borderColor: "#FFFFFF",
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
    left: 74 / 2 - 12,
    top: 74 / 2 - 20,
    textShadowColor: "#FFFFFF",
    textShadowRadius: 3,
    textShadowOffset: { width: 0, height: 0 },
  },
  gpsTextColumn: {
    flex: 1,
    justifyContent: "flex-end",
    gap: 4,
  },
  dateBadge: {
    alignSelf: "flex-start",
    backgroundColor: "#DC2626",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  dateBadgeText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "800",
  },
  addressText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "700",
    lineHeight: 15,
    textShadowColor: "rgba(0,0,0,0.85)",
    textShadowRadius: 4,
    textShadowOffset: { width: 0, height: 1 },
  },
  gpsWatermarkRowSaved: {
    position: "absolute",
    left: 40,
    right: 40,
    bottom: 40,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 26,
  },
  mapThumbnailWrapSaved: {
    width: SAVED_MAP_THUMBNAIL_DISPLAY_SIZE,
    height: SAVED_MAP_THUMBNAIL_DISPLAY_SIZE,
    borderRadius: 28,
    overflow: "hidden",
    borderWidth: 4,
    borderColor: "#FFFFFF",
    backgroundColor: "#CBD5E1",
    position: "relative",
  },
  mapPinIconSaved: {
    position: "absolute",
    left: SAVED_MAP_THUMBNAIL_DISPLAY_SIZE / 2 - 25,
    top: SAVED_MAP_THUMBNAIL_DISPLAY_SIZE / 2 - 46,
    textShadowColor: "#FFFFFF",
    textShadowRadius: 3,
    textShadowOffset: { width: 0, height: 0 },
  },
  gpsTextColumnSaved: {
    flex: 1,
    justifyContent: "flex-end",
    gap: 12,
  },
  dateBadgeSaved: {
    alignSelf: "flex-start",
    backgroundColor: "#DC2626",
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 13,
  },
  dateBadgeTextSaved: {
    color: "#FFFFFF",
    fontSize: 32,
    fontWeight: "800",
  },
  addressTextSaved: {
    color: "#FFFFFF",
    fontSize: 31,
    fontWeight: "700",
    lineHeight: 38,
    textShadowColor: "rgba(0,0,0,0.85)",
    textShadowRadius: 4,
    textShadowOffset: { width: 0, height: 1 },
  },
});
