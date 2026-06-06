import { useState, useMemo, useCallback, useRef } from "react";
import { SectionTable } from "./components/SectionTable.tsx";
import { VehicleForm } from "./components/VehicleForm.tsx";
import { Results } from "./components/Results.tsx";
import { TrackCanvas } from "./components/TrackCanvas.tsx";
import { CarIoPanel, TrackIoPanel } from "./components/IoPanel.tsx";
import { OptimizerPanel } from "./components/OptimizerPanel.tsx";
import {
  buildBezierSegments,
  sampleCentreLine,
  centreSamplesToTrackPoints,
  computeHalfWidths,
} from "./geometry.js";
import { simulateHotLap } from "./integrator.js";
import { offsetsToTrackPoints } from "./optimizer.js";
import type { CrossSection, RacingLineSample } from "./geometry.js";
import type { VehicleParams } from "./vehicle.js";
import type { SimResult } from "./integrator.js";
import type { Offsets } from "./optimizer.js";

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
  powerCurve: [
    { x: 2000, y: 300 }, { x: 4000, y: 380 }, { x: 6000, y: 420 },
    { x: 8000, y: 400 }, { x: 10000, y: 340 }, { x: 12000, y: 250 },
  ],
};

function formatLapTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(3).padStart(6, "0");
  return m > 0 ? `${m}:${s}` : `${t.toFixed(3)}s`;
}

function offsetsToRacingLine(
  offsets: Offsets, hw: Float64Array,
  samples: { x: number; y: number; tangentAngle: number }[],
): RacingLineSample[] {
  const n = offsets.length;
  const xs = new Float64Array(n), ys = new Float64Array(n), tg = new Float64Array(n);
  for (let i = 0; i < n; i++) { xs[i] = samples[i].x; ys[i] = samples[i].y; tg[i] = samples[i].tangentAngle; }
  const pts = offsetsToTrackPoints(offsets, hw, xs, ys, tg);
  return pts.map((tp, i) => {
    const p = tp as typeof tp & { _x: number; _y: number };
    return { x: p._x ?? samples[i].x, y: p._y ?? samples[i].y, distance: tp.distance, radius: tp.radius };
  });
}

// ── shared style tokens ───────────────────────────────────────────────────────

const COL_W = 280;
const colStyle: React.CSSProperties = {
  width: COL_W, flexShrink: 0, display: "flex", flexDirection: "column",
  borderRight: "1px solid #1e1e1e", overflowY: "auto",
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [useOptLine, setUseOptLine] = useState(false);
  const [optOffsets, setOptOffsets] = useState<Offsets | null>(null);
  const [carName,    setCarName]    = useState("");
  const [trackName,  setTrackName]  = useState("");
  const [showResults, setShowResults] = useState(false);

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

  const segments      = useMemo(() => buildBezierSegments(committedSections, true), [committedSections]);
  const centreSamples = useMemo(() => sampleCentreLine(segments), [segments]);
  const hw            = useMemo(() => computeHalfWidths(centreSamples, committedSections, segments), [centreSamples, committedSections, segments]);

  const racingLine = useMemo((): RacingLineSample[] => {
    if (optOffsets && optOffsets.length === centreSamples.length)
      return offsetsToRacingLine(optOffsets, hw, centreSamples);
    return centreSamples.map(s => ({ x: s.x, y: s.y, distance: s.distance, radius: s.radius }));
  }, [optOffsets, hw, centreSamples]);

  const trackPoints = useMemo(
    () => useOptLine
      ? racingLine.map(s => ({ distance: s.distance, radius: s.radius }))
      : centreSamplesToTrackPoints(centreSamples),
    [useOptLine, racingLine, centreSamples],
  );

  const hasInvalid = segments.some(s => s.invalid);

  function runSim() {
    if (trackPoints.length < 2) return;
    const r = simulateHotLap(vehicle, trackPoints);
    setResult(r);
    setShowResults(true);
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

  const handleBestOffsets = useCallback((offsets: Offsets, lapTime?: number) => {
    setOptOffsets(new Float64Array(offsets));
    setUseOptLine(true);
    if (lapTime !== undefined) setResult(prev => prev ? { ...prev, lapTime } : null);
  }, []);

  const handleDragSections   = useCallback((s: CrossSection[]) => setDisplaySections(s), []);
  const handleCommitSections = useCallback((s: CrossSection[]) => {
    setDisplaySections(s); setCommittedSections(s); setOptOffsets(null); setUseOptLine(false);
  }, []);

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

      {/* ── Left column: Car Setup ── */}
      <aside style={colStyle}>
        <SessionHeader title="Car Setup" name={carName} onName={setCarName} />
        <VehicleForm params={vehicle} onChange={setVehicle} />
        <CarIoPanel vehicle={vehicle} sessionName={carName} onImportVehicle={setVehicle} />
      </aside>

      {/* ── Right column: Track & Optimisation ── */}
      <aside style={colStyle}>
        <SessionHeader title="Track & Opt" name={trackName} onName={setTrackName} />

        {/* canvas toolbar */}
        <div style={{ padding: "8px 14px", borderBottom: "1px solid #1e1e1e", display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" }}>
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
        <OptimizerPanel
          centreSamples={centreSamples} hw={hw}
          seed={optOffsets ?? new Float64Array(centreSamples.length)}
          vehicle={vehicle} onBestOffsets={handleBestOffsets}
        />
        <TrackIoPanel
          sections={committedSections} racingLineOffsets={optOffsets}
          centreSamples={centreSamples} sessionName={trackName}
          onImportTrack={handleCommitSections} onImportRacingLine={handleBestOffsets}
        />

        {/* run + lap time */}
        <div style={{ padding: "12px 14px", borderBottom: "1px solid #1e1e1e" }}>
          {hasInvalid && <div style={{ color: "#ef4444", fontSize: 11, marginBottom: 6 }}>Invalid segments (shown in red).</div>}
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
          {result && (
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginTop: 8 }}>
              <span style={{ fontSize: 24, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: "#60a5fa" }}>
                {formatLapTime(result.lapTime)}
              </span>
              <span style={{ fontSize: 11, color: "#555", fontVariantNumeric: "tabular-nums" }}>
                {(trackPoints[trackPoints.length - 1]?.distance / 1000).toFixed(3)} km
              </span>
            </div>
          )}
        </div>

        {/* results charts — collapsible */}
        {result && (
          <div style={{ borderBottom: "1px solid #1e1e1e" }}>
            <button onClick={() => setShowResults(v => !v)} style={{
              width: "100%", background: "none", border: "none", color: "#555",
              fontSize: 10, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase",
              cursor: "pointer", padding: "7px 14px", textAlign: "left", display: "flex",
              justifyContent: "space-between",
            }}>
              Data plots <span>{showResults ? "▲" : "▼"}</span>
            </button>
            {showResults && (
              <div style={{ height: 260 }}>
                <Results result={result} />
              </div>
            )}
          </div>
        )}
      </aside>

      {/* ── Canvas ── */}
      <main style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        <TrackCanvas
          sections={displaySections}
          committedSegments={segments}
          committedCentreSamples={centreSamples}
          racingLine={racingLine}
          useOptLine={useOptLine}
          result={result}
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
        />
      </main>
    </div>
  );
}
