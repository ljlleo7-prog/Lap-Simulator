import {
  VehicleParams,
  maxLateralAccel,
  maxLonAccel,
  maxDecel,
  lateralGripState,
  axleLateralGripState,
  driftAuthorityFactor,
  driftPenaltyAccel,
  steeringTransitionDragForce,
  yawInertiaDragForce,
} from "./vehicle.js";
import { TrackPoint } from "./track.js";

export interface SimResult {
  lapTime: number;        // seconds
  sampleTimes: Float64Array; // cumulative seconds at each track point
  speeds: Float64Array;   // m/s at each track point
  lonAccels: Float64Array; // m/s² (positive = accel, negative = brake)
  latAccels: Float64Array; // m/s²
  slideRatios: Float64Array; // 0 = grip, >0 = over static lateral grip
  lateralOffsets: Float64Array; // metres outward from requested path
  frontSlideRatios: Float64Array;
  rearSlideRatios: Float64Array;
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

function effectiveTravelDistance(points: TrackPoint[], i: number, lateralOffsets: Float64Array): number {
  const d = dx(points, i);
  const r = points[i].radius;
  const o0 = lateralOffsets[i] ?? 0;
  const o1 = lateralOffsets[i + 1] ?? o0;
  const offsetAvg = Math.max(0, (o0 + o1) / 2);
  const offsetDelta = o1 - o0;
  if (r === Infinity || r === 0) return Math.hypot(d, offsetDelta);
  const arcScale = Math.max(0.2, (Math.abs(r) + offsetAvg) / Math.max(Math.abs(r), 0.01));
  return Math.hypot(d * arcScale, offsetDelta);
}

function buildResult(
  params: VehicleParams,
  points: TrackPoint[],
  v: Float64Array,
  includeSliding = false,
  lateralOffsets: Float64Array = new Float64Array(points.length),
  frontSlideRatios: Float64Array = new Float64Array(points.length),
  rearSlideRatios: Float64Array = new Float64Array(points.length),
): SimResult {
  const n = points.length;
  const lonA = new Float64Array(n);
  const latA = new Float64Array(n);
  const sampleTimes = new Float64Array(n);
  const slideRatios = new Float64Array(n);
  let lapTime = 0;
  for (let i = 0; i < n - 1; i++) {
    const d = dx(points, i);
    const travelD = includeSliding ? effectiveTravelDistance(points, i, lateralOffsets) : d;
    const vAvg = (v[i] + v[i + 1]) / 2;
    lapTime += travelD / Math.max(vAvg, 0.01);
    sampleTimes[i + 1] = lapTime;
    lonA[i] = (v[i + 1] * v[i + 1] - v[i] * v[i]) / (2 * travelD);
    const r = points[i].radius;
    latA[i] = r === Infinity ? 0 : (v[i] * v[i]) / r;
    if (includeSliding) {
      const state = lateralGripState(params, v[i], latA[i]);
      const axleState = axleLateralGripState(params, v[i], latA[i]);
      slideRatios[i] = Math.max(state.slideRatio, axleState.frontSlideRatio, axleState.rearSlideRatio);
      frontSlideRatios[i] = Math.max(frontSlideRatios[i], axleState.frontSlideRatio);
      rearSlideRatios[i] = Math.max(rearSlideRatios[i], axleState.rearSlideRatio);
    }
  }
  lonA[n - 1] = lonA[n - 2];
  latA[n - 1] = latA[n - 2];
  slideRatios[n - 1] = slideRatios[n - 2];
  frontSlideRatios[n - 1] = frontSlideRatios[n - 2];
  rearSlideRatios[n - 1] = rearSlideRatios[n - 2];
  lateralOffsets[n - 1] = lateralOffsets[n - 2];
  return { lapTime, sampleTimes, speeds: v, lonAccels: lonA, latAccels: latA, slideRatios, lateralOffsets, frontSlideRatios, rearSlideRatios };
}

function solvePureLongitudinalEnvelope(
  params: VehicleParams,
  points: TrackPoint[],
  entrySpeed: number,
  exitSpeed: number,
): Float64Array {
  const n = points.length;
  const v = new Float64Array(n);
  v.fill(Infinity);
  v[0] = Math.min(v[0], entrySpeed);
  for (let i = 0; i < n - 1; i++) {
    const d = dx(points, i);
    const aMax = maxLonAccel(params, v[i], 0, Infinity);
    v[i + 1] = Math.min(v[i + 1], Math.sqrt(Math.max(0, v[i] * v[i] + 2 * aMax * d)));
  }
  v[n - 1] = Math.min(v[n - 1], exitSpeed);
  for (let i = n - 2; i >= 0; i--) {
    const d = dx(points, i);
    const bMax = maxDecel(params, v[i + 1], 0, Infinity);
    v[i] = Math.min(v[i], Math.sqrt(Math.max(0, v[i + 1] * v[i + 1] + 2 * bMax * d)));
  }
  return v;
}

function halfWidthAt(halfWidths: Float64Array | undefined, i: number): number {
  const hw = halfWidths?.[i];
  return hw && hw > 0 ? hw : Infinity;
}

function driftToleranceDistance(halfWidth: number, driftTolerance: number): number {
  const allowance = Math.max(0, driftTolerance);
  return Number.isFinite(halfWidth) ? Math.max(0.1, halfWidth * allowance) : Math.max(0.1, allowance * 4);
}

function slideOffsetStep(params: VehicleParams, v: number, r: number, d: number, previousOffset: number): { offset: number; frontSlide: number; rearSlide: number; slideLossScale: number } {
  if (r === Infinity || r === 0) return { offset: previousOffset * Math.exp(-d / Math.max(v * 0.8, 1)), frontSlide: 0, rearSlide: 0, slideLossScale: 0 };
  const aLat = latAccelAt(v, r);
  const state = axleLateralGripState(params, v, aLat);
  const frontExcess = state.frontKineticExcessRatio;
  const rearExcess = state.rearKineticExcessRatio;
  const slide = Math.max(frontExcess, rearExcess);
  if (slide <= 0) return { offset: previousOffset * Math.exp(-d / Math.max(v * 0.8, 1)), frontSlide: state.frontSlideRatio, rearSlide: state.rearSlideRatio, slideLossScale: 0 };
  const understeerWeight = frontExcess / Math.max(frontExcess + rearExcess, 1e-6);
  const oversteerWeight = rearExcess / Math.max(frontExcess + rearExcess, 1e-6);
  const response = 0.55 + understeerWeight * 0.45 + oversteerWeight * 0.25;
  const lateralDrift = Math.min(maxLateralAccel(params, v), Math.abs(aLat)) * slide * response;
  const dt = d / Math.max(v, 1);
  const offset = previousOffset * Math.exp(-dt * (0.8 + oversteerWeight * 0.5)) + 0.5 * lateralDrift * dt * dt;
  return { offset, frontSlide: state.frontSlideRatio, rearSlide: state.rearSlideRatio, slideLossScale: slide * (0.7 + understeerWeight * 0.4 + oversteerWeight * 0.2) };
}

function solveDriftAwareSpeedProfile(
  params: VehicleParams,
  points: TrackPoint[],
  v: Float64Array,
  entrySpeed: number,
  exitSpeed: number,
  halfWidths?: Float64Array,
  driftTolerance = 0.18,
): { lateralOffsets: Float64Array; frontSlideRatios: Float64Array; rearSlideRatios: Float64Array } {
  const n = points.length;
  const lateralOffsets = new Float64Array(n);
  const frontSlideRatios = new Float64Array(n);
  const rearSlideRatios = new Float64Array(n);
  for (let pass = 0; pass < 4; pass++) {
    lateralOffsets.fill(0);
    frontSlideRatios.fill(0);
    rearSlideRatios.fill(0);
    v[0] = Math.min(v[0], entrySpeed);
    for (let i = 0; i < n - 1; i++) {
      const r = points[i].radius;
      const aLat = latAccelAt(v[i], r);
      const d = dx(points, i);
      const authority = driftAuthorityFactor(params, v[i], aLat);
      const transientDrag = transientDragAccel(params, v[i], r, points[i + 1].radius, d);
      const slideStep = slideOffsetStep(params, v[i], r, d, lateralOffsets[i]);
      const halfWidth = halfWidthAt(halfWidths, i + 1);
      const toleranceDistance = driftToleranceDistance(halfWidth, driftTolerance);
      const excessDrift = Math.max(0, slideStep.offset - toleranceDistance);
      const excessDriftRatio = excessDrift / Math.max(toleranceDistance, 0.1);
      const offTrackRatio = Math.max(0, slideStep.offset - halfWidth) / Math.max(halfWidth, 1);
      const slideLoss = driftPenaltyAccel(params, v[i], aLat, r) * (0.08 + slideStep.slideLossScale * 0.25 + excessDriftRatio * excessDriftRatio * 1.2);
      const toleranceGuardLoss = excessDriftRatio * excessDriftRatio * Math.max(maxDecel(params, v[i], 0, Infinity), 1) * 0.8;
      const offTrackLoss = offTrackRatio * offTrackRatio * Math.max(maxDecel(params, v[i], 0, Infinity), 1) * 4;
      const driveAccel = maxLonAccel(params, v[i], aLat, r) * authority - transientDrag - toleranceGuardLoss - offTrackLoss;
      const freeSpeed = Math.sqrt(Math.max(0, v[i] * v[i] + 2 * driveAccel * d));
      const damping = 1 + slideLoss * d / Math.max(v[i] * v[i], 1);
      const vNext = freeSpeed / damping;
      lateralOffsets[i + 1] = slideStep.offset;
      frontSlideRatios[i] = slideStep.frontSlide;
      rearSlideRatios[i] = slideStep.rearSlide;
      v[i + 1] = Math.min(v[i + 1], vNext);
    }

    v[n - 1] = Math.min(v[n - 1], exitSpeed);
    for (let i = n - 2; i >= 0; i--) {
      const d = dx(points, i);
      const bMax = maxDecel(params, v[i + 1], 0, Infinity);
      const vPrev = Math.sqrt(Math.max(0, v[i + 1] * v[i + 1] + 2 * bMax * d));
      v[i] = Math.min(v[i], vPrev);
    }
  }
  return { lateralOffsets, frontSlideRatios, rearSlideRatios };
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

export function simulateGripTargetHotLap(params: VehicleParams, points: TrackPoint[]): SimResult {
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

export function simulateDriftAwareHotLap(params: VehicleParams, points: TrackPoint[], halfWidths?: Float64Array, driftTolerance = 0.18): SimResult {
  const n = points.length;

  const vForm = solvePureLongitudinalEnvelope(params, points, 1, Infinity);
  solveDriftAwareSpeedProfile(params, points, vForm, 1, Infinity, halfWidths, driftTolerance);
  const entrySpeed = vForm[n - 1];

  const vHot = solvePureLongitudinalEnvelope(params, points, entrySpeed, Infinity);
  solveDriftAwareSpeedProfile(params, points, vHot, entrySpeed, Infinity, halfWidths, driftTolerance);

  const LOOK = Math.max(1, Math.min(20, Math.floor(n * 0.1)));
  const wLen = LOOK * 2 + 1;
  const wPts: TrackPoint[] = [];
  let wDist = 0;
  for (let k = -LOOK; k <= LOOK; k++) {
    const idx = ((k % n) + n) % n;
    if (k > -LOOK) wDist += wrappedDx(points, idx - 1);
    wPts.push({ distance: wDist, radius: points[idx].radius });
  }

  const startIdx = (((-LOOK) % n) + n) % n;
  const vWrap = solvePureLongitudinalEnvelope(params, wPts, vHot[startIdx], Infinity);
  solveDriftAwareSpeedProfile(params, wPts, vWrap, vHot[startIdx], Infinity);
  const exitSpeed = vWrap[LOOK - 1];

  const vFinal = solvePureLongitudinalEnvelope(params, points, entrySpeed, exitSpeed);
  const slideState = solveDriftAwareSpeedProfile(params, points, vFinal, entrySpeed, exitSpeed, halfWidths, driftTolerance);

  return buildResult(params, points, vFinal, true, slideState.lateralOffsets, slideState.frontSlideRatios, slideState.rearSlideRatios);
}

export function simulateHotLap(params: VehicleParams, points: TrackPoint[], halfWidths?: Float64Array, driftTolerance = 0.18): SimResult {
  return simulateDriftAwareHotLap(params, points, halfWidths, driftTolerance);
}
