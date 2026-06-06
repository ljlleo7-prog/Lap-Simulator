import { VehicleParams, maxLateralAccel, maxLonAccel, maxDecel, lonAvailFraction } from "./vehicle.js";
import { TrackPoint } from "./track.js";

export interface SimResult {
  lapTime: number;        // seconds
  speeds: Float64Array;   // m/s at each track point
  lonAccels: Float64Array; // m/s² (positive = accel, negative = brake)
  latAccels: Float64Array; // m/s²
}

function dx(points: TrackPoint[], i: number): number {
  const n = points.length;
  if (i + 1 >= n) return points[i].distance - points[i - 1].distance;
  return points[i + 1].distance - points[i].distance;
}

// Core solver: fills v[] with the min-time speed profile.
// v[] must already be initialised with lateral grip limits.
// entrySpeed caps v[0]; exitSpeed (if finite) caps v[n-1] so the car
// can continue safely onto the next lap / next section.
function latAccelAt(v: number, r: number): number {
  return r === Infinity ? 0 : (v * v) / r;
}

function solveSpeedProfile(
  params: VehicleParams,
  points: TrackPoint[],
  v: Float64Array,
  entrySpeed: number,
  exitSpeed: number,
): void {
  const n = points.length;

  // Forward pass — lon limit reduced by however much of grip is used laterally
  v[0] = Math.min(v[0], entrySpeed);
  for (let i = 0; i < n - 1; i++) {
    const aLat = latAccelAt(v[i], points[i].radius);
    const aMax = maxLonAccel(params, v[i], aLat);
    const d = dx(points, i);
    const vNext = Math.sqrt(Math.max(0, v[i] * v[i] + 2 * aMax * d));
    v[i + 1] = Math.min(v[i + 1], vNext);
  }

  // Backward pass — same friction circle constraint on braking
  v[n - 1] = Math.min(v[n - 1], exitSpeed);
  for (let i = n - 2; i >= 0; i--) {
    const aLat = latAccelAt(v[i + 1], points[i + 1].radius);
    const bMax = maxDecel(params, v[i + 1], aLat);
    const d = dx(points, i);
    const vPrev = Math.sqrt(Math.max(0, v[i + 1] * v[i + 1] + 2 * bMax * d));
    v[i] = Math.min(v[i], vPrev);
  }
}

function lateralLimits(params: VehicleParams, points: TrackPoint[]): Float64Array {
  const n = points.length;
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = points[i].radius;
    v[i] = r === Infinity ? Infinity : Math.sqrt(maxLateralAccel(params, 0) * r);
  }
  return v;
}

function buildResult(params: VehicleParams, points: TrackPoint[], v: Float64Array): SimResult {
  const n = points.length;
  const lonA = new Float64Array(n);
  const latA = new Float64Array(n);
  let lapTime = 0;
  for (let i = 0; i < n - 1; i++) {
    const d = dx(points, i);
    const vAvg = (v[i] + v[i + 1]) / 2;
    lapTime += d / Math.max(vAvg, 0.01);
    lonA[i] = (v[i + 1] * v[i + 1] - v[i] * v[i]) / (2 * d);
    const r = points[i].radius;
    latA[i] = r === Infinity ? 0 : (v[i] * v[i]) / r;
  }
  lonA[n - 1] = lonA[n - 2];
  latA[n - 1] = latA[n - 2];
  return { lapTime, speeds: v, lonAccels: lonA, latAccels: latA };
}

// ── Legacy single-lap simulate (used by tests) ────────────────────────────────

export function simulate(params: VehicleParams, points: TrackPoint[]): SimResult {
  const v = lateralLimits(params, points);
  solveSpeedProfile(params, points, v, 1, Infinity);
  return buildResult(params, points, v);
}

// ── Hot-lap simulate ──────────────────────────────────────────────────────────
// 1. Formation lap: run a simplified sim from rest on the given points to find
//    the steady-state speed at the start/finish line.
// 2. Hot lap: use that entry speed + a wrap-around exit constraint so the car
//    cannot carry speed into the finish that it couldn't scrub before turn 1.

