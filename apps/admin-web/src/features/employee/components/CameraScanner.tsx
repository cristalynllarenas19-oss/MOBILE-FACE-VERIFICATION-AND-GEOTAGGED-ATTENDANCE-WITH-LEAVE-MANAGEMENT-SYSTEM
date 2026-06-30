/**
 * CameraScanner — web port of employee-mobile/src/components/CameraScanner.tsx
 *
 * Matches the mobile behaviour exactly:
 *  • Front camera via getUserMedia (mirrored selfie preview via CSS)
 *  • Polls /face/detect every 250 ms with an unmirrored canvas snapshot
 *  • Tracks the returned bounding box on-screen (same computeFaceScreenBox math)
 *  • "Hold steady" progress advances while a face is continuously detected;
 *    resets to 0 the moment detection is lost (HOLD_TO_LOCK_MS = 1 500 ms)
 *  • Auto-captures on lock: takes high-quality frame, gets high-accuracy GPS,
 *    reverse-geocodes via Nominatim, bakes the GPS watermark with Canvas 2D
 *    (equivalent of mobile's react-native-view-shot composite), then calls
 *    onComplete with the stamped image and coordinates.
 *  • Live GPS stamp preview on the camera overlay (same Carto tile grid)
 */

import { CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle, Loader2, ScanFace, X } from "lucide-react";
import { detectFace, FaceBox } from "../api";

// ── Constants matching mobile exactly ────────────────────────────────────────
const DETECT_POLL_MS  = 250;
const HOLD_TO_LOCK_MS = 1500;
const TICK_MS         = 100;
const WATERMARK_WIDTH = 1080;
const TILE_SIZE       = 256;
const MAP_ZOOM        = 16;
const MAP_LIVE_PX     = 90;   // on-screen live preview map thumbnail
const MAP_SAVED_PX    = 210;  // baked into the saved watermark photo
const FREEZE_DELAY_MS = 900;

// ── Public types ──────────────────────────────────────────────────────────────
export type GeoPoint = { latitude: number; longitude: number; accuracy: number };

type Props = {
  logType: "TIME_IN" | "TIME_OUT";
  onComplete: (location: GeoPoint, faceBase64: string) => void;
  onCancel: () => void;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Same math as mobile CameraScanner.computeFaceScreenBox */
function computeFaceScreenBox(
  box: FaceBox | null,
  stageW: number, stageH: number,
  photoW: number, photoH: number,
): { x: number; y: number; w: number; h: number } | null {
  if (!box || !stageW || !stageH || !photoW || !photoH) return null;

  const scale = Math.max(stageW / photoW, stageH / photoH);
  const rw = photoW * scale;
  const rh = photoH * scale;
  const cx = (rw - stageW) / 2;
  const cy = (rh - stageH) / 2;

  const bx = box.x * photoW;
  const by = box.y * photoH;
  const bw = box.width  * photoW;
  const bh = box.height * photoH;

  const padX = bw * 0.08;
  const padY = bh * 0.12;

  const rawX = Math.max(0, bx * scale - cx - padX);
  const y    = Math.max(0, by * scale - cy - padY);
  const w    = Math.min(stageW - rawX, bw * scale + padX * 2);
  const h    = Math.min(stageH - y,   bh * scale + padY * 2);
  // Mirror horizontally — front camera preview is selfie-flipped via CSS
  const x    = Math.max(0, stageW - rawX - w);

  return { x, y, w, h };
}

/** Same Carto tile grid as mobile CameraScanner.buildMapGrid */
type TileCell = { key: string; url: string; left: number; top: number };
function buildMapGrid(lat: number, lon: number, displayPx: number): TileCell[] {
  const worldSize = TILE_SIZE * Math.pow(2, MAP_ZOOM);
  const gx = ((lon + 180) / 360) * worldSize;
  const lr = (lat * Math.PI) / 180;
  const gy = ((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2) * worldSize;
  const half = displayPx / 2;
  const wl = gx - half;
  const wt = gy - half;
  const tx0 = Math.floor(wl / TILE_SIZE);
  const ty0 = Math.floor(wt / TILE_SIZE);
  const cells: TileCell[] = [];
  for (let dx = 0; dx <= 1; dx++) {
    for (let dy = 0; dy <= 1; dy++) {
      const tx = tx0 + dx;
      const ty = ty0 + dy;
      cells.push({
        key: `${tx}_${ty}`,
        url: `https://a.basemaps.cartocdn.com/rastertiles/voyager/${MAP_ZOOM}/${tx}/${ty}@2x.png`,
        left: tx * TILE_SIZE - wl,
        top:  ty * TILE_SIZE - wt,
      });
    }
  }
  return cells;
}

/** Same stamp date format as mobile */
function formatStampDate(d: Date) {
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit",
  });
}

