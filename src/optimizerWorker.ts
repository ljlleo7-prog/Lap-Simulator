import {
  initPopulation, runGeneration,
  initAnnealing, runAnnealingStep,
  runGeometricPass, runLengthPass, runSmoothenStep, fitness, lapTimeForOffsets,
} from "./optimizer.js";
import type { Offsets, AnnealState } from "./optimizer.js";
import type { CentreSample } from "./geometry.js";
import type { VehicleParams } from "./vehicle.js";

type Model = "geometric" | "genetic" | "annealing";
type Mode = "optimize" | "smoothen";

interface StartMessage {
  type: "start";
  mode: Mode;
  model: Model;
  centreSamples: CentreSample[];
  hw: Float64Array;
  seed: Float64Array;
  vehicle: VehicleParams;
  batchSize: number;
  popSize: number;
  sigma: number;
  tempStart: number;
  cooling: number;
  smoothSigma: number;
  smoothAcceptMargin: number;
}

interface StopMessage { type: "stop"; }
type WorkerMessage = StartMessage | StopMessage;

let running = false;

function arrays(centreSamples: CentreSample[]) {
  const n = centreSamples.length;
  const xs = new Float64Array(n), ys = new Float64Array(n), tg = new Float64Array(n);
  for (let i = 0; i < n; i++) { xs[i] = centreSamples[i].x; ys[i] = centreSamples[i].y; tg[i] = centreSamples[i].tangentAngle; }
  return { xs, ys, tg };
}

function signedCurvature(centreSamples: CentreSample[]): Float64Array {
  const n = centreSamples.length;
  const signedK = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const prev = centreSamples[(i - 1 + n) % n], next = centreSamples[(i + 1) % n];
    let da = next.tangentAngle - prev.tangentAngle;
    while (da >  Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    signedK[i] = da / (next.distance - prev.distance || 0.01);
  }
  return signedK;
}

function sendProgress(trials: number, bestTime: number, batchDone: number, batchSize: number, bestOffsets?: Offsets) {
  self.postMessage({ type: "progress", trials, bestTime, batchDone, batchSize, bestOffsets });
}

function actualLapTime(offsets: Offsets, msg: StartMessage, xs: Float64Array, ys: Float64Array, tg: Float64Array): number {
  return lapTimeForOffsets(offsets, msg.vehicle, msg.hw, xs, ys, tg);
}

