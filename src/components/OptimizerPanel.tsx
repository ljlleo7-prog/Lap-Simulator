import { useEffect, useRef, useState } from "react";
import type { Offsets, SimMode } from "../optimizer.js";
import type { CentreSample } from "../geometry.js";
import type { VehicleParams } from "../vehicle.js";

type Model = "geometric" | "genetic" | "annealing";
type Mode = "optimize" | "smoothen";

interface Props {
  centreSamples: CentreSample[];
  hw: Float64Array;
  seed: Offsets;
  vehicle: VehicleParams;
  simMode: SimMode;
  driftTolerance: number;
  playbackActive: boolean;
  onBestOffsets: (offsets: Offsets, lapTime: number) => void;
  onLineReset: () => void;
}

interface ProgressMessage {
  type: "progress";
  trials: number;
  bestTime: number;
  batchDone: number;
  batchSize: number;
  bestOffsets?: Float64Array;
}

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(3).padStart(6, "0");
  return m > 0 ? `${m}:${s}` : `${t.toFixed(3)}s`;
}

export function OptimizerPanel({ centreSamples, hw, seed, vehicle, simMode, driftTolerance, playbackActive, onBestOffsets, onLineReset }: Props) {
  const [model, setModel] = useState<Model>("geometric");
  const [popSize, setPopSize] = useState(20);
  const [sigma, setSigma] = useState(0.08);
  const [tempStart, setTempStart] = useState(0.5);
  const [cooling, setCooling] = useState(0.999);
  const [running, setRunning] = useState(false);
  const [smoothRunning, setSmoothRunning] = useState(false);
  const [gen, setGen] = useState(0);
  const [smoothTrials, setSmoothTrials] = useState(0);
  const [bestTime, setBestTime] = useState<number | null>(null);
  const [smoothSigma, setSmoothSigma] = useState(0.04);
  const [smoothAcceptMargin, setSmoothAcceptMargin] = useState(0.05);
  const [batchSize, setBatchSize] = useState(10);
  const [batchProgress, setBatchProgress] = useState(0);
  const suspendedModeRef = useRef<Mode | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const seedRef = useRef<Offsets>(seed);
  seedRef.current = seed;

  function stopWorker() {
    workerRef.current?.terminate();
    workerRef.current = null;
    setBatchProgress(0);
  }

  function startWorker(mode: Mode) {
    stopWorker();

    const worker = new Worker(new URL("../optimizerWorker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    setBatchProgress(0);

    worker.onmessage = (event: MessageEvent<ProgressMessage>) => {
      const msg = event.data;
      if (msg.type !== "progress") return;

      if (mode === "smoothen") setSmoothTrials(msg.trials);
      else setGen(msg.trials);
      setBatchProgress(msg.batchSize > 0 ? msg.batchDone / msg.batchSize : 0);

      if (Number.isFinite(msg.bestTime)) setBestTime(msg.bestTime);
      if (msg.bestOffsets) onBestOffsets(msg.bestOffsets, msg.bestTime);
    };

    worker.postMessage({
      type: "start",
      mode,
      model,
      centreSamples,
      hw,
      seed: new Float64Array(seedRef.current),
      vehicle,
      batchSize,
      popSize,
      sigma,
      tempStart,
      cooling,
      smoothSigma,
      smoothAcceptMargin,
      simMode,
      driftTolerance,
    });
  }

  function start() {
    if (running || smoothRunning) return;
    setRunning(true);
    startWorker("optimize");
  }

  function stop() {
    stopWorker();
    setRunning(false);
  }

  function reset() {
    stop();
    stopSmoothen();
    setGen(0); setSmoothTrials(0); setBestTime(null);
  }

  function lineReset() {
    stop();
    stopSmoothen();
    setGen(0); setSmoothTrials(0); setBestTime(null);
    onLineReset();
  }

  function switchModel(m: Model) {
    stop();
    setModel(m);
    setGen(0);
  }

  function startSmoothen() {
    if (running || smoothRunning) return;
    setSmoothRunning(true);
    startWorker("smoothen");
  }

  function stopSmoothen() {
    stopWorker();
    setSmoothRunning(false);
  }

  useEffect(() => {
    if (playbackActive) {
      if (running) {
        suspendedModeRef.current = "optimize";
        stopWorker();
        setRunning(false);
      } else if (smoothRunning) {
        suspendedModeRef.current = "smoothen";
        stopWorker();
        setSmoothRunning(false);
      }
      return;
    }

    const mode = suspendedModeRef.current;
    if (!mode) return;
    suspendedModeRef.current = null;
    if (mode === "smoothen") {
      setSmoothRunning(true);
      startWorker("smoothen");
    } else {
      setRunning(true);
      startWorker("optimize");
    }
  }, [playbackActive]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ padding: "12px 16px", borderBottom: "1px solid #222" }}>
      <div style={hdr}>Optimizer</div>

      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        {(["geometric", "genetic", "annealing"] as Model[]).map(m => (
          <button key={m} onClick={() => switchModel(m)} disabled={running || smoothRunning || playbackActive} style={{
            flex: 1, padding: "5px 0", border: `1px solid ${model === m ? "#3b82f6" : "#333"}`,
            background: "none", color: model === m ? "#60a5fa" : "#555",
            borderRadius: 4, cursor: running || smoothRunning || playbackActive ? "not-allowed" : "pointer", fontSize: 11, letterSpacing: 0.5,
          }}>
            {m === "geometric" ? "Geometric" : m === "genetic" ? "Genetic" : "Annealing"}
          </button>
        ))}
      </div>

      {model !== "geometric" && (
        <Row label="Mutation σ">
          <input type="number" value={sigma} min={0.01} max={0.5} step={0.01}
            onChange={e => setSigma(parseFloat(e.target.value) || 0.08)} disabled={running || smoothRunning || playbackActive} style={numIn} />
        </Row>
      )}

      <Row label="Batch">
        <input type="number" value={batchSize} min={1} max={1000} step={1}
          onChange={e => setBatchSize(Math.max(1, Math.min(1000, parseInt(e.target.value) || 1)))}
          disabled={running || smoothRunning || playbackActive} style={numIn} />
      </Row>

      {model === "genetic" && (
        <Row label="Population">
          <input type="number" value={popSize} min={4} max={100} step={2}
            onChange={e => setPopSize(parseInt(e.target.value) || 20)} disabled={running || smoothRunning || playbackActive} style={numIn} />
        </Row>
      )}
      {model === "annealing" && (<>
        <Row label="Temp start">
          <input type="number" value={tempStart} min={0.01} max={10} step={0.1}
            onChange={e => setTempStart(parseFloat(e.target.value) || 0.5)} disabled={running || smoothRunning || playbackActive} style={numIn} />
        </Row>
        <Row label="Cooling">
          <input type="number" value={cooling} min={0.9} max={0.9999} step={0.001}
            onChange={e => setCooling(parseFloat(e.target.value) || 0.999)} disabled={running || smoothRunning || playbackActive} style={numIn} />
        </Row>
      </>)}

      <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
        <button onClick={running ? stop : start} disabled={smoothRunning} style={{
          flex: 1, padding: "7px 0", border: "none", borderRadius: 4,
          cursor: smoothRunning ? "not-allowed" : "pointer",
          background: running ? "#7f1d1d" : "#14532d", color: running ? "#fca5a5" : "#86efac",
          fontSize: 12, fontWeight: 600, letterSpacing: 1,
        }}>{running ? "STOP" : "START"}</button>
        <button onClick={reset} style={{
          padding: "7px 12px", border: "1px solid #333", borderRadius: 4,
          cursor: "pointer", background: "none", color: "#555", fontSize: 12,
        }}>RESET</button>
        <button onClick={lineReset} style={{
          padding: "7px 12px", border: "1px solid #7f1d1d", borderRadius: 4,
          cursor: "pointer", background: "none", color: "#f87171", fontSize: 12,
        }}>LINE RESET</button>
      </div>

      <div style={{ marginTop: 10, fontSize: 11, display: "flex", justifyContent: "space-between" }}>
        <span style={{ color: "#555" }}>Trials {gen}</span>
        {bestTime !== null && <span style={{ color: "#4ade80", fontVariantNumeric: "tabular-nums" }}>{fmt(bestTime)}</span>}
      </div>
      {(running || smoothRunning) && <BatchProgress value={batchProgress} />}

      <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid #1e1e1e" }}>
        <Row label="Smooth σ">
          <input type="range" min={0.01} max={0.2} step={0.005} value={smoothSigma}
            onChange={e => setSmoothSigma(parseFloat(e.target.value))}
            disabled={running || smoothRunning || playbackActive}
            style={{ width: 80, accentColor: "#a855f7" }} />
          <span style={{ fontSize: 11, color: "#888", width: 34, textAlign: "right" }}>{smoothSigma.toFixed(3)}</span>
        </Row>
        <Row label="Worse ≤ s">
          <input type="number" value={smoothAcceptMargin} min={0} max={5} step={0.01}
            onChange={e => setSmoothAcceptMargin(Math.max(0, parseFloat(e.target.value) || 0))}
            disabled={running || smoothRunning || playbackActive} style={numIn} />
        </Row>
        <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
          <button onClick={smoothRunning ? stopSmoothen : startSmoothen} disabled={running} style={{
            flex: 1, padding: "5px 0", border: `1px solid ${smoothRunning ? "#6d28d9" : "#7c3aed"}`,
            background: smoothRunning ? "#2e1065" : "none", color: smoothRunning ? "#c4b5fd" : "#a855f7",
            borderRadius: 4, cursor: running ? "not-allowed" : "pointer", fontSize: 11, fontWeight: 600, letterSpacing: 0.5,
          }}>{smoothRunning ? "STOP" : "SMOOTHEN"}</button>
        </div>
        <div style={{ marginTop: 6, fontSize: 11, color: "#555" }}>
          Trials {smoothTrials}
        </div>
      </div>
    </div>
  );
}

function BatchProgress({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#555", marginBottom: 3 }}>
        <span>Batch</span>
        <span>{Math.round(pct * 100)}%</span>
      </div>
      <div style={{ height: 5, background: "#1a1a1a", borderRadius: 999, overflow: "hidden", border: "1px solid #252525" }}>
        <div style={{ width: `${pct * 100}%`, height: "100%", background: "#3b82f6", transition: "width 80ms linear" }} />
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
      <span style={{ fontSize: 12, color: "#aaa" }}>{label}</span>
      {children}
    </div>
  );
}

const hdr: React.CSSProperties = { fontSize: 11, fontWeight: 600, letterSpacing: 1, color: "#888", textTransform: "uppercase", marginBottom: 10 };
const numIn: React.CSSProperties = { width: 70, background: "#1a1a1a", border: "1px solid #333", color: "#e0e0e0", padding: "3px 6px", borderRadius: 3, fontSize: 12 };
