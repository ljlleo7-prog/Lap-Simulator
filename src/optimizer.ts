import { simulateGripTargetHotLap, simulateHotLap } from "./integrator.js";
import { racingLineFromOffsets } from "./geometry.js";
import type { TrackPoint } from "./track.js";
import type { VehicleParams } from "./vehicle.js";

export type SimMode = "grip" | "slide";

// offset ∈ [-0.5, 0.5] per track sample, half-widths in metres
export type Offsets = Float64Array;

function clamp(v: number): number { return Math.max(-0.5, Math.min(0.5, v)); }

// Smooth noise: generate random Fourier components at low frequencies only,
// so the perturbation varies slowly along the track (no per-sample zigzag).
function smoothNoise(n: number, sigma: number, nFreqs = 8): Offsets {
  const noise = new Float64Array(n);
  for (let f = 1; f <= nFreqs; f++) {
    const amp = (sigma / Math.sqrt(nFreqs)) * (Math.random() - 0.5) * 2;
    const phase = Math.random() * 2 * Math.PI;
    for (let i = 0; i < n; i++) noise[i] += amp * Math.cos(2 * Math.PI * f * i / n + phase);
  }
  return noise;
}

function mutate(o: Offsets, sigma: number): Offsets {
  const noise = smoothNoise(o.length, sigma);
  const m = new Float64Array(o.length);
  for (let i = 0; i < m.length; i++) m[i] = clamp(o[i] + noise[i]);
  return m;
}

function crossover(a: Offsets, b: Offsets): Offsets {
  const n = a.length;
  const cut = Math.floor(Math.random() * n);
  const child = new Float64Array(n);
  for (let i = 0; i < n; i++) child[i] = i < cut ? a[i] : b[i];
  return child;
}

// Convert offset array + geometry to TrackPoints for the integrator.
// hw: half-widths per sample, samples: CentreSample geometry.
export function offsetsToTrackPoints(
  offsets: Offsets,
  hw: Float64Array,
  xs: Float64Array,
  ys: Float64Array,
  tangents: Float64Array, // tangentAngle per sample
): TrackPoint[] {
  const samples = Array.from(offsets, (_, i) => ({ x: xs[i], y: ys[i], tangentAngle: tangents[i] }));
  return racingLineFromOffsets(offsets, hw, samples).map(s => ({ distance: s.distance, radius: s.radius }));
}

export function lapTimeForOffsets(
  offsets: Offsets,
  vehicle: VehicleParams,
  hw: Float64Array,
  xs: Float64Array,
  ys: Float64Array,
  tangents: Float64Array,
  simMode: SimMode = "slide",
  driftTolerance = 0.18,
): number {
  const pts = offsetsToTrackPoints(offsets, hw, xs, ys, tangents);
  return simMode === "grip" ? simulateGripTargetHotLap(vehicle, pts).lapTime : simulateHotLap(vehicle, pts, hw, driftTolerance).lapTime;
}

export function fitness(
  offsets: Offsets,
  vehicle: VehicleParams,
  hw: Float64Array,
  xs: Float64Array,
  ys: Float64Array,
  tangents: Float64Array,
  simMode: SimMode = "slide",
  driftTolerance = 0.18,
): number {
  return lapTimeForOffsets(offsets, vehicle, hw, xs, ys, tangents, simMode, driftTolerance);
}

export interface GenResult {
  bestOffsets: Offsets;
  bestLapTime: number;
  generation: number;
}

export function runGeneration(
  population: Offsets[],
  vehicle: VehicleParams,
  hw: Float64Array,
  xs: Float64Array,
  ys: Float64Array,
  tangents: Float64Array,
  sigma: number,
  simMode: SimMode = "slide",
  driftTolerance = 0.18,
): { population: Offsets[]; best: Offsets; bestLapTime: number } {
  const pop = population.length;

  // evaluate
  const lapTimes = population.map(o => fitness(o, vehicle, hw, xs, ys, tangents, simMode, driftTolerance));

  // find best
  let bestIdx = 0;
  for (let i = 1; i < pop; i++) if (lapTimes[i] < lapTimes[bestIdx]) bestIdx = i;

  // tournament selection (k=3) + crossover + mutation → new population
  function tournament(): Offsets {
    let winner = Math.floor(Math.random() * pop);
    for (let k = 1; k < 3; k++) {
      const c = Math.floor(Math.random() * pop);
      if (lapTimes[c] < lapTimes[winner]) winner = c;
    }
    return population[winner];
  }

  const next: Offsets[] = [population[bestIdx]]; // elitism: keep best
  while (next.length < pop) {
    const a = tournament(), b = tournament();
    next.push(mutate(crossover(a, b), sigma));
  }

  return { population: next, best: population[bestIdx], bestLapTime: lapTimes[bestIdx] };
}

export function initPopulation(seed: Offsets, size: number, sigma: number): Offsets[] {
  // First individual is the seed itself (best known line so far).
  // Rest are smooth perturbations of it — valid-looking lines, not random junk.
  return [new Float64Array(seed), ...Array.from({ length: size - 1 }, () => mutate(seed, sigma))];
}