export function simulateHotLap(params: VehicleParams, points: TrackPoint[]): SimResult {
  const n = points.length;

  // ── Formation lap: start from rest, find speed at end ────────────────────
  const vForm = lateralLimits(params, points);
  solveSpeedProfile(params, points, vForm, 1, Infinity);
  // The last point of the formation lap is our entry speed into the hot lap.
  const entrySpeed = vForm[n - 1];

  // ── Compute the max speed at the exit of the hot lap ─────────────────────
  // The car must be able to brake for the first corner after the finish line.
  // We do one backward sweep starting from points[0]'s lateral limit, as if
  // the track wrapped. Use a short look-ahead: propagate braking from [0..EXIT_LOOK]
  // back through the seam onto the last few points.
  const vHot = lateralLimits(params, points);

  // First: normal forward + backward pass with entry speed but no exit cap,
  // to get a first approximation of the speed profile.
  solveSpeedProfile(params, points, vHot, entrySpeed, Infinity);

  // Now enforce exit continuity: simulate braking from the post-finish corner.
  // points[0] is the first corner the car must handle on the next lap.
  // Cap the exit speed to whatever the car could brake from to reach v[0] safely.
  const LOOK = Math.min(20, Math.floor(n * 0.1)); // look 10% of lap or 20 pts ahead
  // Build a small wrap-around window: [n-LOOK .. n-1, 0 .. LOOK]
  const wLen = LOOK * 2 + 1;
  const wPts: TrackPoint[] = [];
  for (let k = -LOOK; k <= LOOK; k++) {
    const idx = ((k % n) + n) % n;
    const prev = k > -LOOK ? wPts[wPts.length - 1] : null;
    const base = prev ? prev.distance : 0;
    const prevIdx = (((k - 1) % n) + n) % n;
    const segLen = k > -LOOK
      ? Math.abs(points[idx].distance - points[prevIdx].distance) || dx(points, prevIdx)
      : 0;
    wPts.push({ distance: base + segLen, radius: points[idx].radius });
  }

  const vWrap = lateralLimits(params, wPts);
  // Seed the centre with the hot-lap speed at [n-LOOK]
  const startIdx = (((-LOOK) % n) + n) % n;
  vWrap[0] = Math.min(vWrap[0], vHot[startIdx]);
  // Forward pass through the window
  for (let i = 0; i < wLen - 1; i++) {
    const aLat = latAccelAt(vWrap[i], wPts[i].radius);
    const aMax = maxLonAccel(params, vWrap[i], aLat);
    const d = wPts[i + 1].distance - wPts[i].distance;
    const vNext = Math.sqrt(Math.max(0, vWrap[i] * vWrap[i] + 2 * aMax * d));
    vWrap[i + 1] = Math.min(vWrap[i + 1], vNext);
  }
  // Backward pass through the window — exit is unconstrained
  for (let i = wLen - 2; i >= 0; i--) {
    const aLat = latAccelAt(vWrap[i + 1], wPts[i + 1].radius);
    const bMax = maxDecel(params, vWrap[i + 1], aLat);
    const d = wPts[i + 1].distance - wPts[i].distance;
    const vPrev = Math.sqrt(Math.max(0, vWrap[i + 1] * vWrap[i + 1] + 2 * bMax * d));
    vWrap[i] = Math.min(vWrap[i], vPrev);
  }
  // The speed at window index LOOK is the max safe speed at points[0] on next lap.
  // The speed at window index LOOK-1 is the max safe speed one step before finish.
  // Use the speed at index 0 of the wrap (= n-LOOK in the hot lap) as the exit cap.
  const exitSpeed = vWrap[LOOK]; // speed at the seam (points[0])

  // ── Final hot-lap solve with correct entry and exit constraints ───────────
  const vFinal = lateralLimits(params, points);
  solveSpeedProfile(params, points, vFinal, entrySpeed, exitSpeed);

  return buildResult(params, points, vFinal);
}
