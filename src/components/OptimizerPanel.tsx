import { useRef, useState } from "react";
import {
  initPopulation, runGeneration,
  initAnnealing, runAnnealingStep,
  runGradientPass, runLengthPass, runSmoothenStep, fitness,
} from "../optimizer.js";
import type { Offsets, AnnealState } from "../optimizer.js";
import type { CentreSample } from "../geometry.js";
import type { VehicleParams } from "../vehicle.js";

type Model = "gradient" | "genetic" | "annealing";

interface Props {
  centreSamples: CentreSample[];
  hw: Float64Array;
  seed: Offsets;
  vehicle: VehicleParams;
  onBestOffsets: (offsets: Offsets, lapTime: number) => void;
}

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(3).padStart(6, "0");
  return m > 0 ? `${m}:${s}` : `${t.toFixed(3)}s`;
}

export function OptimizerPanel({ centreSamples, hw, seed, vehicle, onBestOffsets }: Props) {
  const [model, setModel] = useState<Model>("genetic");
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
  const gradStep  = useRef(0.03);
  const bestRef   = useRef<Offsets>(seed);
  const smoothSigmaRef = useRef(smoothSigma);
  smoothSigmaRef.current = smoothSigma;

  function arrays() {
    const n = centreSamples.length;
    const xs = new Float64Array(n), ys = new Float64Array(n), tg = new Float64Array(n);
    for (let i = 0; i < n; i++) { xs[i] = centreSamples[i].x; ys[i] = centreSamples[i].y; tg[i] = centreSamples[i].tangentAngle; }
    return { xs, ys, tg };
  }

  function start() {
    if (running) return;
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
    } else {
      gradStep.current = 0.03;
    }

    setRunning(true);

    function tick() {
      const { xs, ys, tg } = arrays();

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
      } else if (model === "gradient") {
        const n = centreSamples.length;
        const signedK = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          const prev = centreSamples[(i - 1 + n) % n], next = centreSamples[(i + 1) % n];
          let da = next.tangentAngle - prev.tangentAngle;
          while (da >  Math.PI) da -= 2 * Math.PI;
          while (da < -Math.PI) da += 2 * Math.PI;
          signedK[i] = da / (next.distance - prev.distance || 0.01);
        }
        const candidate = runLengthPass(
          runGradientPass(bestRef.current, vehicle, hw, xs, ys, tg, gradStep.current),
          signedK,
        );
        const candidateTime = fitness(candidate, vehicle, hw, xs, ys, tg);
        if (Number.isFinite(candidateTime) && candidateTime < bestTimeRef.current) {
          bestTimeRef.current = candidateTime;
          bestRef.current = candidate;
          setBestTime(candidateTime);
          onBestOffsets(bestRef.current, bestTimeRef.current);
        }
        gradStep.current = Math.max(0.003, gradStep.current * 0.992);
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
    bestRef.current = seed;
    setGen(0); setSmoothTrials(0); setBestTime(null);
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
        {(["gradient", "genetic", "annealing"] as Model[]).map(m => (
          <button key={m} onClick={() => switchModel(m)} style={{
            flex: 1, padding: "5px 0", border: `1px solid ${model === m ? "#3b82f6" : "#333"}`,
            background: "none", color: model === m ? "#60a5fa" : "#555",
            borderRadius: 4, cursor: "pointer", fontSize: 11, letterSpacing: 0.5,
          }}>
            {m === "gradient" ? "Gradient" : m === "genetic" ? "Genetic" : "Annealing"}
          </button>
        ))}
      </div>

      {model !== "gradient" && (
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