// ── Simulated annealing ───────────────────────────────────────────────────────

export interface AnnealState {
  current: Offsets;
  currentFitness: number;
  best: Offsets;
  bestFitness: number;
  temp: number;
}

export function initAnnealing(
  seed: Offsets,
  vehicle: VehicleParams,
  hw: Float64Array,
  xs: Float64Array,
  ys: Float64Array,
  tangents: Float64Array,
  tempStart: number,
  simMode: SimMode = "slide",
  driftTolerance = 0.18,
): AnnealState {
  const f = fitness(seed, vehicle, hw, xs, ys, tangents, simMode, driftTolerance);
  return { current: new Float64Array(seed), currentFitness: f, best: new Float64Array(seed), bestFitness: f, temp: tempStart };
}

export function runAnnealingStep(
  state: AnnealState,
  vehicle: VehicleParams,
  hw: Float64Array,
  xs: Float64Array,
  ys: Float64Array,
  tangents: Float64Array,
  sigma: number,
  cooling: number,
  simMode: SimMode = "slide",
  driftTolerance = 0.18,
): AnnealState {
  const candidate = mutate(state.current, sigma);
  const cf = fitness(candidate, vehicle, hw, xs, ys, tangents, simMode, driftTolerance);
  const dE = cf - state.currentFitness;
  const accept = dE < 0 || Math.random() < Math.exp(-dE / Math.max(state.temp, 1e-6));
  const next = accept ? candidate : state.current;
  const nextF = accept ? cf : state.currentFitness;
  const isBetter = nextF < state.bestFitness;
  return {
    current: next, currentFitness: nextF,
    best: isBetter ? candidate : state.best,
    bestFitness: isBetter ? nextF : state.bestFitness,
    temp: state.temp * cooling,
  };
}

// ── Geometric racing-line pass ─────────────────────────────────────────────────
//
// Detects corners from signed curvature, builds a deterministic out-in-out
// late-apex template for each one, then evaluates small apex-position
// perturbations to escape local minima.  Much more structured than random
// mutation: the warm candidate already respects the classic racing-line shape,
// and exploration is local to the apex region of each corner.
//
// signedK: signed curvature per sample (positive = left-hand bend)
// straightLookAhead: number of samples to look ahead for exit-straight length
export function runGeometricPass(
  offsets: Offsets,
  vehicle: VehicleParams,
  hw: Float64Array,
  xs: Float64Array,
  ys: Float64Array,
  tg: Float64Array,
  signedK: Float64Array,
  perturbScale = 0.04, // small randomness around apex, 0 = fully deterministic
): Offsets {
  const n = offsets.length;

  // ── 1. Build smoothed absolute curvature for corner detection ────────────
  const absK = new Float64Array(n);
  const SMOOTH_W = 3;
  for (let i = 0; i < n; i++) {
    let s = 0, w = 0;
    for (let k = -SMOOTH_W; k <= SMOOTH_W; k++) {
      absK[i] += Math.abs(signedK[(i + k + n) % n]);
      s += Math.abs(signedK[(i + k + n) % n]); w++;
    }
    absK[i] = s / w;
  }
  const maxAbsK = Math.max(...Array.from(absK), 1e-9);

  // ── 2. Find corner peaks (local maxima above threshold) ──────────────────
  const PEAK_THRESH = 0.15; // fraction of maxAbsK to be called a corner
  const MIN_GAP = Math.max(4, Math.floor(n * 0.03)); // min samples between peaks
  const peaks: number[] = [];
  for (let i = 0; i < n; i++) {
    const norm = absK[i] / maxAbsK;
    if (norm < PEAK_THRESH) continue;
    let isMax = true;
    for (let k = -MIN_GAP; k <= MIN_GAP; k++) {
      if (k === 0) continue;
      if (absK[(i + k + n) % n] > absK[i]) { isMax = false; break; }
    }
    if (isMax) peaks.push(i);
  }

  // ── 3. Build candidate from deterministic out-in-out template ───────────
  //
  // For each corner:
  //   - entry zone  → push toward outside of the corner
  //   - apex        → push toward inside (the late apex, ~65% through)
  //   - exit zone   → push back toward outside, weighted by exit-straight length
  //
  // "outside" for a left-hand bend (signedK > 0) is the negative-normal side
  // (offset < 0); inside is offset > 0.  We work in signed offset space.

  const candidate = new Float64Array(offsets);

  // Measure exit-straight length from each sample (number of samples until
  // curvature rises above STRAIGHT_K again).
  const STRAIGHT_K_THRESH = 0.1 * maxAbsK;
  function exitStraightLength(apexIdx: number, cornerHalfWidth: number): number {
    let len = 0;
    for (let k = 1; k < n; k++) {
      const j = (apexIdx + k) % n;
      if (absK[j] > STRAIGHT_K_THRESH) break;
      len++;
    }
    return len;
  }

  for (const apex of peaks) {
    const dir = Math.sign(signedK[apex]) || 1; // +1 = left bend, -1 = right bend
    // "inside" = +dir in offset space (inside of the bend)
    const exitLen = exitStraightLength(apex, n);
    // longer exit straight → push exit wider, bias apex slightly later
    const exitBias = Math.min(1, exitLen / Math.max(n * 0.1, 1));

    // Half-widths of the corner zone: proportional to corner intensity
    const normK = absK[apex] / maxAbsK;
    const zoneHalf = Math.max(MIN_GAP, Math.floor(normK * n * 0.12));

    // Late-apex position: 60-70% through the corner (later for longer exit)
    const apexShift = Math.floor(zoneHalf * (0.1 + exitBias * 0.15));

    for (let k = -zoneHalf; k <= zoneHalf; k++) {
      const i = (apex + k + n) % n;
      const phase = (k + zoneHalf) / (2 * zoneHalf); // 0=entry, 1=exit

      const apexPhase = 0.62 + exitBias * 0.12;
      let insideness: number;
      if (phase < apexPhase) {
        insideness = -0.48 + 0.94 * phase / apexPhase;
      } else {
        const exitOutside = 0.42 + exitBias * 0.06;
        const t = (phase - apexPhase) / (1 - apexPhase);
        insideness = 0.46 + (-exitOutside - 0.46) * t;
      }

      const target = clamp(dir * insideness);

      const zoneWeight = Math.sin(Math.PI * phase);
      const blend = Math.min(1, 0.35 + 0.65 * zoneWeight);
      candidate[i] = clamp(candidate[i] * (1 - blend) + target * blend);
    }

    // Small perturbation around apex to explore nearby solutions
    if (perturbScale > 0) {
      const perturbZone = Math.max(2, Math.floor(zoneHalf * 0.4));
      for (let k = -perturbZone; k <= perturbZone; k++) {
        const i = (apex + apexShift + k + n) % n;
        const noise = (Math.random() - 0.5) * 2 * perturbScale;
        candidate[i] = clamp(candidate[i] + noise);
      }
    }
  }

  return candidate;
}

