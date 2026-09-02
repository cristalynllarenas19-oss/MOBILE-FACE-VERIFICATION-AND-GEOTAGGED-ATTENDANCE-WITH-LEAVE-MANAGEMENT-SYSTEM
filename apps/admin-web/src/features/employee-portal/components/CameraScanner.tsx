/**
 * CameraScanner — web port of employee-mobile/src/components/CameraScanner.tsx
 *
 * Matches the mobile behaviour exactly:
 *  • Front camera via getUserMedia (mirrored selfie preview via CSS)
 *  • Polls /face/detect every 250 ms with an unmirrored canvas snapshot
 *  • Static oval face guide, fixed spot/size (same computeFaceGuideRect math
 *    as mobile's faceGuideRect) — not a box that tracks the detected face
 *  • Blink-based liveness check (same EAR-dip algorithm as mobile) must pass
 *    before "hold steady" progress starts advancing; resets to 0 the moment
 *    detection is lost (HOLD_TO_LOCK_MS = 1 500 ms)
 *  • Auto-captures on lock: takes a raw (unwatermarked) high-quality frame,
 *    gets high-accuracy GPS, reverse-geocodes via Nominatim, then calls
 *    onComplete with that raw image and coordinates. The GPS stamp is drawn
 *    as a DOM overlay (see gpsRow below), never baked into the uploaded
 *    pixels — same as mobile, and it's what lets any attendance-photo
 *    viewer (DTR history, etc.) render the same stamp later from the
 *    record's own stored lat/lon/timestamp instead of a fixed image.
 *  • Live GPS stamp preview on the camera overlay (same Carto tile grid)
 */

import { CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, ScanFace, ShieldCheck, Sparkles, Timer, X } from "lucide-react";
import { detectFace, FaceBox } from "../api";
import { buildMapGrid, formatCoordsFallback, formatStampDate, reverseGeocode, TILE_SIZE } from "../gpsStamp";
import "./CameraScanner.css";

// ── Constants matching mobile's CameraScanner cadence ────────────────────────
// Capture (canvas draw) and network send are decoupled into two independent
// loops — same reasoning as mobile's captureLoop/sendLatestBlinkFrame split:
// a single draw-then-await-network loop leaves the camera idle for an entire
// round trip on every cycle, which is exactly the dead time a fast blink can
// fall into. CAPTURE_POLL_MS paces the (cheap, client-only) frame grab;
// the network loop re-arms itself immediately on every response, always
// sending whichever frame is freshest rather than one that's already stale.
const CAPTURE_POLL_MS = 40;
const DETECT_POLL_MS  = 200; // backoff delay after a failed request
const HOLD_TO_LOCK_MS = 450;
const TICK_MS         = 100;
// Blink-based liveness check — same rationale as mobile CameraScanner: this
// must pass BEFORE hold-to-lock starts counting (and therefore before
// capture), so a held-up photo (which can never blink) can't be verified.
// One comparison per sample against a running "eyes open" baseline; the dip
// sample itself is never folded into the baseline. The moment a blink is
// registered, capture starts immediately (see registerEyeSample) instead of
// waiting for the next progress tick.
const REQUIRED_BLINKS      = 1;
const MIN_BASELINE_SAMPLES = 1;
const EAR_DIP_RATIO        = 0.97;
const FIRST_SAMPLE_CLOSED_EAR = 0.18; // same-first-frame blink fast path
// Static face guide, same fixed spot/size as mobile's FACE_GUIDE_WIDTH_RATIO
// / FACE_GUIDE_ASPECT_RATIO — width/height ratio makes it read as an oval,
// a bit taller than wide, like a face.
const FACE_GUIDE_WIDTH_RATIO  = 0.52;
const FACE_GUIDE_ASPECT_RATIO = 0.75;
const GUIDE_BOX_COLOR = "#1D4ED8";
const LOCKED_COLOR    = "#22C55E";
const MAP_LIVE_PX     = 82;   // GPS stamp overlay's map thumbnail, live or frozen
const FREEZE_DELAY_MS = 250;
// Fixed pixel bands reserved at the top (status pills) and bottom (GPS
// stamp) of the stage — the guide oval is sized to always fit inside
// whatever's left between them (see computeFaceGuideRect), rather than the
// pills/stamp being positioned relative to the oval. Their own content is
// close to a fixed pixel size regardless of stage size (a 90px map
// thumbnail, one or two small pills), so reserving fixed bands is what
// guarantees neither the oval nor the stamp/pills can ever collide or spill
// past the stage edge — sizing the oval as a stage-height *ratio* instead
// (the previous approach) could still push it into a short/wide stage's
// fixed-size overlays, or push the GPS stamp past the bottom edge to dodge
// it.
// Trimmed to a few px above each element's real minimum (pill block ≈77px
// incl. its 16px top offset; GPS row ≈ MAP_LIVE_PX+12px bottom offset) —
// still a safe margin, just not an overly generous one, so the oval reads
// noticeably bigger without reopening the collision/clipping bug.
const GUIDE_TOP_RESERVED_PX    = 81;
const GUIDE_BOTTOM_RESERVED_PX = 98;

