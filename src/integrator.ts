import {
  VehicleParams,
  maxLateralAccel,
  maxLonAccel,
  maxDecel,
  steeringTransitionDragForce,
  yawInertiaDragForce,
} from "./vehicle.js";
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

function wrappedDx(points: TrackPoint[], i: number): number {
  const n = points.length;
  const idx = ((i % n) + n) % n;
  if (idx < n - 1) return points[idx + 1].distance - points[idx].distance;
  const total = points[n - 1].distance;
  return Math.max(0.01, total - points[idx].distance + points[0].distance);
}

// Core solver: fills v[] with the min-time speed profile.
// v[] must already be initialised with lateral grip limits.
// entrySpeed caps v[0]; exitSpeed (if finite) caps v[n-1] so the car
// can continue safely onto the next lap / next section.
function latAccelAt(v: number, r: number): number {
  return r === Infinity ? 0 : (v * v) / Math.abs(r);
}

function signedCurvature(r: number): number {
  return r === Infinity ? 0 : 1 / r;
}

function transientDragAccel(params: VehicleParams, v: number, r0: number, r1: number, d: number): number {
  const raw = (yawInertiaDragForce(params, v, r0, r1, d) + steeringTransitionDragForce(params, v, r0, r1, d)) / params.mass;
  const gripBound = maxLateralAccel(params, v) * 0.35;
  const energyBound = v * v / Math.max(4 * d, 0.01);
  return Math.min(raw, gripBound, energyBound);
}

function solveSpeedProfile(
  params: VehicleParams,
  points: TrackPoint[],
  v: Float64Array,
  entrySpeed: number,
  exitSpeed: number,
): void {
  const n = points.length;

  // Forward pass — lon limit reduced by friction circle + slip-angle tyre drag
  v[0] = Math.min(v[0], entrySpeed);
  for (let i = 0; i < n - 1; i++) {
    const r    = points[i].radius;
    const aLat = latAccelAt(v[i], r);
    const d = dx(points, i);
    const transientDrag = transientDragAccel(params, v[i], r, points[i + 1].radius, d);
    const aMax = maxLonAccel(params, v[i], aLat, r) - transientDrag;
    const vNext = Math.sqrt(Math.max(0, v[i] * v[i] + 2 * aMax * d));
    v[i + 1] = Math.min(v[i + 1], vNext);
  }

  // Backward pass — same
  v[n - 1] = Math.min(v[n - 1], exitSpeed);
  for (let i = n - 2; i >= 0; i--) {
    const r    = points[i + 1].radius;
    const aLat = latAccelAt(v[i + 1], r);
    const bMax = maxDecel(params, v[i + 1], aLat, r);
    const d = dx(points, i);
    const vPrev = Math.sqrt(Math.max(0, v[i + 1] * v[i + 1] + 2 * bMax * d));
    v[i] = Math.min(v[i], vPrev);
  }
}

function lateralGripUtilization(params: VehicleParams): number {
  const kartPenalty = params.diffLockRear > 0.8 && params.wheelbase < 1.3 ? 0.82 : 0.9;
  return Math.max(0.75, kartPenalty - params.tyreDragK * 0.2);
}

function cornerSpeedLimit(params: VehicleParams, radius: number): number {
  if (radius === Infinity) return Infinity;
  const r = Math.abs(radius);
  const utilization = lateralGripUtilization(params);
  let lo = 0;
  let hi = 120;
  for (let i = 0; i < 8 && latAccelAt(hi, r) <= maxLateralAccel(params, hi) * utilization; i++) hi *= 1.5;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (latAccelAt(mid, r) <= maxLateralAccel(params, mid) * utilization) lo = mid;
    else hi = mid;
  }
  return lo;
}

function lateralLimits(params: VehicleParams, points: TrackPoint[]): Float64Array {
  const n = points.length;
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) v[i] = cornerSpeedLimit(params, points[i].radius);
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
  const LOOK = Math.max(1, Math.min(20, Math.floor(n * 0.1))); // look 10% of lap or 20 pts ahead
  // Build a small wrap-around window: [n-LOOK .. n-1, 0 .. LOOK]
  const wLen = LOOK * 2 + 1;
  const wPts: TrackPoint[] = [];
  let wDist = 0;
  for (let k = -LOOK; k <= LOOK; k++) {
    const idx = ((k % n) + n) % n;
    if (k > -LOOK) wDist += wrappedDx(points, idx - 1);
    wPts.push({ distance: wDist, radius: points[idx].radius });
  }

  const vWrap = lateralLimits(params, wPts);
  // Seed the centre with the hot-lap speed at [n-LOOK]
  const startIdx = (((-LOOK) % n) + n) % n;
  vWrap[0] = Math.min(vWrap[0], vHot[startIdx]);
  // Forward pass through the window
  for (let i = 0; i < wLen - 1; i++) {
    const r    = wPts[i].radius;
    const aLat = latAccelAt(vWrap[i], r);
    const d = wPts[i + 1].distance - wPts[i].distance;
    const transientDrag = transientDragAccel(params, vWrap[i], r, wPts[i + 1].radius, d);
    const aMax = maxLonAccel(params, vWrap[i], aLat, r) - transientDrag;
    const vNext = Math.sqrt(Math.max(0, vWrap[i] * vWrap[i] + 2 * aMax * d));
    vWrap[i + 1] = Math.min(vWrap[i + 1], vNext);
  }
  // Backward pass through the window — exit is unconstrained
  for (let i = wLen - 2; i >= 0; i--) {
    const r    = wPts[i + 1].radius;
    const aLat = latAccelAt(vWrap[i + 1], r);
    const bMax = maxDecel(params, vWrap[i + 1], aLat, r);
    const d = wPts[i + 1].distance - wPts[i].distance;
    const vPrev = Math.sqrt(Math.max(0, vWrap[i + 1] * vWrap[i + 1] + 2 * bMax * d));
    vWrap[i] = Math.min(vWrap[i], vPrev);
  }
  // The speed just before the seam is the max safe hot-lap exit speed.
  const exitSpeed = vWrap[LOOK - 1];

  // ── Final hot-lap solve with correct entry and exit constraints ───────────
  const vFinal = lateralLimits(params, points);
  solveSpeedProfile(params, points, vFinal, entrySpeed, exitSpeed);

  return buildResult(params, points, vFinal);
}
