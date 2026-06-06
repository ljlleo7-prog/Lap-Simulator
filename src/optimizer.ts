import type { TrackPoint } from "./track.js";
import { simulate } from "./integrator.js";
import type { VehicleParams } from "./vehicle.js";

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
  const n = offsets.length;
  const pts: TrackPoint[] = [];
  let dist = 0;
  for (let i = 0; i < n; i++) {
    const ox = -Math.sin(tangents[i]) * hw[i] * offsets[i] * 2;
    const oy =  Math.cos(tangents[i]) * hw[i] * offsets[i] * 2;
    const rx = xs[i] + ox;
    const ry = ys[i] + oy;

    if (i > 0) {
      const prev = pts[i - 1] as TrackPoint & { _x: number; _y: number };
      dist += Math.sqrt((rx - prev._x) ** 2 + (ry - prev._y) ** 2);
    }

    // local radius from three consecutive points
    let radius = Infinity;
    if (i > 0 && i < n - 1) {
      const pi = i - 1, ni = i + 1;
      const pox = -Math.sin(tangents[pi]) * hw[pi] * offsets[pi] * 2;
      const poy =  Math.cos(tangents[pi]) * hw[pi] * offsets[pi] * 2;
      const nox = -Math.sin(tangents[ni]) * hw[ni] * offsets[ni] * 2;
      const noy =  Math.cos(tangents[ni]) * hw[ni] * offsets[ni] * 2;
      const ax = xs[pi] + pox, ay = ys[pi] + poy;
      const bx = xs[ni] + nox, by = ys[ni] + noy;
      const dax = rx - ax, day = ry - ay;
      const dbx = bx - rx, dby = by - ry;
      const cr = Math.abs(dax * dby - day * dbx);
      if (cr > 1e-10)
        radius = Math.pow(Math.sqrt(dax*dax+day*day) * Math.sqrt(dbx*dbx+dby*dby), 1.5) / cr;
    }

    const tp = { distance: dist, radius } as TrackPoint & { _x: number; _y: number };
    tp._x = rx; tp._y = ry;
    pts.push(tp);
  }
  return pts;
}

export function fitness(
  offsets: Offsets,
  vehicle: VehicleParams,
  hw: Float64Array,
  xs: Float64Array,
  ys: Float64Array,
  tangents: Float64Array,
): number {
  const pts = offsetsToTrackPoints(offsets, hw, xs, ys, tangents);
  return simulate(vehicle, pts).lapTime;
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
): { population: Offsets[]; best: Offsets; bestLapTime: number } {
  const pop = population.length;

  // evaluate
  const lapTimes = population.map(o => fitness(o, vehicle, hw, xs, ys, tangents));

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
): AnnealState {
  const f = fitness(seed, vehicle, hw, xs, ys, tangents);
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
): AnnealState {
  const candidate = mutate(state.current, sigma);
  const cf = fitness(candidate, vehicle, hw, xs, ys, tangents);
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

// ── Gradient descent (lap-time coordinate descent) ────────────────────────────

// One full coordinate-descent pass minimising lap time directly.
export function runGradientPass(
  offsets: Offsets,
  vehicle: VehicleParams,
  hw: Float64Array,
  xs: Float64Array,
  ys: Float64Array,
  tg: Float64Array,
  step: number,
): Offsets {
  const n = offsets.length;
  const snap = new Float64Array(offsets); // frozen reference for all evaluations
  const out  = new Float64Array(offsets); // output — written only after decision
  const f0 = fitness(snap, vehicle, hw, xs, ys, tg); // baseline once

  for (let i = 0; i < n; i++) {
    const orig = snap[i];
    const tryP = new Float64Array(snap); tryP[i] = clamp(orig + step);
    const tryM = new Float64Array(snap); tryM[i] = clamp(orig - step);
    const fp = fitness(tryP, vehicle, hw, xs, ys, tg);
    const fm = fitness(tryM, vehicle, hw, xs, ys, tg);
    if (fp <= fm && fp < f0)  out[i] = clamp(orig + step);
    else if (fm < f0)         out[i] = clamp(orig - step);
    // else out[i] stays as orig (copied from offsets above)
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