// ── Public types ──────────────────────────────────────────────────────────────
export type GeoPoint = { latitude: number; longitude: number; accuracy: number };

type Props = {
  logType: "TIME_IN" | "TIME_OUT" | "LUNCH_OUT" | "LUNCH_IN";
  onComplete: (location: GeoPoint, faceBase64: string) => void;
  onCancel: () => void;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Static on-screen face guide — same as mobile CameraScanner's faceGuideRect:
 * a fixed oval (not a box that tracks the detected face), always centered in
 * the stage at a consistent size, so the user lines their face up the same
 * way every time. CSS renders it as an ellipse via a large border-radius on
 * a non-square box.
 *
 * Mobile's stage is a fixed portrait 3:4 box, so sizing the oval purely off
 * stage width is safe there. Web's stage instead takes the webcam's own
 * (usually landscape) aspect ratio, so the same width-only math can produce
 * an oval taller than the stage itself — fit within whichever dimension is
 * more constraining. The height constraint is the band left over after
 * GUIDE_TOP_RESERVED_PX/GUIDE_BOTTOM_RESERVED_PX (not a plain stage-height
 * ratio), and the oval is centered within that band — this is what
 * guarantees it can never collide with the pills above or the GPS stamp
 * below, on any stage size, without those needing to know anything about
 * where the oval ended up.
 */
function computeFaceGuideRect(
  stageW: number, stageH: number,
): { x: number; y: number; w: number; h: number } | null {
  if (!stageW || !stageH) return null;
  const bandTop = GUIDE_TOP_RESERVED_PX;
  const bandH = Math.max(120, stageH - GUIDE_TOP_RESERVED_PX - GUIDE_BOTTOM_RESERVED_PX);
  const maxW = stageW * FACE_GUIDE_WIDTH_RATIO;
  let h = bandH;
  let w = h * FACE_GUIDE_ASPECT_RATIO;
  if (w > maxW) {
    w = maxW;
    h = w / FACE_GUIDE_ASPECT_RATIO;
  }
  return { x: (stageW - w) / 2, y: bandTop + (bandH - h) / 2, w, h };
}

type ScreenBox = { x: number; y: number; w: number; h: number };

/**
 * Maps the backend's relative (0-1) face box onto screen coordinates, same
 * as mobile's computeFaceScreenBox — accounts for the "cover" crop (video
 * has objectFit: "cover", same idea as mobile's camera preview) and for the
 * preview being mirrored while the detection frame it was computed from is
 * not (video has transform: scaleX(-1); the canvas used for detection draws
 * the raw, unmirrored frame — see the capture loop below).
 */
function computeFaceScreenBox(
  box: FaceBox | null,
  stageSize: { w: number; h: number },
  photoSize: { w: number; h: number },
): ScreenBox | null {
  if (!box || !stageSize.w || !stageSize.h || !photoSize.w || !photoSize.h) return null;

  const scale = Math.max(stageSize.w / photoSize.w, stageSize.h / photoSize.h);
  const renderedW = photoSize.w * scale;
  const renderedH = photoSize.h * scale;
  const cropX = (renderedW - stageSize.w) / 2;
  const cropY = (renderedH - stageSize.h) / 2;

  const boxX = box.x * photoSize.w;
  const boxY = box.y * photoSize.h;
  const boxW = box.width * photoSize.w;
  const boxH = box.height * photoSize.h;

  const padX = boxW * 0.08;
  const padY = boxH * 0.12;

  const rawX = Math.max(0, boxX * scale - cropX - padX);
  const y = Math.max(0, boxY * scale - cropY - padY);
  const w = Math.min(stageSize.w - rawX, boxW * scale + padX * 2);
  const h = Math.min(stageSize.h - y, boxH * scale + padY * 2);
  const x = Math.max(0, stageSize.w - rawX - w); // mirror to match the preview

  return { x, y, w, h };
}

/**
 * Whether the detected face's on-screen position actually lines up with the
 * static guide, rather than just "a face was detected somewhere in frame" —
 * same as mobile's isFaceCentered. Checks the detected face's center point
 * falls within the guide rather than requiring an exact/tight overlap.
 */
function isFaceCentered(box: ScreenBox | null, guide: { x: number; y: number; w: number; h: number } | null): boolean {
  if (!box || !guide) return false;
  const centerX = box.x + box.w / 2;
  const centerY = box.y + box.h / 2;
  return (
    centerX >= guide.x - guide.w * 0.1 &&
    centerX <= guide.x + guide.w * 1.1 &&
    centerY >= guide.y - guide.h * 0.1 &&
    centerY <= guide.y + guide.h * 1.1
  );
}

/**
 * Success chime — same moment/purpose as mobile's successSoundPlayer (a
 * short confirmation sound the instant capture succeeds), synthesized with
 * the Web Audio API instead of a bundled audio asset. Cosmetic only: a
 * failure here (blocked autoplay, no AudioContext, etc.) must never affect
 * the capture flow, same as mobile's own try/catch around playback.
 */
function playSuccessChime() {
  try {
    const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const start = ctx.currentTime;
    [880, 1175].forEach((freq, i) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = start + i * 0.09;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.22, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.24);
    });
    setTimeout(() => ctx.close(), 500);
  } catch {
    // Cosmetic — never let a chime failure affect the capture flow.
  }
}

