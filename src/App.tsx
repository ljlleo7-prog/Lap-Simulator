import { useState, useMemo, useCallback, useRef, useEffect, lazy, Suspense } from "react";
import { SectionTable } from "./components/SectionTable.tsx";
import { VehicleForm } from "./components/VehicleForm.tsx";
import { TrackCanvas } from "./components/TrackCanvas.tsx";
import { CarIoPanel, TrackIoPanel } from "./components/IoPanel.tsx";
import {
  buildBezierSegments,
  sampleCentreLine,
  centreSamplesToTrackPoints,
  computeHalfWidths,
  racingLineFromOffsets,
} from "./geometry.js";
import type { CrossSection, RacingLineSample } from "./geometry.js";
import type { TrackPoint } from "./track.js";
import type { VehicleParams } from "./vehicle.js";
import type { SimResult } from "./integrator.js";
import type { Offsets, SimMode } from "./optimizer.js";

const Results = lazy(() => import("./components/Results.tsx").then(m => ({ default: m.Results })));
const OptimizerPanel = lazy(() => import("./components/OptimizerPanel.tsx").then(m => ({ default: m.OptimizerPanel })));

const DEFAULT_SECTIONS: CrossSection[] = [
  { id: "1", x: 0,    y: 0,    direction: 0,   width: 12 },
  { id: "2", x: 300,  y: 0,    direction: 0,   width: 12 },
  { id: "3", x: 350,  y: 50,   direction: 90,  width: 12 },
  { id: "4", x: 350,  y: 200,  direction: 90,  width: 12 },
  { id: "5", x: 300,  y: 250,  direction: 180, width: 12 },
  { id: "6", x: 0,    y: 250,  direction: 180, width: 12 },
  { id: "7", x: -50,  y: 200,  direction: 270, width: 12 },
  { id: "8", x: -50,  y: 50,   direction: 270, width: 12 },
];

const DEFAULT_VEHICLE: VehicleParams = {
  mass: 700, dragArea: 0.9, liftArea: 3.0,
  muLat: 1.8, muLon: 1.8, tyreDragK: 0.05,
  curveMode: "torque", finalDrive: 8.5, wheelRadius: 0.33,
  drivetrainLayout: "RWD", brakeBias: 0.6, diffLockRear: 0.0, diffLockFront: 0.0,
  weightDistFront: 0.45, wheelbase: 2.5, trackWidth: 1.8, cgHeight: 0.35,
  yawInertia: 900, steeringLockDeg: 32,
  corneringStiffnessFront: 70000, corneringStiffnessRear: 80000, yawDragK: 0.15,
  powerCurve: [
    { x: 2000, y: 300 }, { x: 4000, y: 380 }, { x: 6000, y: 420 },
    { x: 8000, y: 400 }, { x: 10000, y: 340 }, { x: 12000, y: 250 },
  ],
};

type SimLineSample = RacingLineSample;
type PathDisplay = "intended" | "drifted" | "both";

interface SimSnapshot {
  result: SimResult;
  lineSamples: SimLineSample[];
  trackPoints: TrackPoint[];
  source: "centre" | "opt";
}

function formatLapTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(3).padStart(6, "0");
  return m > 0 ? `${m}:${s}` : `${t.toFixed(3)}s`;
}

function playbackSample(result: SimResult, elapsed: number): { index: number; alpha: number } {
  const times = result.sampleTimes;
  const n = times.length;
  if (n < 2) return { index: 0, alpha: 0 };
  if (elapsed <= 0) return { index: 0, alpha: 0 };
  if (elapsed >= result.lapTime) return { index: n - 1, alpha: 0 };
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= elapsed) lo = mid;
    else hi = mid;
  }
  const dt = times[lo + 1] - times[lo];
  return { index: lo, alpha: dt > 0 ? (elapsed - times[lo]) / dt : 0 };
}

// ── shared style tokens ───────────────────────────────────────────────────────

const COL_W = 320;
const colStyle: React.CSSProperties = {
  width: COL_W, flexShrink: 0, display: "flex", flexDirection: "column",
  overflowY: "auto",
};

// ── session name field ────────────────────────────────────────────────────────