/** Nominatim reverse geocoding — free, no API key */
async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`,
      { headers: { "Accept-Language": "en" } },
    );
    const d = await r.json() as { display_name?: string };
    return d.display_name ?? null;
  } catch {
    return null;
  }
}

/**
 * Bakes the GPS watermark into the captured photo using Canvas 2D.
 * Equivalent of mobile's applyWatermark (react-native-view-shot composite).
 * The image is drawn unmirrored (raw frame) at 1080 px wide.
 */
async function bakeWatermark(
  video: HTMLVideoElement,
  lat: number, lon: number,
  label: string, address: string,
): Promise<string> {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const W  = WATERMARK_WIDTH;
  const H  = Math.round((vh / vw) * W);

  const canvas = document.createElement("canvas");
  canvas.width  = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  // Draw raw (unmirrored) frame
  ctx.drawImage(video, 0, 0, W, H);

  // ── Map tile thumbnail ────────────────────────────────────────────────────
  const MAP  = MAP_SAVED_PX;
  const ML   = 40;
  const MT   = H - 40 - MAP;

  ctx.save();
  ctx.beginPath();
  (ctx as CanvasRenderingContext2D & { roundRect: (...a: unknown[]) => void })
    .roundRect(ML, MT, MAP, MAP, 18);
  ctx.clip();
  ctx.fillStyle = "#CBD5E1";
  ctx.fillRect(ML, MT, MAP, MAP);

  const tiles = buildMapGrid(lat, lon, MAP);
  await Promise.race([
    Promise.all(
      tiles.map(
        (cell) =>
          new Promise<void>((res) => {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload  = () => { ctx.drawImage(img, ML + cell.left, MT + cell.top, TILE_SIZE, TILE_SIZE); res(); };
            img.onerror = () => res();
            img.src = cell.url;
          }),
      ),
    ),
    new Promise<void>((res) => setTimeout(res, 2500)),
  ]);
  ctx.restore();

  // Tile border
  ctx.save();
  ctx.strokeStyle = "#FFFFFF";
  ctx.lineWidth   = 4;
  ctx.beginPath();
  (ctx as CanvasRenderingContext2D & { roundRect: (...a: unknown[]) => void })
    .roundRect(ML, MT, MAP, MAP, 18);
  ctx.stroke();
  ctx.restore();

  // Red pin at map centre
  const pinX = ML + MAP / 2;
  const pinY = MT + MAP / 2;
  ctx.save();
  ctx.fillStyle = "#DC2626";
  ctx.beginPath();
  ctx.arc(pinX, pinY - 12, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(pinX, pinY + 10);
  ctx.lineTo(pinX - 10, pinY - 4);
  ctx.lineTo(pinX + 10, pinY - 4);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#FFFFFF";
  ctx.beginPath();
  ctx.arc(pinX, pinY - 12, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // ── Date/label badge ──────────────────────────────────────────────────────
  const TXT_X   = ML + MAP + 26;
  const BADGE_W = W - TXT_X - ML;
  const BADGE_Y = MT + MAP - 88;
  const BADGE_H = 52;

  ctx.save();
  ctx.fillStyle = "#DC2626";
  ctx.beginPath();
  (ctx as CanvasRenderingContext2D & { roundRect: (...a: unknown[]) => void })
    .roundRect(TXT_X, BADGE_Y, BADGE_W, BADGE_H, 13);
  ctx.fill();
  ctx.fillStyle     = "#FFFFFF";
  ctx.font          = "bold 28px sans-serif";
  ctx.textBaseline  = "middle";
  ctx.fillText(`${label} · ${formatStampDate(new Date())}`, TXT_X + 16, BADGE_Y + BADGE_H / 2, BADGE_W - 24);
  ctx.restore();

  // ── Address text ──────────────────────────────────────────────────────────
  ctx.save();
  ctx.shadowColor   = "rgba(0,0,0,0.85)";
  ctx.shadowBlur    = 4;
  ctx.fillStyle     = "#FFFFFF";
  ctx.font          = "bold 27px sans-serif";
  ctx.textBaseline  = "top";

  const words = address.split(" ");
  let line = "";
  let lineY = BADGE_Y + BADGE_H + 14;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > BADGE_W - 10) {
      ctx.fillText(line, TXT_X, lineY, BADGE_W);
      line   = word;
      lineY += 36;
      if (lineY > H - 20) break;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, TXT_X, lineY, BADGE_W);
  ctx.restore();

  return canvas.toDataURL("image/jpeg", 0.9);
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function CameraScanner({ logType, onComplete, onCancel }: Props) {
  const videoRef       = useRef<HTMLVideoElement>(null);
  const streamRef      = useRef<MediaStream | null>(null);
  const stageRef       = useRef<HTMLDivElement>(null);
  const isFinishingRef = useRef(false);
  const faceDetRef     = useRef(false);

  const [permDenied,   setPermDenied]   = useState(false);
  const [cameraReady,  setCameraReady]  = useState(false);
  const [faceDetected, setFaceDetected] = useState(false);
  const [faceBox,      setFaceBox]      = useState<FaceBox | null>(null);
  const [photoSize,    setPhotoSize]    = useState({ w: 0, h: 0 });
  const [stageSize,    setStageSize]    = useState({ w: 0, h: 0 });
  const [confidence,   setConfidence]   = useState(0);
  const [scanProgress, setScanProgress] = useState(0);
  const [isScanning,   setIsScanning]   = useState(false);
  const [scanError,    setScanError]    = useState<string | null>(null);
  const [frozenSrc,    setFrozenSrc]    = useState<string | null>(null);
  const [liveCoords,   setLiveCoords]   = useState<{ lat: number; lon: number } | null>(null);
  const [liveAddress,  setLiveAddress]  = useState<string | null>(null);
  const [now,          setNow]          = useState(() => new Date());

  // Live clock tick
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

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

      // Capture frame immediately (freeze the preview)
      const cap = document.createElement("canvas");
      cap.width  = video.videoWidth;
      cap.height = video.videoHeight;
      cap.getContext("2d")!.drawImage(video, 0, 0);
      const rawDataUrl = cap.toDataURL("image/jpeg", 0.7);
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
        `${Math.abs(coords.latitude).toFixed(6)}°${coords.latitude >= 0 ? "N" : "S"}, ` +
        `${Math.abs(coords.longitude).toFixed(6)}°${coords.longitude >= 0 ? "E" : "W"}`;

      const label    = logType === "TIME_IN" ? "TIME IN" : "TIME OUT";
      const stamped  = await bakeWatermark(video, coords.latitude, coords.longitude, label, address);
      setFrozenSrc(stamped);

      await new Promise((r) => setTimeout(r, FREEZE_DELAY_MS));

      onComplete(
        { latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy ?? 999 },
        stamped,
      );
    } catch (err) {
      setFrozenSrc(null);
      setScanError(err instanceof Error ? err.message : "Failed to capture location or photo.");
      setIsScanning(false);
      isFinishingRef.current = false;
    }
  }, [logType, onComplete]);

  // Face detection polling — chain-scheduled, same pattern as mobile
  useEffect(() => {
    if (!cameraReady || isScanning || scanError) return;
    let cancelled = false;
    let tid: ReturnType<typeof setTimeout>;

    async function pollOnce() {
      if (cancelled || isFinishingRef.current) return;
      const video = videoRef.current;
      if (!video?.videoWidth) {
        tid = setTimeout(pollOnce, DETECT_POLL_MS);
        return;
      }

      let failed = false;
      try {
        const c = document.createElement("canvas");
        c.width  = video.videoWidth;
        c.height = video.videoHeight;
        c.getContext("2d")!.drawImage(video, 0, 0); // unmirrored for detection
        const dataUrl = c.toDataURL("image/jpeg", 0.3);

        setPhotoSize({ w: video.videoWidth, h: video.videoHeight });

        const result = await detectFace(dataUrl);
        if (cancelled) return;

        faceDetRef.current = result.detected;
        setFaceDetected(result.detected);
        setConfidence(result.detected ? result.confidence : 0);
        setFaceBox(result.detected ? result.box : null);
      } catch {
        if (cancelled) return;
        failed = true;
        faceDetRef.current = false;
        setFaceDetected(false);
        setFaceBox(null);
      } finally {
        if (!cancelled) tid = setTimeout(pollOnce, failed ? DETECT_POLL_MS * 3 : DETECT_POLL_MS);
      }
    }

    pollOnce();
    return () => { cancelled = true; clearTimeout(tid); };
  }, [cameraReady, isScanning, scanError]);

  // Progress tick — same as mobile
  useEffect(() => {
    if (!cameraReady || isScanning || scanError) return;
    const tick = setInterval(() => {
      setScanProgress((prev) => {
        if (!faceDetRef.current) return 0;
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
    setFaceDetected(false);
    setFaceBox(null);
    setConfidence(0);
    setScanProgress(0);
    setScanError(null);
    setFrozenSrc(null);
    setIsScanning(false);
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const screenBox = computeFaceScreenBox(faceBox, stageSize.w, stageSize.h, photoSize.w, photoSize.h);
  const isLocked  = scanProgress >= 100;
  const secondsLeft =
    faceDetected && !isLocked
      ? Math.max(1, Math.ceil(((100 - scanProgress) / 100) * (HOLD_TO_LOCK_MS / 1000)))
      : null;
  const liveTiles = liveCoords ? buildMapGrid(liveCoords.lat, liveCoords.lon, MAP_LIVE_PX) : null;

  const stageLabel = isScanning
    ? "Verifying Location & Identity..."
    : isLocked
      ? "Face locked!"
      : faceDetected
        ? "Face detected, hold steady..."
        : "No face detected — position your face inside the frame";

  // ── Error / permission screen ──────────────────────────────────────────────
  if (permDenied || (scanError && !isScanning)) {
    return (
      <div style={S.shell}>
        <div style={S.centerBox}>
          <AlertCircle size={44} color="#DC2626" />
          <p style={S.errorText}>{scanError ?? "Camera permission was denied."}</p>
          {scanError && (
            <button style={S.retryBtn} onClick={retryScan}>Try Again</button>
          )}
          <button style={{ ...S.retryBtn, background: "#64748B", marginTop: 10 }} onClick={onCancel}>
            Cancel
          </button>
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
          <X size={24} color="#0F172A" />
        </button>
        <span style={S.title}>
          {logType === "TIME_IN" ? "Time In" : "Time Out"} Verification
        </span>
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

          {/* Countdown */}
          {!frozenSrc && secondsLeft != null && (
            <div style={S.countdown}>{secondsLeft}</div>
          )}

          {/* Face bounding box overlay */}
          {!frozenSrc && screenBox && (
            <div
              style={{
                position: "absolute",
                left:   screenBox.x,
                top:    screenBox.y,
                width:  screenBox.w,
                height: screenBox.h,
                border: `3px solid ${isLocked ? "#22C55E" : "#1D4ED8"}`,
                borderRadius: 14,
                pointerEvents: "none",
                boxSizing: "border-box",
              }}
            >
              {isLocked && (
                <CheckCircle
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

          {/* Confidence % */}
          {!frozenSrc && faceDetected && (
            <span style={S.confidenceLabel}>{Math.round(confidence * 100)}%</span>
          )}

          {/* Live GPS stamp overlay — same as mobile's gpsWatermarkRow */}
          {!frozenSrc && liveTiles && (
            <div style={S.gpsRow}>
              <div style={S.mapThumb}>
                {liveTiles.map((cell) => (
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
                  {logType === "TIME_IN" ? "TIME IN" : "TIME OUT"} · {formatStampDate(now)}
                </div>
                <div style={S.addressText}>{liveAddress ?? "Locating…"}</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Status bar footer */}
      <div style={S.footer}>
        <div style={S.statusBar}>
          {isScanning
            ? <Loader2 size={16} color="#1D4ED8" style={{ animation: "spin 1s linear infinite", flexShrink: 0 }} />
            : <ScanFace size={16} color="#1D4ED8" style={{ flexShrink: 0 }} />}
          <span style={S.statusText}>{stageLabel}</span>
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
  errorText:  { color: "#0F172A", fontSize: 15, margin: 0 },
  retryBtn: {
    background: "#1D4ED8", color: "#fff",
    border: "none", borderRadius: 12,
    padding: "12px 28px", fontSize: 14, fontWeight: 700, cursor: "pointer",
  },
  topBar: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "14px 20px",
    background: "#FFFFFF", borderBottom: "1px solid #E2E8F0",
    flexShrink: 0,
  },
  closeBtn: {
    background: "none", border: "none", cursor: "pointer",
    padding: 4, display: "flex", alignItems: "center",
  },
  title: { fontSize: 16, fontWeight: 700, color: "#193D69" },
  stageWrapper: {
    flex: 1,
    padding: "16px 20px 8px",
    display: "flex", alignItems: "center", justifyContent: "center",
    overflow: "hidden",
  },
  stage: {
    position: "relative",
    width: "100%", maxWidth: 520,
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
  },
  frozenImg: {
    position: "absolute", inset: 0,
    width: "100%", height: "100%",
    objectFit: "cover",
  },
  progressTrack: {
    position: "absolute", top: 0, left: 0, right: 0,
    height: 4, background: "rgba(255,255,255,0.15)", zIndex: 2,
  },
  progressFill: {
    height: "100%",
    transition: "width 0.1s linear, background 0.3s",
  },
  countdown: {
    position: "absolute", top: 18, left: 0, right: 0,
    textAlign: "center",
    color: "#fff", fontSize: 38, fontWeight: 800,
    pointerEvents: "none", zIndex: 3,
  },
  confidenceLabel: {
    position: "absolute", top: 12, left: 14,
    color: "#EFF6FF", fontSize: 13, fontWeight: 800,
    textShadow: "0 0 4px rgba(30,64,175,0.9)",
    zIndex: 3, pointerEvents: "none",
  },
  gpsRow: {
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
    padding: "8px 20px 20px",
    background: "#FFFFFF", borderTop: "1px solid #E2E8F0",
    flexShrink: 0,
  },
  statusBar: {
    display: "flex", alignItems: "center", gap: 8,
    background: "#EFF6FF",
    borderLeft: "3px solid #3B82F6",
    borderRadius: 8, padding: "10px 12px",
  },
  statusText: { flex: 1, color: "#1E3A8A", fontSize: 13, lineHeight: "18px" },
};
