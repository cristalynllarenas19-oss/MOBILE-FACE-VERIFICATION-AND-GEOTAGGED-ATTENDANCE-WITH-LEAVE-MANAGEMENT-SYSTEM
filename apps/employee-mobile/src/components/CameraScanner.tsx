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
        // — at full sensor resolution that encode alone can take longer
        // than a whole blink, which was very likely why blinks kept landing
        // between samples no matter how good the detection model was. The
        // resize below produces a far smaller base64 string instead.
        const photo = await cameraRef.current?.takePictureAsync({
          quality: samplingBlink ? 0.5 : 0.3,
          shutterSound: false,
        });
        if (cancelled) return;
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
          if (resized.base64) {
            if (samplingBlink) {
              // Hand off to the decoupled send loop instead of awaiting the
              // network here — that's the whole point: keep capturing while
              // a previous frame is still in flight on the backend.
              blinkFrameSeq += 1;
              latestBlinkFrame = { base64: resized.base64, seq: blinkFrameSeq };
              sendLatestBlinkFrame();
            } else {
              const result = await detectFace(`data:image/jpeg;base64,${resized.base64}`, false);
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
    if (ear === null) {
      if (__DEV__) console.log("[liveness] ear=null (no landmarks this frame)");
      return;
    }

    const baseline = openBaselineRef.current;
    const ready = openSampleCountRef.current >= MIN_BASELINE_SAMPLES && baseline !== null;
    const isBlink = ready && ear < (baseline as number) * EAR_DIP_RATIO;

    if (__DEV__) {
      console.log(
        `[liveness] ear=${ear.toFixed(3)} baseline=${(baseline ?? 0).toFixed(3)} cutoff=${ready ? ((baseline as number) * EAR_DIP_RATIO).toFixed(3) : "n/a"}${isBlink ? " -> BLINK" : ""}`,
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
      const photo = await cameraRef.current?.takePictureAsync({
        base64: true,
        quality: 0.7,
        shutterSound: false,
      });
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
      const label = logType === "TIME_IN" ? "TIME IN" : "TIME OUT";

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
          style={[
            styles.captureStage,
            // Pin the stage to the captured photo's own aspect ratio (falling
            // back to the common 3:4 phone-camera default before the first
            // photo arrives). Without this, the stage's shape is whatever
            // leftover flex space the screen layout happens to give it, which
            // is usually much taller/narrower than the actual photo — the
            // "cover" math then has to crop away a large slice of the frame
            // to fill it, which inflates how big the face's box looks on
            // screen even though its proportions in the source photo are
            // unchanged. Matching the photo's real ratio removes that crop.
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
            onCameraReady={() => setCameraReady(true)}
          >
            <View style={styles.stageOverlay}>
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

              {!frozenPreviewUri && (
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
              )}

              {secondsLeft != null && (
                <View style={styles.captureHeader}>
                  <Text style={styles.captureHeaderCountdown}>{secondsLeft}</Text>
                </View>
              )}

              {/* Live preview of the geotag stamp that will be burned into the captured photo.
                  Stays visible (now overlaid on the frozen still instead of live video) until
                  the fully-stamped composite is ready, so the map/date/address are never
                  missing from what's on screen during that brief gap. */}
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
                        {logType === "TIME_IN" ? "TIME IN" : "TIME OUT"} · {formatStampDate(overlayDate)}
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
              <Text style={styles.statusText}>{getStageText(faceDetected, scanProgress, blinkCount)}</Text>
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
    justifyContent: "center",
  },
  captureStage: {
    width: "100%",
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
  },
  captureHeaderCountdown: {
    color: "#fff",
    fontSize: 38,
    fontWeight: "800",
    lineHeight: 42,
    minHeight: 42,
  },
  trackedBox: {
    position: "absolute",
    borderWidth: 4,
    borderRadius: 18,
    borderColor: GUIDE_BOX_COLOR,
  },
  // Fixed placement/size guide shown before (and independently of) the
  // backend's own dynamic tracked box, so the user has a consistent target
  // to line their face up with rather than guessing distance/position.
  faceGuide: {
    position: "absolute",
    borderWidth: 3,
    borderStyle: "dashed",
    borderRadius: 999,
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
    left: 0,
    opacity: 0,
  },
  // Live, on-screen verification stamp — original, smaller sizing.
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
  // Saved/composited photo stamp (baked into the file shown in DTR) —
  // enlarged so the map/date/address stay legible at the photo's full size.
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