function SessionHeader({ title, name, onName }: { title: string; name: string; onName: (s: string) => void }) {
  return (
    <div style={{ padding: "10px 14px 8px", borderBottom: "1px solid #1e1e1e", flexShrink: 0 }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: "#555", textTransform: "uppercase", marginBottom: 6 }}>{title}</div>
      <input
        value={name}
        onChange={e => onName(e.target.value)}
        placeholder="Session name…"
        style={{
          width: "100%", boxSizing: "border-box", background: "#141414", border: "1px solid #2a2a2a",
          color: "#c0c0c0", padding: "4px 8px", borderRadius: 4, fontSize: 12,
        }}
      />
    </div>
  );
}

// ── main app ──────────────────────────────────────────────────────────────────

export default function App() {
  const [committedSections, setCommittedSections] = useState<CrossSection[]>(DEFAULT_SECTIONS);
  const [displaySections,   setDisplaySections]   = useState<CrossSection[]>(DEFAULT_SECTIONS);
  const [vehicle,    setVehicle]    = useState<VehicleParams>(DEFAULT_VEHICLE);
  const [result,     setResult]     = useState<SimResult | null>(null);
  const [simSnapshot, setSimSnapshot] = useState<SimSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [useOptLine, setUseOptLine] = useState(false);
  const [optOffsets, setOptOffsets] = useState<Offsets | null>(null);
  const [carName,    setCarName]    = useState("");
  const [trackName,  setTrackName]  = useState("");
  const [showResults, setShowResults] = useState(false);
  const [simMode, setSimMode] = useState<SimMode>("slide");
  const [pathDisplay, setPathDisplay] = useState<PathDisplay>("both");
  const [driftTolerance, setDriftTolerance] = useState(0.18);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackElapsed, setPlaybackElapsed] = useState(0);
  const playbackElapsedRef = useRef(0);
  const playbackStartRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  // canvas / image state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [bgImageUrl, setBgImageUrl] = useState<string | null>(null);
  const [bgOpacity,  setBgOpacity]  = useState(1);
  const [imageRect,  setImageRect]  = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [calibMode,  setCalibMode]  = useState<"off" | "point" | "distance">("off");
  const [showGrid,   setShowGrid]   = useState(false);
  const [gridSize,   setGridSize]   = useState<50 | 100>(50);
  const [editLineMode,   setEditLineMode]   = useState(false);
  const [handleStride,   setHandleStride]   = useState(5);
  const [gaussianWidth,  setGaussianWidth]  = useState(0.08);
  const [trackLocked,    setTrackLocked]    = useState(false);

  const segments      = useMemo(() => buildBezierSegments(committedSections, true), [committedSections]);
  const centreSamples = useMemo(() => sampleCentreLine(segments), [segments]);
  const hw            = useMemo(() => computeHalfWidths(centreSamples, committedSections, segments), [centreSamples, committedSections, segments]);

  const racingLine = useMemo((): RacingLineSample[] => {
    if (optOffsets && optOffsets.length === centreSamples.length)
      return racingLineFromOffsets(optOffsets, hw, centreSamples);
    return centreSamples.map(s => ({ x: s.x, y: s.y, distance: s.distance, radius: s.radius, tangentAngle: s.tangentAngle }));
  }, [optOffsets, hw, centreSamples]);

  const trackPoints = useMemo(
    () => useOptLine
      ? racingLine.map((s, i) => ({ distance: s.distance, radius: s.radius, x: s.x, y: s.y, tangentAngle: s.tangentAngle, halfWidth: hw[i] }))
      : centreSamplesToTrackPoints(centreSamples, hw),
    [useOptLine, racingLine, centreSamples, hw],
  );

  const hasInvalid = segments.some(s => s.invalid);

  const playback = simSnapshot ? playbackSample(simSnapshot.result, playbackElapsed) : { index: -1, alpha: 0 };
  const playbackActive = isPlaying || playbackElapsed > 0;

  const resetPlayback = useCallback(() => {
    setIsPlaying(false);
    playbackElapsedRef.current = 0;
    setPlaybackElapsed(0);
  }, []);

  const setSnapshot = useCallback((snapshot: SimSnapshot) => {
    setResult(snapshot.result);
    setSimSnapshot(snapshot);
    setShowResults(true);
    playbackElapsedRef.current = 0;
    setPlaybackElapsed(0);
    setIsPlaying(false);
  }, []);

  useEffect(() => {
    if (!isPlaying || !simSnapshot) return;
    const snapshot = simSnapshot;
    playbackStartRef.current = performance.now() - playbackElapsedRef.current * 1000;

    function frame(now: number) {
      const elapsed = Math.min(snapshot.result.lapTime, (now - playbackStartRef.current) / 1000);
      playbackElapsedRef.current = elapsed;
      setPlaybackElapsed(elapsed);
      if (elapsed >= snapshot.result.lapTime) {
        setIsPlaying(false);
        rafRef.current = null;
        return;
      }
      rafRef.current = requestAnimationFrame(frame);
    }

    rafRef.current = requestAnimationFrame(frame);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [isPlaying, simSnapshot]);

  async function runSim() {
    if (trackPoints.length < 2) return;
    const { simulateGripTargetHotLap, simulateHotLap } = await import("./integrator.js");
    const r = simMode === "grip" ? simulateGripTargetHotLap(vehicle, trackPoints) : simulateHotLap(vehicle, trackPoints, hw, driftTolerance);
    const lineSamples = useOptLine ? racingLine.map(s => ({ ...s })) : centreSamples.map(s => ({ x: s.x, y: s.y, distance: s.distance, radius: s.radius, tangentAngle: s.tangentAngle }));
    setSnapshot({
      result: r,
      lineSamples,
      trackPoints: trackPoints.map(p => ({ ...p })),
      source: useOptLine ? "opt" : "centre",
    });
  }

  function handleImageFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      setBgImageUrl(ev.target?.result as string);
      const pts = [...centreSamples.map(s => ({ x: s.x, y: s.y })), ...committedSections.map(s => ({ x: s.x, y: s.y }))];
      if (pts.length > 0) {
        const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minY = Math.min(...ys), maxY = Math.max(...ys);
        const pad = Math.max((maxX - minX) * 0.15, (maxY - minY) * 0.15, 30);
        setImageRect({ x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad });
      }
    };
    reader.readAsDataURL(file);
  }

  const handleBestOffsets = useCallback(async (offsets: Offsets) => {
    const nextOffsets = new Float64Array(offsets);
    setOptOffsets(nextOffsets);
    setUseOptLine(true);
    const nextLine = racingLineFromOffsets(nextOffsets, hw, centreSamples);
    const nextTrackPoints = nextLine.map((s, i) => ({ distance: s.distance, radius: s.radius, x: s.x, y: s.y, tangentAngle: s.tangentAngle, halfWidth: hw[i] }));
    const { simulateGripTargetHotLap, simulateHotLap } = await import("./integrator.js");
    const nextResult = simMode === "grip" ? simulateGripTargetHotLap(vehicle, nextTrackPoints) : simulateHotLap(vehicle, nextTrackPoints, hw, driftTolerance);
    setSnapshot({
      result: nextResult,
      lineSamples: nextLine.map(s => ({ ...s })),
      trackPoints: nextTrackPoints.map(p => ({ ...p })),
      source: "opt",
    });
  }, [centreSamples, hw, vehicle, simMode, driftTolerance, setSnapshot]);

  const handleDragSections   = useCallback((s: CrossSection[]) => setDisplaySections(s), []);
  const handleVehicleChange = useCallback((next: VehicleParams) => {
    setVehicle(next);
    setResult(null);
    setSimSnapshot(null);
    resetPlayback();
  }, [resetPlayback]);
  const handleCommitSections = useCallback((s: CrossSection[]) => {
    setDisplaySections(s); setCommittedSections(s); setOptOffsets(null); setUseOptLine(false); setResult(null); setSimSnapshot(null); resetPlayback();
  }, [resetPlayback]);

  const handleLineReset = useCallback(() => {
    setOptOffsets(null);
    setUseOptLine(false);
    setResult(null);
    setSimSnapshot(null);
    resetPlayback();
  }, [resetPlayback]);

  const handleSimModeChange = useCallback((mode: SimMode) => {
    setSimMode(mode);
    setPathDisplay(mode === "slide" ? "both" : "intended");
    setResult(null);
    setSimSnapshot(null);
    resetPlayback();
  }, [resetPlayback]);

  const handleDistanceCalib = useCallback((knownMetres: number) => {
    const currentLen = trackPoints[trackPoints.length - 1]?.distance;
    if (!currentLen || currentLen <= 0) return;
    const scale = knownMetres / currentLen;
    const xs = committedSections.map(s => s.x), ys = committedSections.map(s => s.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const scaled = committedSections.map(s => ({ ...s, x: cx + (s.x - cx) * scale, y: cy + (s.y - cy) * scale }));
    handleCommitSections(scaled);
    if (imageRect) setImageRect({ x: cx + (imageRect.x - cx) * scale, y: cy + (imageRect.y - cy) * scale, w: imageRect.w * scale, h: imageRect.h * scale });
    setCalibMode("off");
  }, [trackPoints, committedSections, imageRect, handleCommitSections]);

  const tbBtn = (active: boolean, color = "#3b82f6"): React.CSSProperties => ({
    padding: "3px 8px", background: "none", fontSize: 11, cursor: "pointer", borderRadius: 3,
    border: `1px solid ${active ? color : "#2a2a2a"}`, color: active ? color : "#555",
  });

  return (
    <div style={{ display: "flex", height: "100vh", background: "#0f0f0f", color: "#e0e0e0", fontFamily: "system-ui, sans-serif", overflow: "hidden" }}>

      {/* ── Left: Car Setup ── */}
      <aside style={{ ...colStyle, borderRight: "1px solid #1e1e1e" }}>
        <SessionHeader title="Car Setup" name={carName} onName={setCarName} />
        <VehicleForm params={vehicle} onChange={handleVehicleChange} />
        <CarIoPanel vehicle={vehicle} sessionName={carName} onImportVehicle={handleVehicleChange} />
      </aside>

      {/* ── Centre: canvas + data plots ── */}
      <main style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0, borderRight: "1px solid #1e1e1e" }}>
        <div style={{ flex: 1, minHeight: 0 }}>
          <TrackCanvas
            sections={displaySections}
            committedSegments={segments}
            committedCentreSamples={centreSamples}
            racingLine={racingLine}
            useOptLine={useOptLine}
            result={simSnapshot?.result ?? result}
            vehicle={vehicle}
            pathDisplay={pathDisplay}
            playbackLine={simSnapshot?.lineSamples ?? []}
            playbackIndex={playback.index}
            playbackAlpha={playback.alpha}
            playbackActive={playbackActive}
            selectedId={selectedId}
            onDrag={handleDragSections}
            onCommit={handleCommitSections}
            onSelect={setSelectedId}
            hw={hw}
            optOffsets={optOffsets}
            onOffsetChange={handleBestOffsets}
            bgImageUrl={bgImageUrl}
            bgOpacity={bgOpacity}
            imageRect={imageRect}
            onImageRect={setImageRect}
            calibMode={calibMode}
            onCalibModeOff={() => setCalibMode("off")}
            trackLength={trackPoints[trackPoints.length - 1]?.distance ?? 0}
            onDistanceCalib={handleDistanceCalib}
            showGrid={showGrid}
            gridSize={gridSize}
            editLineMode={editLineMode}
            handleStride={handleStride}
            gaussianWidth={gaussianWidth}
            trackLocked={trackLocked}
          />
        </div>
        {result && (
          <div style={{ height: 220, borderTop: "1px solid #1e1e1e", flexShrink: 0 }}>
            <Suspense fallback={null}>
              <Results result={simSnapshot?.result ?? result} trackPoints={simSnapshot?.trackPoints ?? trackPoints} playbackIndex={playback.index} />
            </Suspense>
          </div>
        )}
      </main>

      {/* ── Right: Track & Optimisation ── */}
      <aside style={{ ...colStyle, borderLeft: "1px solid #1e1e1e" }}>
        <SessionHeader title="Track & Opt" name={trackName} onName={setTrackName} />

        {/* canvas toolbar */}
        <div style={{ padding: "8px 14px", borderBottom: "1px solid #1e1e1e", display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" }}>
          <button
            onClick={() => setTrackLocked(v => !v)}
            style={{
              padding: "5px 12px", border: `2px solid ${trackLocked ? "#ef4444" : "#374151"}`,
              borderRadius: 4, cursor: "pointer", fontSize: 12, fontWeight: 700, letterSpacing: 0.5,
              background: trackLocked ? "#7f1d1d" : "#111", color: trackLocked ? "#fca5a5" : "#6b7280",
            }}
          >{trackLocked ? "TRACK LOCKED" : "LOCK TRACK"}</button>
          <button onClick={() => fileInputRef.current?.click()} style={tbBtn(false)}>Image</button>
          <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleImageFile} />
          {bgImageUrl && <>
            <input type="range" min={0} max={100} value={Math.round(bgOpacity * 100)}
              onChange={e => setBgOpacity(Number(e.target.value) / 100)}
              title="Opacity" style={{ width: 55, accentColor: "#3b82f6" }} />
            <button onClick={() => setCalibMode(v => v === "point" ? "off" : "point")} style={tbBtn(calibMode === "point", "#facc15")}>Cal XY</button>
          </>}
          <button onClick={() => setCalibMode(v => v === "distance" ? "off" : "distance")} style={tbBtn(calibMode === "distance", "#34d399")}>Dist</button>
          <button onClick={() => setShowGrid(v => !v)} style={tbBtn(showGrid)}>Grid</button>
          {showGrid && (
            <select value={gridSize} onChange={e => setGridSize(Number(e.target.value) as 50 | 100)}
              style={{ fontSize: 11, background: "#1a1a1a", color: "#e0e0e0", border: "1px solid #333", borderRadius: 3, padding: "2px 4px" }}>
              <option value={50}>50 m</option>
              <option value={100}>100 m</option>
            </select>
          )}
          <button onClick={() => setEditLineMode(v => !v)} style={tbBtn(editLineMode, "#a855f7")}>Edit Line</button>
          {editLineMode && <>
            <input type="range" min={1} max={20} step={1} value={handleStride}
              onChange={e => setHandleStride(Number(e.target.value))} title={`Res: ${handleStride}`}
              style={{ width: 50, accentColor: "#a855f7" }} />
            <input type="range" min={0.01} max={0.3} step={0.01} value={gaussianWidth}
              onChange={e => setGaussianWidth(Number(e.target.value))} title={`Gauss: ${(gaussianWidth * 100).toFixed(0)}%`}
              style={{ width: 50, accentColor: "#a855f7" }} />
          </>}
        </div>

        {/* sections + optimizer */}
        <SectionTable sections={committedSections} selectedId={selectedId} onChange={handleCommitSections} onSelect={setSelectedId} />
        <Suspense fallback={<div style={{ padding: "12px 16px", color: "#555", fontSize: 12 }}>Loading optimizer…</div>}>
          <OptimizerPanel
            centreSamples={centreSamples} hw={hw}
            seed={optOffsets ?? new Float64Array(centreSamples.length)}
            vehicle={vehicle} simMode={simMode} driftTolerance={driftTolerance} onBestOffsets={handleBestOffsets}
            playbackActive={isPlaying}
            onLineReset={handleLineReset}
          />
        </Suspense>
        <TrackIoPanel
          sections={committedSections} racingLineOffsets={optOffsets}
          centreSamples={centreSamples} sessionName={trackName}
          onImportTrack={handleCommitSections} onImportRacingLine={handleBestOffsets}
        />

        {/* run + lap time */}
        <div style={{ padding: "12px 14px", marginTop: "auto", borderTop: "1px solid #1e1e1e" }}>
          {hasInvalid && <div style={{ color: "#ef4444", fontSize: 11, marginBottom: 6 }}>Invalid segments (shown in red).</div>}
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            {(["grip", "slide"] as SimMode[]).map(mode => (
              <button key={mode} onClick={() => handleSimModeChange(mode)} style={{
                flex: 1, padding: "5px 0", background: "none", border: `1px solid ${simMode === mode ? "#f59e0b" : "#333"}`,
                color: simMode === mode ? "#fbbf24" : "#666", borderRadius: 4, cursor: "pointer", fontSize: 11,
              }}>{mode === "grip" ? "Grip target" : "Slide / off-track"}</button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            {(["intended", "drifted", "both"] as PathDisplay[]).map(mode => (
              <button key={mode} onClick={() => setPathDisplay(mode)} disabled={simMode === "grip" && mode !== "intended"} style={{
                flex: 1, padding: "4px 0", background: "none", border: `1px solid ${pathDisplay === mode ? "#22c55e" : "#333"}`,
                color: pathDisplay === mode ? "#86efac" : simMode === "grip" && mode !== "intended" ? "#333" : "#666",
                borderRadius: 4, cursor: simMode === "grip" && mode !== "intended" ? "not-allowed" : "pointer", fontSize: 10,
              }}>{mode === "intended" ? "Intended" : mode === "drifted" ? "Drifted" : "Both"}</button>
            ))}
          </div>
          {simMode === "slide" && (
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8, fontSize: 10, color: "#777" }}>
              <span style={{ width: 70 }}>Drift tol</span>
              <input type="range" min={0.02} max={0.6} step={0.01} value={driftTolerance}
                onChange={e => setDriftTolerance(Number(e.target.value))}
                style={{ flex: 1, accentColor: "#facc15" }} />
              <span style={{ width: 42, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{Math.round(driftTolerance * 100)}%</span>
            </div>
          )}
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button onClick={runSim} disabled={hasInvalid || trackPoints.length < 2} style={{
              flex: 1, padding: "8px 0", background: hasInvalid ? "#1a1a1a" : "#1d4ed8",
              color: hasInvalid ? "#555" : "#fff", border: "none", borderRadius: 5,
              cursor: hasInvalid ? "not-allowed" : "pointer", fontSize: 12, fontWeight: 700, letterSpacing: 1,
            }}>RUN SIM</button>
            <button onClick={() => setUseOptLine(v => !v)} disabled={!optOffsets} style={{
              flex: 1, padding: "8px 0", background: "none",
              border: `1px solid ${useOptLine ? "#3b82f6" : "#333"}`,
              color: optOffsets ? (useOptLine ? "#60a5fa" : "#777") : "#333",
              borderRadius: 5, cursor: optOffsets ? "pointer" : "not-allowed", fontSize: 11,
            }}>{useOptLine ? "Opt line ✓" : "Centre line"}</button>
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <button
              onClick={() => {
                if (!simSnapshot) return;
                if (playbackElapsed >= simSnapshot.result.lapTime) {
                  playbackElapsedRef.current = 0;
                  setPlaybackElapsed(0);
                }
                setIsPlaying(v => !v);
              }}
              disabled={!simSnapshot || hasInvalid}
              style={{
                flex: 1, padding: "7px 0", background: isPlaying ? "#7f1d1d" : "#14532d",
                color: !simSnapshot || hasInvalid ? "#444" : isPlaying ? "#fca5a5" : "#86efac",
                border: "none", borderRadius: 5, cursor: !simSnapshot || hasInvalid ? "not-allowed" : "pointer",
                fontSize: 12, fontWeight: 700, letterSpacing: 1,
              }}
            >{isPlaying ? "PAUSE" : "PLAY"}</button>
            <button onClick={resetPlayback} disabled={!simSnapshot} style={{
              padding: "7px 12px", border: "1px solid #333", borderRadius: 5,
              cursor: simSnapshot ? "pointer" : "not-allowed", background: "none", color: simSnapshot ? "#888" : "#333", fontSize: 12,
            }}>RESTART</button>
          </div>
          {result && (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                <span style={{ fontSize: 24, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: "#60a5fa" }}>
                  {formatLapTime((simSnapshot?.result ?? result).lapTime)}
                </span>
                <span style={{ fontSize: 11, color: "#555", fontVariantNumeric: "tabular-nums" }}>
                  {(() => { const pts = simSnapshot?.trackPoints ?? trackPoints; return (((pts[pts.length - 1]?.distance ?? 0) / 1000).toFixed(3)); })()} km
                </span>
              </div>
              {simSnapshot && <div style={{ fontSize: 10, color: "#555", letterSpacing: 0.8, textTransform: "uppercase" }}>
                Result: {simSnapshot.source === "opt" ? "optimized line" : "centre line"} · {formatLapTime(playbackElapsed)}
              </div>}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
