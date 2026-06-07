import { useRef, useState } from "react";
import {
  initPopulation, runGeneration,
  initAnnealing, runAnnealingStep,
  runGeometricPass, runLengthPass, runSmoothenStep, fitness,
} from "../optimizer.js";
import type { Offsets, AnnealState } from "../optimizer.js";
import type { CentreSample } from "../geometry.js";
import type { VehicleParams } from "../vehicle.js";

type Model = "geometric" | "genetic" | "annealing";

interface Props {
  centreSamples: CentreSample[];
  hw: Float64Array;
  seed: Offsets;
  vehicle: VehicleParams;
  onBestOffsets: (offsets: Offsets, lapTime: number) => void;
  onLineReset: () => void;
}

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(3).padStart(6, "0");
  return m > 0 ? `${m}:${s}` : `${t.toFixed(3)}s`;
}

export function OptimizerPanel({ centreSamples, hw, seed, vehicle, onBestOffsets, onLineReset }: Props) {
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
  const bestTimeRef = useRef<number>(Infinity);

  const rafRef       = useRef<number | null>(null);
  const smoothRafRef = useRef<number | null>(null);
  const genState  = useRef<{ pop: ReturnType<typeof initPopulation>; gen: number; best: number } | null>(null);
  const annState  = useRef<AnnealState | null>(null);
  const bestRef   = useRef<Offsets>(seed);
  const seedRef   = useRef<Offsets>(seed);
  const smoothSigmaRef = useRef(smoothSigma);
  smoothSigmaRef.current = smoothSigma;
  // always track latest seed so reset/start can pick it up
  seedRef.current = seed;

  function arrays() {
    const n = centreSamples.length;
    const xs = new Float64Array(n), ys = new Float64Array(n), tg = new Float64Array(n);
    for (let i = 0; i < n; i++) { xs[i] = centreSamples[i].x; ys[i] = centreSamples[i].y; tg[i] = centreSamples[i].tangentAngle; }
    return { xs, ys, tg };
  }

  function start() {
    if (running) return;
    // always re-seed from the latest external line (picks up manual edits)
    bestRef.current = new Float64Array(seedRef.current);
    bestTimeRef.current = Infinity;

    const { xs, ys, tg } = arrays();
    const cur = bestRef.current;

    const seedTime = fitness(cur, vehicle, hw, xs, ys, tg);
    if (Number.isFinite(seedTime)) {
      bestTimeRef.current = seedTime;
      setBestTime(seedTime);
    }

    if (model === "genetic") {
      genState.current = { pop: initPopulation(cur, popSize, sigma), gen: 0, best: bestTimeRef.current };
    } else if (model === "annealing") {
      annState.current = initAnnealing(cur, vehicle, hw, xs, ys, tg, tempStart);
    }

    setRunning(true);

    let tickCount = 0;
    function tick() {
      const { xs, ys, tg } = arrays();
      tickCount++;

      if (model === "genetic" && genState.current) {
        const { population, best, bestLapTime } = runGeneration(genState.current.pop, vehicle, hw, xs, ys, tg, sigma);
        genState.current.pop = population;
        genState.current.gen += 1;
        if (bestLapTime < genState.current.best) {
          genState.current.best = bestLapTime;
          bestRef.current = best;
          bestTimeRef.current = bestLapTime;
          onBestOffsets(best, bestLapTime);
          setBestTime(bestLapTime);
        }
        setGen(g => g + 1);
      } else if (model === "annealing" && annState.current) {
        annState.current = runAnnealingStep(annState.current, vehicle, hw, xs, ys, tg, sigma, cooling);
        const { best, bestFitness } = annState.current;
        if (bestFitness < bestTimeRef.current) {
          bestTimeRef.current = bestFitness;
          bestRef.current = best;
          onBestOffsets(best, bestFitness);
          setBestTime(bestFitness);
        }
        setGen(g => g + 1);
      } else if (model === "geometric") {
        const n = centreSamples.length;
        const signedK = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          const prev = centreSamples[(i - 1 + n) % n], next = centreSamples[(i + 1) % n];
          let da = next.tangentAngle - prev.tangentAngle;
          while (da >  Math.PI) da -= 2 * Math.PI;
          while (da < -Math.PI) da += 2 * Math.PI;
          signedK[i] = da / (next.distance - prev.distance || 0.01);
        }
        // Every 20 ticks do a "wide" search: pure template from zeroed offsets.
        // Other ticks: 6 candidates with varying perturbation, keep best.
        const N_CANDIDATES = 6;
        const wideSearch = tickCount % 20 === 0;
        const base = wideSearch ? new Float64Array(n) : bestRef.current;
        let bestCandidate: Float64Array | null = null;
        let bestCandTime = bestTimeRef.current;
        for (let k = 0; k < N_CANDIDATES; k++) {
          const perturb = wideSearch ? 0 : 0.02 + k * 0.025; // 0.02..0.145
          const raw = runGeometricPass(base, vehicle, hw, xs, ys, tg, signedK, perturb);
          const cand = runLengthPass(raw, signedK);
          const t = fitness(cand, vehicle, hw, xs, ys, tg);
          if (Number.isFinite(t) && t < bestCandTime) { bestCandTime = t; bestCandidate = cand; }
        }
        if (bestCandidate !== null) {
          bestTimeRef.current = bestCandTime;
          bestRef.current = bestCandidate;
          setBestTime(bestCandTime);
          onBestOffsets(bestRef.current, bestTimeRef.current);
        }
        setGen(g => g + 1);
      }

      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
  }

  function stop() {
    if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    setRunning(false);
  }

  function reset() {
    stop();
    stopSmoothen();
    genState.current = null;
    annState.current = null;
    // re-seed from the current displayed line (picks up manual edits)
    bestRef.current = new Float64Array(seedRef.current);
    bestTimeRef.current = Infinity;
    setGen(0); setSmoothTrials(0); setBestTime(null);
  }

  function lineReset() {
    stop();
    stopSmoothen();
    genState.current = null;
    annState.current = null;
    bestRef.current = new Float64Array(seed.length); // zero = centre line
    bestTimeRef.current = Infinity;
    setGen(0); setSmoothTrials(0); setBestTime(null);
    onLineReset();
  }

  function switchModel(m: Model) {
    stop();
    setModel(m);
    setGen(0);
  }

  function startSmoothen() {
    if (smoothRunning) return;
    setSmoothRunning(true);

    function tick() {
      const { xs, ys, tg } = arrays();
      const improved = runSmoothenStep(bestRef.current, vehicle, hw, xs, ys, tg, smoothSigmaRef.current);
      if (improved !== null) {
        const newTime = fitness(improved, vehicle, hw, xs, ys, tg);
        bestRef.current = improved;
        bestTimeRef.current = newTime;
        setBestTime(newTime);
        onBestOffsets(improved, newTime);
      }
      setSmoothTrials(t => t + 1);
      smoothRafRef.current = requestAnimationFrame(tick);
    }

    smoothRafRef.current = requestAnimationFrame(tick);
  }

  function stopSmoothen() {
    if (smoothRafRef.current !== null) { cancelAnimationFrame(smoothRafRef.current); smoothRafRef.current = null; }
    setSmoothRunning(false);
  }

  return (
    <div style={{ padding: "12px 16px", borderBottom: "1px solid #222" }}>
      <div style={hdr}>Optimizer</div>

      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        {(["geometric", "genetic", "annealing"] as Model[]).map(m => (
          <button key={m} onClick={() => switchModel(m)} style={{
            flex: 1, padding: "5px 0", border: `1px solid ${model === m ? "#3b82f6" : "#333"}`,
            background: "none", color: model === m ? "#60a5fa" : "#555",
            borderRadius: 4, cursor: "pointer", fontSize: 11, letterSpacing: 0.5,
          }}>
            {m === "geometric" ? "Geometric" : m === "genetic" ? "Genetic" : "Annealing"}
          </button>
        ))}
      </div>

      {model !== "geometric" && (
        <Row label="Mutation σ">
          <input type="number" value={sigma} min={0.01} max={0.5} step={0.01}
            onChange={e => setSigma(parseFloat(e.target.value) || 0.08)} disabled={running} style={numIn} />
        </Row>
      )}

      {model === "genetic" && (
        <Row label="Population">
          <input type="number" value={popSize} min={4} max={100} step={2}
            onChange={e => setPopSize(parseInt(e.target.value) || 20)} disabled={running} style={numIn} />
        </Row>
      )}
      {model === "annealing" && (<>
        <Row label="Temp start">
          <input type="number" value={tempStart} min={0.01} max={10} step={0.1}
            onChange={e => setTempStart(parseFloat(e.target.value) || 0.5)} disabled={running} style={numIn} />
        </Row>
        <Row label="Cooling">
          <input type="number" value={cooling} min={0.9} max={0.9999} step={0.001}
            onChange={e => setCooling(parseFloat(e.target.value) || 0.999)} disabled={running} style={numIn} />
        </Row>
      </>)}

      <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
        <button onClick={running ? stop : start} style={{
          flex: 1, padding: "7px 0", border: "none", borderRadius: 4, cursor: "pointer",
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
        <span style={{ color: "#555" }}>
          {model === "annealing" && annState.current ? `T=${annState.current.temp.toFixed(4)}  ` : ""}
          Gen {gen}
        </span>
        {bestTime !== null && <span style={{ color: "#4ade80", fontVariantNumeric: "tabular-nums" }}>{fmt(bestTime)}</span>}
      </div>

      {/* smoothen */}
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid #1e1e1e" }}>
        <Row label="Smooth σ">
          <input type="range" min={0.01} max={0.2} step={0.005} value={smoothSigma}
            onChange={e => setSmoothSigma(parseFloat(e.target.value))}
            style={{ width: 80, accentColor: "#a855f7" }} />
          <span style={{ fontSize: 11, color: "#888", width: 34, textAlign: "right" }}>{smoothSigma.toFixed(3)}</span>
        </Row>
        <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
          <button onClick={smoothRunning ? stopSmoothen : startSmoothen} style={{
            flex: 1, padding: "5px 0", border: `1px solid ${smoothRunning ? "#6d28d9" : "#7c3aed"}`,
            background: smoothRunning ? "#2e1065" : "none", color: smoothRunning ? "#c4b5fd" : "#a855f7",
            borderRadius: 4, cursor: "pointer", fontSize: 11, fontWeight: 600, letterSpacing: 0.5,
          }}>{smoothRunning ? "STOP" : "SMOOTHEN"}</button>
        </div>
        <div style={{ marginTop: 6, fontSize: 11, color: "#555" }}>
          Trials {smoothTrials}
        </div>
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