function startOptimize(msg: StartMessage) {
  running = true;
  const { xs, ys, tg } = arrays(msg.centreSamples);
  const signedK = signedCurvature(msg.centreSamples);
  let best: Offsets = new Float64Array(msg.seed);
  let bestScore = fitness(best, msg.vehicle, msg.hw, xs, ys, tg);
  let bestLapTime = actualLapTime(best, msg, xs, ys, tg);
  let trials = 0;
  let genState: { pop: ReturnType<typeof initPopulation>; best: number } | null = null;
  let annState: AnnealState | null = null;

  if (msg.model === "genetic") {
    genState = { pop: initPopulation(best, msg.popSize, msg.sigma), best: bestScore };
  } else if (msg.model === "annealing") {
    annState = initAnnealing(best, msg.vehicle, msg.hw, xs, ys, tg, msg.tempStart);
    bestScore = annState.bestFitness;
    bestLapTime = actualLapTime(annState.best, msg, xs, ys, tg);
  }

  sendProgress(0, bestLapTime, 0, msg.batchSize, best);

  function loop() {
    if (!running) return;

    let frameBest: Offsets | undefined;
    let frameBestLapTime = bestLapTime;

    for (let trial = 0; trial < msg.batchSize && running; trial++) {
      trials++;

      if (msg.model === "genetic" && genState) {
        const { population, best: candidate, bestLapTime: candidateScore } = runGeneration(genState.pop, msg.vehicle, msg.hw, xs, ys, tg, msg.sigma);
        genState.pop = population;
        if (candidateScore < genState.best) {
          genState.best = candidateScore;
          best = candidate;
          bestScore = candidateScore;
          bestLapTime = actualLapTime(candidate, msg, xs, ys, tg);
          frameBest = candidate;
          frameBestLapTime = bestLapTime;
        }
      } else if (msg.model === "annealing" && annState) {
        annState = runAnnealingStep(annState, msg.vehicle, msg.hw, xs, ys, tg, msg.sigma, msg.cooling);
        if (annState.bestFitness < bestScore) {
          best = annState.best;
          bestScore = annState.bestFitness;
          bestLapTime = actualLapTime(best, msg, xs, ys, tg);
          frameBest = best;
          frameBestLapTime = bestLapTime;
        }
      } else if (msg.model === "geometric") {
        const n = msg.centreSamples.length;
        const wideSearch = trials % 20 === 0;
        const base = wideSearch ? new Float64Array(n) : best;
        let bestCandidate: Float64Array | null = null;
        let bestCandScore = bestScore;
        for (let k = 0; k < 6; k++) {
          const perturb = wideSearch ? 0 : 0.02 + k * 0.025;
          const raw = runGeometricPass(base, msg.vehicle, msg.hw, xs, ys, tg, signedK, perturb);
          const cand = runLengthPass(raw, signedK);
          const score = fitness(cand, msg.vehicle, msg.hw, xs, ys, tg);
          if (Number.isFinite(score) && score < bestCandScore) { bestCandScore = score; bestCandidate = cand; }
        }
        if (bestCandidate !== null) {
          best = bestCandidate;
          bestScore = bestCandScore;
          bestLapTime = actualLapTime(bestCandidate, msg, xs, ys, tg);
          frameBest = bestCandidate;
          frameBestLapTime = bestLapTime;
        }
      }
      if (msg.batchSize > 25 && (trial + 1) % Math.max(1, Math.floor(msg.batchSize / 20)) === 0) {
        sendProgress(trials, bestLapTime, trial + 1, msg.batchSize);
      }
    }

    sendProgress(trials, frameBestLapTime, msg.batchSize, msg.batchSize, frameBest);
    setTimeout(loop, 0);
  }

  setTimeout(loop, 0);
}

function startSmoothen(msg: StartMessage) {
  running = true;
  const { xs, ys, tg } = arrays(msg.centreSamples);
  let best: Offsets = new Float64Array(msg.seed);
  let bestScore = fitness(best, msg.vehicle, msg.hw, xs, ys, tg);
  let bestLapTime = actualLapTime(best, msg, xs, ys, tg);
  let smoothBestScore = Number.isFinite(bestScore) ? bestScore : Infinity;
  let trials = 0;

  sendProgress(0, bestLapTime, 0, msg.batchSize, best);

  function loop() {
    if (!running) return;

    let frameBest: Offsets | undefined;
    let frameBestLapTime = bestLapTime;

    for (let trial = 0; trial < msg.batchSize && running; trial++) {
      trials++;
      const candidate = runSmoothenStep(best, msg.vehicle, msg.hw, xs, ys, tg, msg.smoothSigma);
      if (candidate !== null) {
        const candidateScore = fitness(candidate, msg.vehicle, msg.hw, xs, ys, tg);
        const maxAcceptedScore = smoothBestScore + msg.smoothAcceptMargin;
        if (Number.isFinite(candidateScore) && candidateScore <= maxAcceptedScore) {
          best = candidate;
          bestScore = candidateScore;
          bestLapTime = actualLapTime(candidate, msg, xs, ys, tg);
          if (candidateScore < smoothBestScore) smoothBestScore = candidateScore;
          frameBest = candidate;
          frameBestLapTime = bestLapTime;
        }
      }
      if (msg.batchSize > 25 && (trial + 1) % Math.max(1, Math.floor(msg.batchSize / 20)) === 0) {
        sendProgress(trials, bestLapTime, trial + 1, msg.batchSize);
      }
    }

    sendProgress(trials, frameBestLapTime, msg.batchSize, msg.batchSize, frameBest);
    setTimeout(loop, 0);
  }

  setTimeout(loop, 0);
}

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data;
  if (msg.type === "stop") {
    running = false;
    return;
  }
  running = false;
  setTimeout(() => {
    if (msg.mode === "smoothen") startSmoothen(msg);
    else startOptimize(msg);
  }, 0);
};