// Smooth a randomized local window rather than the entire lap at once.
// Local trials let the acceptance gate pass/reject small changes instead of
// rejecting one globally expensive full-line blur.
export function runSmoothenStep(
  offsets: Offsets,
  vehicle: VehicleParams,
  hw: Float64Array,
  xs: Float64Array,
  ys: Float64Array,
  tangents: Float64Array,
  gaussianSigma: number, // fraction of n samples, e.g. 0.04
  _simMode: SimMode = "slide",
): Offsets | null {
  const n = offsets.length;
  const pts = offsetsToTrackPoints(offsets, hw, xs, ys, tangents);

  const rawK = new Float64Array(n);
  let maxK = 1e-9;
  for (let i = 0; i < n; i++) {
    rawK[i] = pts[i].radius === Infinity ? 0 : 1 / pts[i].radius;
    maxK = Math.max(maxK, Math.abs(rawK[i]));
  }

  const sigSamples = Math.max(2, gaussianSigma * n);
  const radius = Math.max(2, Math.ceil(sigSamples * (0.6 + Math.random() * 1.8)));
  const center = Math.floor(Math.random() * n);
  const out = new Float64Array(offsets);
  const baseStrength = 0.18 + Math.random() * 0.42;

  for (let k = -radius; k <= radius; k++) {
    const i = (center + k + n) % n;
    const cornerness = Math.min(1, Math.abs(rawK[i]) / maxK);
    const straightness = 1 - Math.sqrt(cornerness);
    const localWeight = Math.exp(-(k * k) / (2 * radius * radius * 0.18));
    const strength = baseStrength * (0.2 + 0.8 * straightness) * localWeight;

    let sum = 0, wsum = 0;
    for (let jOff = -radius; jOff <= radius; jOff++) {
      const j = (i + jOff + n) % n;
      const w = Math.exp(-(jOff * jOff) / (2 * sigSamples * sigSamples));
      sum += offsets[j] * w;
      wsum += w;
    }
    const blurred = sum / Math.max(wsum, 1e-9);
    out[i] = clamp(offsets[i] + (blurred - offsets[i]) * strength);
  }

  return out;
}

// Pull each offset toward the mean of its neighbours, weighted by how straight
// the centre-line is at that point. Straightens S-curves on straights without
// disturbing corner positioning.
export function runLengthPass(
  offsets: Offsets,
  signedK: Float64Array, // signed curvature per sample (from geometry)
  strength = 0.15,
): Offsets {
  const n = offsets.length;
  const maxK = Math.max(...Array.from(signedK).map(Math.abs), 1e-6);
  const out = new Float64Array(offsets);
  for (let i = 0; i < n; i++) {
    const cornerness = Math.abs(signedK[i]) / maxK; // 0=straight, 1=corner
    const straightness = 1 - cornerness;
    if (straightness < 0.1) continue; // skip corners entirely
    const prev = offsets[(i - 1 + n) % n];
    const next = offsets[(i + 1) % n];
    const target = (prev + next) / 2; // mean of neighbours = locally straight
    out[i] = clamp(offsets[i] + (target - offsets[i]) * strength * straightness);
  }
  return out;
}
