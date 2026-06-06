import { useState, useMemo, useCallback, useRef } from "react";
import { SectionTable } from "./components/SectionTable.tsx";
import { VehicleForm } from "./components/VehicleForm.tsx";
import { Results } from "./components/Results.tsx";
import { TrackCanvas } from "./components/TrackCanvas.tsx";
import { IoPanel } from "./components/IoPanel.tsx";
import { OptimizerPanel } from "./components/OptimizerPanel.tsx";
import {
  buildBezierSegments,
  sampleCentreLine,
  centreSamplesToTrackPoints,
  computeHalfWidths,
} from "./geometry.js";
import { simulate } from "./integrator.js";
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
  mass: 700, peakPower: 450_000, dragArea: 0.9,
  liftArea: 3.0, muLat: 1.8, muLon: 1.8,
};

function formatLapTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(3).padStart(6, "0");
  return m > 0 ? `${m}:${s}` : `${t.toFixed(3)}s`;
}

function offsetsToRacingLine(
  offsets: Offsets,
  hw: Float64Array,
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

export default function App() {
  const [committedSections, setCommittedSections] = useState<CrossSection[]>(DEFAULT_SECTIONS);
  const [displaySections, setDisplaySections] = useState<CrossSection[]>(DEFAULT_SECTIONS);
  const [vehicle, setVehicle] = useState<VehicleParams>(DEFAULT_VEHICLE);
  const [result, setResult] = useState<SimResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [useOptLine, setUseOptLine] = useState(false);
  const [optOffsets, setOptOffsets] = useState<Offsets | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [bgImageUrl, setBgImageUrl] = useState<string | null>(null);
  const [bgOpacity, setBgOpacity] = useState(1);
  const [imageRect, setImageRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [calibMode, setCalibMode] = useState(false);
  const [showGrid, setShowGrid] = useState(false);
  const [gridSize, setGridSize] = useState<50 | 100>(50);
  const [editLineMode, setEditLineMode] = useState(false);

  // committed chain — cheap, runs on pointerup only
  const segments = useMemo(() => buildBezierSegments(committedSections, true), [committedSections]);
  const centreSamples = useMemo(() => sampleCentreLine(segments), [segments]);
  const hw = useMemo(() => computeHalfWidths(centreSamples, committedSections, segments), [centreSamples, committedSections, segments]);

  // racing line — only when optOffsets are present (set by optimizer panel)
  const racingLine = useMemo((): RacingLineSample[] => {
    if (optOffsets && optOffsets.length === centreSamples.length) {
      return offsetsToRacingLine(optOffsets, hw, centreSamples);
    }
    // fall back to centre line as racing line so canvas always has something to show
    return centreSamples.map(s => ({ x: s.x, y: s.y, distance: s.distance, radius: s.radius }));
  }, [optOffsets, hw, centreSamples]);

  const trackPoints = useMemo(
    () => useOptLine
      ? racingLine.map(s => ({ distance: s.distance, radius: s.radius }))
      : centreSamplesToTrackPoints(centreSamples),
    [useOptLine, racingLine, centreSamples]
  );

  const hasInvalid = segments.some(s => s.invalid);

  function runSim() {
    if (trackPoints.length < 2) return;
    setResult(simulate(vehicle, trackPoints));
  }

  function handleImageFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
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

  const handleDragSections = useCallback((s: CrossSection[]) => {
    setDisplaySections(s);
  }, []);

  const handleCommitSections = useCallback((s: CrossSection[]) => {
    setDisplaySections(s);
    setCommittedSections(s);
    setOptOffsets(null);
    setUseOptLine(false);
  }, []);

  return (
    <div style={{ display: "flex", height: "100vh", background: "#0f0f0f", color: "#e0e0e0", fontFamily: "system-ui, sans-serif", overflow: "hidden" }}>
      <aside style={{ width: 300, display: "flex", flexDirection: "column", borderRight: "1px solid #1e1e1e", overflowY: "auto", flexShrink: 0 }}>
        <div style={{ padding: "16px 16px 8px", borderBottom: "1px solid #1e1e1e" }}>
          <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 2, color: "#e0e0e0", textTransform: "uppercase" }}>Lap Simulator</div>
          <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>Quasi-static G-G model</div>
        </div>
        <SectionTable sections={committedSections} selectedId={selectedId} onChange={handleCommitSections} onSelect={setSelectedId} />
        <VehicleForm params={vehicle} onChange={setVehicle} />
        <IoPanel
          sections={committedSections}
          vehicle={vehicle}
          onImportTrack={s => handleCommitSections(s)}
          onImportVehicle={setVehicle}
        />
        <OptimizerPanel
          centreSamples={centreSamples}
          hw={hw}
          seed={optOffsets ?? new Float64Array(centreSamples.length)}
          vehicle={vehicle}
          onBestOffsets={handleBestOffsets}
        />
        <div style={{ padding: 16, marginTop: "auto" }}>
          {hasInvalid && (
            <div style={{ color: "#ef4444", fontSize: 12, marginBottom: 8 }}>
              Warning: one or more segments are invalid (shown in red).
            </div>
          )}
          <button
            onClick={runSim}
            disabled={hasInvalid || trackPoints.length < 2}
            style={{
              width: "100%", padding: "10px 0", background: hasInvalid ? "#1a1a1a" : "#1d4ed8",
              color: hasInvalid ? "#555" : "#fff", border: "none", borderRadius: 6,
              cursor: hasInvalid ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 600, letterSpacing: 1,
            }}
          >RUN SIMULATION</button>
          <button
            onClick={() => setUseOptLine(v => !v)}
            disabled={!optOffsets}
            style={{
              width: "100%", marginTop: 8, padding: "7px 0",
              background: "none", border: `1px solid ${useOptLine ? "#3b82f6" : "#333"}`,
              color: optOffsets ? (useOptLine ? "#60a5fa" : "#888") : "#333", borderRadius: 6,
              cursor: optOffsets ? "pointer" : "not-allowed", fontSize: 11, letterSpacing: 1,
            }}
          >{useOptLine ? "OPTIMISED LINE ✓" : "CENTRE LINE"}</button>
          {result && (
            <div style={{ textAlign: "center", marginTop: 10, fontSize: 22, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: "#60a5fa" }}>
              {formatLapTime(result.lapTime)}
            </div>
          )}
        </div>
      </aside>

      <main style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
        <div style={{ position: "absolute", top: 8, left: 8, zIndex: 10, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={() => fileInputRef.current?.click()} style={{ padding: "4px 8px", background: "#1e1e1e", color: "#e0e0e0", border: "1px solid #333", borderRadius: 4, cursor: "pointer", fontSize: 11 }}>
            Import Image
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleImageFile} />
          {bgImageUrl && <>
            <input type="range" min={0} max={100} value={Math.round(bgOpacity * 100)}
              onChange={e => setBgOpacity(Number(e.target.value) / 100)}
              title="Image opacity" style={{ width: 70, accentColor: "#3b82f6" }} />
            <button
              onClick={() => setCalibMode(v => !v)}
              style={{ padding: "4px 8px", background: "none", border: `1px solid ${calibMode ? "#facc15" : "#333"}`, color: calibMode ? "#facc15" : "#888", borderRadius: 4, cursor: "pointer", fontSize: 11 }}
            >Calibrate</button>
          </>}
          <button
            onClick={() => setShowGrid(v => !v)}
            style={{ padding: "4px 8px", background: "none", border: `1px solid ${showGrid ? "#3b82f6" : "#333"}`, color: showGrid ? "#60a5fa" : "#888", borderRadius: 4, cursor: "pointer", fontSize: 11 }}
          >Grid</button>
          {showGrid && (
            <select value={gridSize} onChange={e => setGridSize(Number(e.target.value) as 50 | 100)}
              style={{ fontSize: 11, background: "#1e1e1e", color: "#e0e0e0", border: "1px solid #333", borderRadius: 4, padding: "3px 4px" }}>
              <option value={50}>50 m</option>
              <option value={100}>100 m</option>
            </select>
          )}
          <button
            onClick={() => setEditLineMode(v => !v)}
            style={{ padding: "4px 8px", background: "none", border: `1px solid ${editLineMode ? "#a855f7" : "#333"}`, color: editLineMode ? "#c084fc" : "#888", borderRadius: 4, cursor: "pointer", fontSize: 11 }}
          >Edit Line</button>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
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
            showGrid={showGrid}
            gridSize={gridSize}
            editLineMode={editLineMode}
          />
        </div>
        {result && (
          <div style={{ height: 280, borderTop: "1px solid #1e1e1e", overflowX: "auto", flexShrink: 0 }}>
            <Results result={result} />
          </div>
        )}
      </main>
    </div>
  );
}