function logTypeLabel(logType: Props["logType"]) {
  if (logType === "TIME_IN") return "TIME IN";
  if (logType === "TIME_OUT") return "TIME OUT";
  if (logType === "LUNCH_OUT") return "LUNCH OUT";
  return "LUNCH IN";
}

function logTypeTitle(logType: Props["logType"]) {
  if (logType === "TIME_IN") return "Time In";
  if (logType === "TIME_OUT") return "Time Out";
  if (logType === "LUNCH_OUT") return "Lunch Out";
  return "Lunch In";
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function CameraScanner({ logType, onComplete, onCancel }: Props) {
  const videoRef       = useRef<HTMLVideoElement>(null);
  const streamRef      = useRef<MediaStream | null>(null);
  const stageRef       = useRef<HTMLDivElement>(null);
  const isFinishingRef = useRef(false);
  const faceDetRef     = useRef(false);
  // Blink liveness refs — blinkCountRef mirrors blinkCount so the
  // interval-driven progress tick can read the latest value without a
  // stale-closure dependency on it. openBaselineRef/openSampleCountRef track
  // the running "eyes open" reference for the current attempt.
  const blinkCountRef      = useRef(0);
  const openBaselineRef    = useRef<number | null>(null);
  const openSampleCountRef = useRef(0);

  const [permDenied,   setPermDenied]   = useState(false);
  const [cameraReady,  setCameraReady]  = useState(false);
  const [faceDetected, setFaceDetected] = useState(false);
  const [faceBox,      setFaceBox]      = useState<FaceBox | null>(null);
  const [photoSize,    setPhotoSize]    = useState({ w: 0, h: 0 });
  const [stageSize,    setStageSize]    = useState({ w: 0, h: 0 });
  const [scanProgress, setScanProgress] = useState(0);
  const [blinkCount,   setBlinkCount]   = useState(0);
  const [isScanning,   setIsScanning]   = useState(false);
  const [scanError,    setScanError]    = useState<string | null>(null);
  const [frozenSrc,    setFrozenSrc]    = useState<string | null>(null);
  const [showSuccess,  setShowSuccess]  = useState(false);
  const [liveCoords,   setLiveCoords]   = useState<{ lat: number; lon: number } | null>(null);
  const [liveAddress,  setLiveAddress]  = useState<string | null>(null);
  const [now,          setNow]          = useState(() => new Date());
  // Holds the GPS stamp overlay steady at the exact instant of capture —
  // without this it would keep ticking the live clock/GPS forward even
  // though the photo itself has already frozen. Same as mobile's
  // frozenStamp.
  const [frozenStamp, setFrozenStamp] = useState<{ lat: number; lon: number; address: string; date: Date } | null>(null);

  // Live clock for the on-screen GPS stamp preview — same as mobile: pauses
  // the instant a face is detected (holding the timestamp steady while
  // verification is underway) and resumes as soon as the face is lost again,
  // so the badge only reads live "current time" while no one is being
  // verified.
  useEffect(() => {
    if (faceDetected) return;
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, [faceDetected]);

  // Start camera + seed GPS preview on mount
  useEffect(() => {
    let cancelled = false;

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      } catch (err) {
        if (cancelled) return;
        setPermDenied(true);
        setScanError(
          err instanceof Error && err.name === "NotAllowedError"
            ? "Camera access was denied. Allow camera permissions in your browser settings and reload."
            : `Could not access camera: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Seed GPS for live overlay — best-effort, non-blocking
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (cancelled) return;
          setLiveCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude });
          reverseGeocode(pos.coords.latitude, pos.coords.longitude).then((a) => {
            if (!cancelled) setLiveAddress(a);
          });
        },
        () => undefined,
        { enableHighAccuracy: false, timeout: 6000 },
      );
    }

    start();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Refresh GPS preview every 20 s — same cadence as mobile
  useEffect(() => {
    const iv = setInterval(() => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setLiveCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude });
          reverseGeocode(pos.coords.latitude, pos.coords.longitude).then(setLiveAddress);
        },
        () => undefined,
        { enableHighAccuracy: false, timeout: 8000 },
      );
    }, 20_000);
    return () => clearInterval(iv);
  }, []);

  // Track stage size via ResizeObserver
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([e]) =>
      setStageSize({ w: e.contentRect.width, h: e.contentRect.height }),
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // finishScan is called inside a setInterval callback; useCallback keeps the
  // ref stable so we don't close over stale state.
  const finishScan = useCallback(async () => {
    setIsScanning(true);
    setScanError(null);
    try {
      const video = videoRef.current!;

      // Capture frame immediately (freeze the preview) — raw, unwatermarked:
      // the stamp is drawn as a DOM overlay (see gpsRow/frozenStamp), never
      // baked into the uploaded pixels, same as mobile.
      const cap = document.createElement("canvas");
      cap.width  = video.videoWidth;
      cap.height = video.videoHeight;
      cap.getContext("2d")!.drawImage(video, 0, 0);
      const rawDataUrl = cap.toDataURL("image/jpeg", 0.85);
      setFrozenSrc(rawDataUrl);

      // High-accuracy GPS (same as mobile's Location.Accuracy.High)
      const { coords } = await new Promise<GeolocationPosition>((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej, {
          enableHighAccuracy: true,
          timeout: 10_000,
        }),
      );

      const address =
        (await reverseGeocode(coords.latitude, coords.longitude)) ??
        formatCoordsFallback(coords.latitude, coords.longitude);

      setFrozenStamp({ lat: coords.latitude, lon: coords.longitude, address, date: new Date() });
      setShowSuccess(true);
      playSuccessChime();

      await new Promise((r) => setTimeout(r, FREEZE_DELAY_MS));

      onComplete(
        { latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy ?? 999 },
        rawDataUrl,
      );
    } catch (err) {
      setFrozenSrc(null);
      setFrozenStamp(null);
      setShowSuccess(false);
      setScanError(err instanceof Error ? err.message : "Failed to capture location or photo.");
      setIsScanning(false);
      isFinishingRef.current = false;
    }
  }, [logType, onComplete]);

  // The first sample can pass immediately when it reads clearly closed;
  // otherwise one open-eye sample establishes a personal baseline and every
  // later lower sample is accepted as a blink. The dip sample itself is
  // never folded into the baseline (that would drag the baseline down and
  // make the next blink harder to trigger). Same logic as mobile
  // CameraScanner.registerEyeSample, including the immediate capture
  // hand-off on blink instead of waiting for the next progress tick.
  function registerEyeSample(ear: number | null) {
    if (ear === null) return;

    const baseline = openBaselineRef.current;
    const ready = openSampleCountRef.current >= MIN_BASELINE_SAMPLES && baseline !== null;
    const firstSampleClosed = !ready && ear <= FIRST_SAMPLE_CLOSED_EAR;
    const isBlink = firstSampleClosed || (ready && ear < (baseline as number) * EAR_DIP_RATIO);

    if (isBlink) {
      blinkCountRef.current = Math.min(REQUIRED_BLINKS, blinkCountRef.current + 1);
      setBlinkCount(blinkCountRef.current);
      if (!isFinishingRef.current) {
        isFinishingRef.current = true;
        setScanProgress(100);
        void finishScan();
      }
      return;
    }

    openBaselineRef.current = baseline === null ? ear : baseline * 0.7 + ear * 0.3;
    openSampleCountRef.current += 1;
  }

  // Face detection — capture and network send run as two decoupled loops,
  // same pattern as mobile's captureLoop/sendLatestBlinkFrame split. A single
  // draw-then-await loop leaves the camera idle for an entire round trip on
  // every cycle, which is exactly the dead time a fast blink can fall into.
  // captureFrame grabs a fresh (downscaled) frame every CAPTURE_POLL_MS
  // regardless of network state; sendLatest re-arms itself immediately on
  // every response and always sends whichever frame is freshest at that
  // moment, so the network is never working on a stale frame. Always uses
  // the fast/tiny detection model (same as mobile) rather than "precise"
  // mode, trading a little landmark accuracy for materially lower backend
  // inference time during the timing-critical blink-sampling phase.
  useEffect(() => {
    if (!cameraReady || isScanning || scanError) return;
    let cancelled = false;
    let captureTid: ReturnType<typeof setTimeout>;
    let sendTid: ReturnType<typeof setTimeout>;
    let latestFrame: string | null = null;

    function captureFrame() {
      if (cancelled) return;
      const video = videoRef.current;
      if (video?.videoWidth) {
        // Full webcam resolution, not downscaled client-side: a webcam frame
        // is already much noisier/dimmer than a phone selfie camera, so
        // shrinking it further before the backend's own detector-input
        // resize (192/288px, see face-verification.service.ts) was pushing
        // real webcam frames below the detector's confidence threshold.
        // Feeding the backend a clean, full-res source and letting it do
        // that resize itself keeps detection reliable; the fast tiny model
        // and decoupled capture/send loop below are what give the speed win.
        const c = document.createElement("canvas");
        c.width  = video.videoWidth;
        c.height = video.videoHeight;
        c.getContext("2d")!.drawImage(video, 0, 0); // unmirrored for detection
        latestFrame = c.toDataURL("image/jpeg", 0.6);
      }
      captureTid = setTimeout(captureFrame, CAPTURE_POLL_MS);
    }

    async function sendLatest() {
      if (cancelled || isFinishingRef.current) return;
      if (!latestFrame) {
        sendTid = setTimeout(sendLatest, CAPTURE_POLL_MS);
        return;
      }

      const frame = latestFrame;
      const samplingBlink = blinkCountRef.current < REQUIRED_BLINKS;
      let failed = false;
      try {
        const result = await detectFace(frame, false);
        if (cancelled) return;

        faceDetRef.current = result.detected;
        setFaceDetected(result.detected);
        setFaceBox(result.detected ? result.box : null);
        if (result.detected && samplingBlink) registerEyeSample(result.ear);
      } catch (err) {
        if (cancelled) return;
        failed = true;
        faceDetRef.current = false;
        setFaceDetected(false);
        setFaceBox(null);
        // A network/backend failure here looks identical to "no face found"
        // in the UI (both just show "Position your face" forever) — this is
        // what makes that distinction visible in devtools instead of silent.
        console.error("Face detection request failed", err);
      } finally {
        if (!cancelled) {
          sendTid = setTimeout(sendLatest, failed ? DETECT_POLL_MS * 3 : 0);
        }
      }
    }

    captureFrame();
    sendLatest();
    return () => {
      cancelled = true;
      clearTimeout(captureTid);
      clearTimeout(sendTid);
    };
  }, [cameraReady, isScanning, scanError]);

  // Progress tick — same as mobile. Only starts advancing once the blink
  // liveness check has passed; resets (along with the whole liveness
  // attempt) the moment the face is lost.
  useEffect(() => {
    if (!cameraReady || isScanning || scanError) return;
    const tick = setInterval(() => {
      setScanProgress((prev) => {
        if (!faceDetRef.current) {
          if (blinkCountRef.current > 0 || prev > 0) {
            openBaselineRef.current    = null;
            openSampleCountRef.current = 0;
            blinkCountRef.current      = 0;
            setBlinkCount(0);
          }
          return 0;
        }
        if (blinkCountRef.current < REQUIRED_BLINKS) return 0;
        const next = Math.min(100, prev + (TICK_MS / HOLD_TO_LOCK_MS) * 100);
        if (next >= 100 && !isFinishingRef.current) {
          isFinishingRef.current = true;
          finishScan();
        }
        return next;
      });
    }, TICK_MS);
    return () => clearInterval(tick);
  }, [cameraReady, isScanning, scanError, finishScan]);

  function retryScan() {
    isFinishingRef.current = false;
    faceDetRef.current     = false;
    blinkCountRef.current      = 0;
    openBaselineRef.current    = null;
    openSampleCountRef.current = 0;
    setFaceDetected(false);
    setFaceBox(null);
    setScanProgress(0);
    setBlinkCount(0);
    setScanError(null);
    setFrozenSrc(null);
    setFrozenStamp(null);
    setShowSuccess(false);
    setIsScanning(false);
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const faceGuideRect = computeFaceGuideRect(stageSize.w, stageSize.h);
  // Whether the detected face is actually positioned within the guide, not
  // just present somewhere in frame — same distinction as mobile's
  // faceCentered, used to decide whether the guide reads as "locked on."
  const screenBox = computeFaceScreenBox(faceBox, stageSize, photoSize);
  const faceCentered = faceDetected && isFaceCentered(screenBox, faceGuideRect);
  const isLocked  = scanProgress >= 100;
  const livenessVerified = blinkCount >= REQUIRED_BLINKS;
  const secondsLeft =
    faceDetected && livenessVerified && !isLocked
      ? Math.max(1, Math.ceil(((100 - scanProgress) / 100) * (HOLD_TO_LOCK_MS / 1000)))
      : null;
  // Same as mobile's overlayDate/overlayAddress/overlayMapGrid: the stamp
  // overlay holds still at the frozen capture instant once there is one,
  // otherwise it tracks the live GPS/clock.
  const overlayDate    = frozenStamp ? frozenStamp.date : now;
  const overlayAddress = frozenStamp ? frozenStamp.address : liveAddress;
  const overlayCoords  = frozenStamp ? { lat: frozenStamp.lat, lon: frozenStamp.lon } : liveCoords;
  const overlayTiles   = overlayCoords ? buildMapGrid(overlayCoords.lat, overlayCoords.lon, MAP_LIVE_PX) : null;

  const stageLabel = isScanning
    ? "Verifying Location & Identity..."
    : isLocked
      ? "Face locked!"
      : faceDetected
        ? (livenessVerified ? "Liveness verified — hold steady..." : "Please blink to verify you're not a photo")
        : "No face detected — position your face inside the frame";

  // ── Error / permission screen ──────────────────────────────────────────────
  if (permDenied || (scanError && !isScanning)) {
    return (
      <div style={S.shell}>
        <div style={S.centerBox}>
          <div style={S.errorCard}>
            <div style={S.errorIconWrap}>
              <AlertCircle size={28} color="#DC2626" />
            </div>
            <h2 style={S.errorTitle}>
              {permDenied ? "Camera access needed" : "Verification interrupted"}
            </h2>
            <p style={S.errorText}>{scanError ?? "Camera permission was denied."}</p>
            {scanError && !permDenied && (
              <button style={S.retryButton} onClick={retryScan}>Try Again</button>
            )}
            <button style={S.cancelLink} onClick={onCancel}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  // ── Main scanner UI ────────────────────────────────────────────────────────
  return (
    <div style={S.shell}>
      {/* Top bar */}
      <div style={S.topBar}>
        <button style={S.closeBtn} onClick={onCancel} aria-label="Cancel">
          <X size={20} color="#0F172A" />
        </button>
        <div style={S.topBarTextWrap}>
          <div style={S.titleRow}>
            <ShieldCheck size={14} color="#2563EB" />
            <span style={S.title}>{logTypeTitle(logType)} Verification</span>
          </div>
          <span style={S.subtitle}>Secure face check with location confirmation</span>
        </div>
        <div style={{ width: 32 }} />
      </div>

      {/* Camera stage */}
      <div style={S.stageWrapper}>
        <div
          ref={stageRef}
          style={{
            ...S.stage,
            aspectRatio:
              photoSize.w && photoSize.h
                ? `${photoSize.w} / ${photoSize.h}`
                : "3 / 4",
          }}
        >
          {/* Live mirrored video (hidden once frozen) */}
          {!frozenSrc && (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              style={S.video}
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                setPhotoSize({ w: v.videoWidth, h: v.videoHeight });
                setCameraReady(true);
              }}
            />
          )}

          {/* Frozen preview after capture */}
          {frozenSrc && (
            <img src={frozenSrc} alt="capture" style={S.frozenImg} />
          )}

          {/* Vignette — darkens the feed's edges for a more scanner-like feel */}
          <div style={S.vignette} />

          {/* Progress bar at top of stage */}
          <div style={S.progressTrack}>
            <div
              style={{
                ...S.progressFill,
                width: `${scanProgress}%`,
                background: isLocked ? "#22C55E" : "#1D4ED8",
              }}
            />
          </div>

          {/* Status pills — same as mobile's overlayHeader. Fixed top offset
              is safe here: the guide oval is sized to always leave
              GUIDE_TOP_RESERVED_PX clear above it (see
              computeFaceGuideRect), so this can never collide with it. */}
          {!frozenSrc && (
            <div style={S.overlayHeader} className="cs-pill">
              <div style={{ ...S.overlayPill, background: faceDetected ? "rgba(34,197,94,0.85)" : "rgba(15,23,42,0.55)" }}>
                <ScanFace size={14} color="#EFF6FF" />
                <span style={S.overlayPillText}>{faceDetected ? "Face detected" : "Position your face"}</span>
              </div>
              {faceDetected && (
                <div style={S.overlayHint}>
                  <Sparkles size={14} color="#93C5FD" />
                  <span style={S.overlayHintText}>
                    {livenessVerified ? "Liveness verified" : "Blink once to confirm"}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Success checkmark overlay */}
          {showSuccess && (
            <div style={S.successOverlay} className="cs-success-overlay">
              <div style={S.successCircle} className="cs-success-circle">
                <CheckCircle2 size={56} color="#FFFFFF" />
              </div>
            </div>
          )}

          {/* Countdown */}
          {!frozenSrc && secondsLeft != null && (
            <div style={S.countdownChip}>
              <Timer size={15} color="#FFFFFF" />
              <span style={S.countdownText}>{secondsLeft}</span>
            </div>
          )}

          {/* Static oval face guide — same fixed spot/size as mobile's faceGuide,
              not a box that tracks the detected face */}
          {!frozenSrc && faceGuideRect && (
            <div
              style={{
                position: "absolute",
                left:   faceGuideRect.x,
                top:    faceGuideRect.y,
                width:  faceGuideRect.w,
                height: faceGuideRect.h,
                border: `3px dashed ${faceCentered ? LOCKED_COLOR : GUIDE_BOX_COLOR}`,
                borderRadius: "50%",
                background: "rgba(255,255,255,0.03)",
                pointerEvents: "none",
                boxSizing: "border-box",
                transition: "border-color 0.2s ease",
              }}
            >
              {isLocked && (
                <CheckCircle2
                  size={28}
                  color="#22C55E"
                  style={{
                    position: "absolute",
                    top: "50%", left: "50%",
                    transform: "translate(-50%,-50%)",
                  }}
                />
              )}
            </div>
          )}

          {/* GPS stamp overlay — same as mobile's gpsWatermarkRow. Drawn on
              top of the live preview or the frozen capture alike (never
              baked into the uploaded photo itself — see finishScan/
              frozenStamp above), so it holds steady through the freeze/
              success moment instead of disappearing the instant the photo
              is captured. Fixed bottom offset is safe here: the guide oval
              is sized to always leave GUIDE_BOTTOM_RESERVED_PX clear below
              it (see computeFaceGuideRect), so this can never collide with
              it or get clipped by the stage edge. */}
          {overlayTiles && (
            <div style={S.gpsRow}>
              <div style={S.mapThumb}>
                {overlayTiles.map((cell) => (
                  <img
                    key={cell.key}
                    src={cell.url}
                    alt=""
                    style={{
                      position: "absolute",
                      left: cell.left, top: cell.top,
                      width: TILE_SIZE, height: TILE_SIZE,
                    }}
                  />
                ))}
                <div style={S.mapPin} />
              </div>
              <div style={S.gpsTextCol}>
                <div style={S.dateBadge}>
                  {logTypeLabel(logType)} · {formatStampDate(overlayDate)}
                </div>
                <div style={S.addressText}>{overlayAddress ?? "Locating…"}</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Status + reassurance footer */}
      <div style={S.footer}>
        <div style={S.statusCard}>
          <div style={S.statusCardRow}>
            <div style={S.statusIconWrap}>
              {isScanning && !showSuccess
                ? <Loader2 size={16} color="#1D4ED8" className="cs-spin" />
                : <ScanFace
                    size={16}
                    color={showSuccess ? LOCKED_COLOR : "#1D4ED8"}
                  />}
            </div>
            <div style={S.statusCopy}>
              <span style={S.statusLabel}>
                {showSuccess ? "Captured" : isScanning ? "Processing" : isLocked ? "Ready" : faceDetected ? "Tracking" : "Preparing"}
              </span>
              <span style={S.statusText}>{stageLabel}</span>
            </div>
          </div>
          {!showSuccess && (
            <div style={S.progressTrackFooter}>
              <div
                style={{
                  ...S.progressFillFooter,
                  width: `${Math.min(100, Math.max(6, scanProgress))}%`,
                  background: isLocked ? "#22C55E" : "#1D4ED8",
                }}
              />
            </div>
          )}
        </div>
        <div style={S.footerCard}>
          <ShieldCheck size={18} color="#1D4ED8" />
          <span style={S.footerText}>
            Your face and location are verified securely before attendance is recorded.
          </span>
        </div>
      </div>

      {/* Hidden video element kept in DOM while frozen so bakeWatermark can
          still read videoWidth/videoHeight */}
      {frozenSrc && (
        <video
          ref={videoRef}
          autoPlay playsInline muted
          style={{ position: "absolute", opacity: 0, pointerEvents: "none", width: 1, height: 1 }}
        />
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const S: Record<string, CSSProperties> = {
  shell: {
    position: "fixed", inset: 0,
    background: "#F1F5F9",
    zIndex: 1000,
    display: "flex", flexDirection: "column",
  },
  centerBox: {
    flex: 1,
    display: "flex", flexDirection: "column",
    alignItems: "center", justifyContent: "center",
    padding: "0 24px", gap: 16, textAlign: "center",
  },
  errorCard: {
    display: "flex", flexDirection: "column", alignItems: "center",
    gap: 6,
    background: "#FFFFFF",
    borderRadius: 20,
    padding: "32px 28px",
    maxWidth: 380, width: "100%",
    boxShadow: "0 12px 32px rgba(2,6,23,0.12)",
    border: "1px solid #E2E8F0",
  },
  errorIconWrap: {
    width: 56, height: 56, borderRadius: "50%",
    background: "#FEE2E2",
    display: "flex", alignItems: "center", justifyContent: "center",
    marginBottom: 6,
  },
  errorTitle: { fontSize: 17, fontWeight: 800, color: "#0F172A", margin: 0 },
  errorText:  { color: "#475569", fontSize: 14, lineHeight: "20px", margin: "2px 0 12px" },
  retryButton: {
    background: "#1D4ED8", color: "#fff",
    border: "none", borderRadius: 12,
    padding: "12px 28px", fontSize: 14, fontWeight: 700, cursor: "pointer",
    width: "100%",
    boxShadow: "0 6px 16px rgba(29,78,216,0.28)",
  },
  cancelLink: {
    background: "none", border: "none", cursor: "pointer",
    color: "#64748B", fontSize: 13, fontWeight: 600,
    padding: "10px 0 0",
  },
  topBar: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "14px 20px",
    background: "#FFFFFF", borderBottom: "1px solid #E2E8F0",
    boxShadow: "0 2px 6px rgba(15,23,42,0.04)",
    flexShrink: 0,
  },
  closeBtn: {
    background: "#F1F5F9", border: "1px solid #E2E8F0", cursor: "pointer",
    width: 32, height: 32, borderRadius: "50%",
    display: "flex", alignItems: "center", justifyContent: "center",
    flexShrink: 0,
  },
  topBarTextWrap: { display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "0 8px" },
  titleRow: { display: "flex", alignItems: "center", gap: 5 },
  title: { fontSize: 15, fontWeight: 800, color: "#0F172A", letterSpacing: 0.1 },
  subtitle: { fontSize: 11.5, fontWeight: 500, color: "#64748B", lineHeight: "16px", textAlign: "center" },
  stageWrapper: {
    flex: 1,
    padding: "16px 20px 8px",
    display: "flex", alignItems: "center", justifyContent: "center",
    overflow: "hidden",
  },
  stage: {
    position: "relative",
    width: "100%", maxWidth: 720,
    borderRadius: 20, overflow: "hidden",
    background: "#050816",
    border: "1px solid rgba(148,163,184,0.18)",
    boxShadow: "0 10px 30px rgba(2,6,23,0.25)",
  },
  video: {
    position: "absolute", inset: 0,
    width: "100%", height: "100%",
    objectFit: "cover",
    transform: "scaleX(-1)", // mirror for selfie view
    // Display-only polish — a raw webcam feed often reads flat/dim. This is
    // a CSS filter on the preview element only; the unmirrored canvas draw
    // used for detection/capture reads the video's decoded pixels directly
    // and is unaffected by it.
    filter: "contrast(1.06) saturate(1.08) brightness(1.03)",
  },
  frozenImg: {
    position: "absolute", inset: 0,
    width: "100%", height: "100%",
    objectFit: "cover",
  },
  vignette: {
    position: "absolute", inset: 0,
    pointerEvents: "none",
    background: "radial-gradient(ellipse at center, rgba(2,6,23,0) 52%, rgba(2,6,23,0.5) 100%)",
    zIndex: 1,
  },
  progressTrack: {
    position: "absolute", top: 0, left: 0, right: 0,
    height: 4, background: "rgba(255,255,255,0.15)", zIndex: 2,
  },
  progressFill: {
    height: "100%",
    transition: "width 0.1s linear, background 0.3s",
  },
  overlayHeader: {
    // Safe as a fixed offset — see GUIDE_TOP_RESERVED_PX.
    position: "absolute", top: 16, left: 0, right: 0,
    display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
    zIndex: 3, pointerEvents: "none",
  },
  overlayPill: {
    display: "flex", alignItems: "center", gap: 6,
    padding: "6px 14px", borderRadius: 999,
    backdropFilter: "blur(6px)",
    transition: "background 0.25s ease",
  },
  overlayPillText: { color: "#EFF6FF", fontSize: 12, fontWeight: 700 },
  overlayHint: {
    display: "flex", alignItems: "center", gap: 6,
    background: "rgba(15,23,42,0.55)",
    padding: "5px 12px", borderRadius: 999,
    backdropFilter: "blur(6px)",
  },
  overlayHintText: { color: "#DBEAFE", fontSize: 11.5, fontWeight: 600 },
  successOverlay: {
    position: "absolute", inset: 0,
    display: "flex", alignItems: "center", justifyContent: "center",
    background: "rgba(2,6,23,0.35)",
    zIndex: 5,
  },
  successCircle: {
    width: 96, height: 96, borderRadius: "50%",
    background: "#22C55E",
    display: "flex", alignItems: "center", justifyContent: "center",
    boxShadow: "0 0 0 8px rgba(34,197,94,0.22)",
  },
  countdownChip: {
    position: "absolute", top: 16, left: "50%",
    transform: "translateX(-50%)",
    display: "flex", alignItems: "center", gap: 6,
    background: "rgba(220,38,38,0.9)",
    padding: "6px 14px", borderRadius: 999,
    pointerEvents: "none", zIndex: 3,
    boxShadow: "0 4px 12px rgba(220,38,38,0.35)",
  },
  countdownText: { color: "#fff", fontSize: 15, fontWeight: 800 },
  gpsRow: {
    // Safe as a fixed offset — see GUIDE_BOTTOM_RESERVED_PX.
    position: "absolute", left: 12, right: 12, bottom: 12,
    display: "flex", alignItems: "flex-end", gap: 10,
    zIndex: 3, pointerEvents: "none",
  },
  mapThumb: {
    position: "relative",
    width: MAP_LIVE_PX, height: MAP_LIVE_PX, flexShrink: 0,
    borderRadius: 12, overflow: "hidden",
    border: "2px solid #FFFFFF", background: "#CBD5E1",
  },
  mapPin: {
    position: "absolute",
    left: MAP_LIVE_PX / 2 - 5, top: MAP_LIVE_PX / 2 - 12,
    width: 10, height: 10, borderRadius: "50%",
    background: "#DC2626", boxShadow: "0 0 0 2.5px #fff",
    zIndex: 4,
  },
  gpsTextCol: {
    flex: 1, display: "flex", flexDirection: "column",
    gap: 5, justifyContent: "flex-end",
  },
  dateBadge: {
    alignSelf: "flex-start",
    background: "#DC2626", color: "#FFFFFF",
    padding: "4px 10px", borderRadius: 6,
    fontSize: 11, fontWeight: 800,
  },
  addressText: {
    color: "#FFFFFF", fontSize: 11, fontWeight: 700,
    textShadow: "0 1px 4px rgba(0,0,0,0.85)",
    overflow: "hidden",
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
  },
  footer: {
    display: "flex", flexDirection: "column", gap: 10,
    padding: "8px 20px 20px",
    background: "#FFFFFF", borderTop: "1px solid #E2E8F0",
    flexShrink: 0,
  },
  statusCard: {
    display: "flex", flexDirection: "column", gap: 10,
    background: "#EFF6FF",
    border: "1px solid #DBEAFE",
    borderRadius: 14, padding: "12px 14px",
  },
  statusCardRow: {
    display: "flex", alignItems: "center", gap: 10,
  },
  statusIconWrap: {
    width: 30, height: 30, borderRadius: "50%",
    background: "#FFFFFF",
    display: "flex", alignItems: "center", justifyContent: "center",
    flexShrink: 0,
    boxShadow: "0 1px 3px rgba(15,23,42,0.12)",
  },
  statusCopy: { flex: 1, display: "flex", flexDirection: "column", gap: 1, minWidth: 0 },
  statusLabel: { color: "#1E3A8A", fontSize: 12.5, fontWeight: 800 },
  statusText: { color: "#3B5A8A", fontSize: 12.5, lineHeight: "17px" },
  progressTrackFooter: {
    height: 5, borderRadius: 999,
    background: "rgba(59,130,246,0.15)",
    overflow: "hidden",
  },
  progressFillFooter: {
    height: "100%", borderRadius: 999,
    transition: "width 0.1s linear, background 0.3s",
  },
  footerCard: {
    display: "flex", alignItems: "flex-start", gap: 10,
    background: "#F8FAFC",
    border: "1px solid #E2E8F0",
    borderRadius: 14, padding: "10px 14px",
  },
  footerText: { flex: 1, color: "#64748B", fontSize: 11.5, lineHeight: "16px" },
};
