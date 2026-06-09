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
  lateralOffsets: Float64Array; // signed metres from requested path
  frontSlideRatios: Float64Array;
  rearSlideRatios: Float64Array;
  actualXs?: Float64Array;
  actualYs?: Float64Array;
  actualHeadings?: Float64Array;
  actualDistances?: Float64Array;
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

// Tolerance-aware corner speed for slide mode.
// driftTolerance ∈ [0,1]: fraction of half-width the car is allowed to drift.
// 0 → grip-mode speed limit; 1 → full half-width is free drift zone, no extra cap.
// For intermediate values the allowed lateral acceleration scales as:
//   aLat_max_slide = aLat_max_grip + (aLat_max_full_track - aLat_max_grip) * tolerance
// where aLat_max_full_track ≈ v² / r, limited by total available grip.
function cornerSpeedLimitSlide(params: VehicleParams, radius: number, driftTolerance: number): number {
  if (radius === Infinity) return Infinity;
  const r = Math.abs(radius);
  const utilization = lateralGripUtilization(params);
  // At tolerance 0: same grip-mode limit (car must stay on line).
  // At tolerance 1: allow mild over-grip so permissive mode can still drift.
  const maxUtil = 1.25;
  const effectiveUtil = utilization + (maxUtil - utilization) * driftTolerance;
  let lo = 0;
  let hi = 120;
  for (let i = 0; i < 8 && latAccelAt(hi, r) <= maxLateralAccel(params, hi) * effectiveUtil; i++) hi *= 1.5;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (latAccelAt(mid, r) <= maxLateralAccel(params, mid) * effectiveUtil) lo = mid;
    else hi = mid;
  }
  return lo;
}

function lateralLimitsSlide(params: VehicleParams, points: TrackPoint[], driftTolerance: number): Float64Array {
  const n = points.length;
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) v[i] = cornerSpeedLimitSlide(params, points[i].radius, driftTolerance);
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
  actualXs?: Float64Array,
  actualYs?: Float64Array,
  actualHeadings?: Float64Array,
  actualDistances?: Float64Array,
  actualLatAccels?: Float64Array,
  actualSegmentDistances?: Float64Array,
): SimResult {
  const n = points.length;
  const lonA = new Float64Array(n);
  const latA = new Float64Array(n);
  const sampleTimes = new Float64Array(n);
  const slideRatios = new Float64Array(n);
  let lapTime = 0;
  for (let i = 0; i < n - 1; i++) {
    const d = dx(points, i);
    const travelD = actualSegmentDistances?.[i] ?? (includeSliding ? effectiveTravelDistance(points, i, lateralOffsets) : d);
    const vAvg = (v[i] + v[i + 1]) / 2;
    lapTime += travelD / Math.max(vAvg, 0.01);
    sampleTimes[i + 1] = lapTime;
    lonA[i] = (v[i + 1] * v[i + 1] - v[i] * v[i]) / (2 * travelD);
    const r = points[i].radius;
    latA[i] = actualLatAccels?.[i] ?? (r === Infinity ? 0 : (v[i] * v[i]) / r);
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
  return { lapTime, sampleTimes, speeds: v, lonAccels: lonA, latAccels: latA, slideRatios, lateralOffsets, frontSlideRatios, rearSlideRatios, actualXs, actualYs, actualHeadings, actualDistances };
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

function angleNorm(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function pointHalfWidth(points: TrackPoint[], halfWidths: Float64Array | undefined, i: number): number {
  const hw = points[i]?.halfWidth ?? halfWidths?.[i];
  return hw && hw > 0 ? hw : Infinity;
}

interface ResolvedPath {
  x: Float64Array;
  y: Float64Array;
  heading: Float64Array;
}

function resolvePathGeometry(points: TrackPoint[]): ResolvedPath {
  const n = points.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const heading = new Float64Array(n);
  if (points.every(p => p.x !== undefined && p.y !== undefined && p.tangentAngle !== undefined)) {
    for (let i = 0; i < n; i++) {
      x[i] = points[i].x!;
      y[i] = points[i].y!;
      heading[i] = points[i].tangentAngle!;
    }
    return { x, y, heading };
  }

  heading[0] = points[0]?.tangentAngle ?? 0;
  for (let i = 0; i < n - 1; i++) {
    const d = dx(points, i);
    const k = signedCurvature(points[i].radius);
    const hMid = heading[i] + k * d * 0.5;
    x[i + 1] = x[i] + Math.cos(hMid) * d;
    y[i + 1] = y[i] + Math.sin(hMid) * d;
    heading[i + 1] = angleNorm(heading[i] + k * d);
  }
  return { x, y, heading };
}

interface CoordinateSlideState {
  lateralOffsets: Float64Array;
  frontSlideRatios: Float64Array;
  rearSlideRatios: Float64Array;
  actualXs: Float64Array;
  actualYs: Float64Array;
  actualHeadings: Float64Array;
  actualDistances: Float64Array;
  actualLatAccels: Float64Array;
  actualSegmentDistances: Float64Array;
}

function solveCoordinateSlideProfile(
  params: VehicleParams,
  points: TrackPoint[],
  v: Float64Array,
  entrySpeed: number,
  exitSpeed: number,
  halfWidths?: Float64Array,
  driftTolerance = 0.18,
): CoordinateSlideState {
  const n = points.length;
  const ref = resolvePathGeometry(points);
  const lateralOffsets = new Float64Array(n);
  const frontSlideRatios = new Float64Array(n);
  const rearSlideRatios = new Float64Array(n);
  const actualXs = new Float64Array(n);
  const actualYs = new Float64Array(n);
  const actualHeadings = new Float64Array(n);
  const actualDistances = new Float64Array(n);
  const actualLatAccels = new Float64Array(n);
  const actualSegmentDistances = new Float64Array(n);

  let x = ref.x[0];
  let y = ref.y[0];
  let heading = ref.heading[0];
  actualXs[0] = x;
  actualYs[0] = y;
  actualHeadings[0] = heading;

  v[0] = Math.min(v[0], entrySpeed);
  for (let i = 0; i < n - 1; i++) {
    const dRef = Math.max(dx(points, i), 0.01);
    const v0 = Math.max(v[i], 0.5);
    const refHeading = ref.heading[i];
    const refNextHeading = ref.heading[i + 1];
    const refK = signedCurvature(points[i].radius);
    const nx = -Math.sin(refHeading);
    const ny = Math.cos(refHeading);
    const crossTrack = (x - ref.x[i]) * nx + (y - ref.y[i]) * ny;
    const headingError = angleNorm(heading - refHeading);
    const halfWidth = pointHalfWidth(points, halfWidths, i);
    const toleranceDistance = driftToleranceDistance(halfWidth, driftTolerance);
    const correctionK = Math.max(-0.08, Math.min(0.08, -crossTrack * 0.025 - headingError * 0.22));
    const demandK = refK + correctionK;
    const demandLat = v0 * v0 * demandK;
    const axleState = axleLateralGripState(params, v0, demandLat);
    const gripState = lateralGripState(params, v0, demandLat);
    const frontExcess = axleState.frontKineticExcessRatio;
    const rearExcess = axleState.rearKineticExcessRatio;
    const maxLat = maxLateralAccel(params, v0);
    const understeer = frontExcess > rearExcess * 1.05;
    const oversteer = rearExcess > frontExcess * 1.05;
    let actualLat = Math.max(-maxLat, Math.min(maxLat, demandLat));
    if (gripState.kineticExcessRatio > 0) {
      const kineticLat = maxLat / (1 + gripState.kineticExcessRatio * 0.9);
      actualLat = Math.max(-kineticLat, Math.min(kineticLat, demandLat));
      if (understeer) actualLat *= 0.78;
      if (oversteer) actualLat += Math.sign(demandLat || refK || 1) * maxLat * Math.min(rearExcess, 1.5) * 0.18;
    }
    const actualK = actualLat / Math.max(v0 * v0, 0.25);
    const dt = dRef / v0;
    const nextHeading = angleNorm(heading + actualK * dRef);
    const hMid = heading + angleNorm(nextHeading - heading) * 0.5;
    const xNext = x + Math.cos(hMid) * dRef;
    const yNext = y + Math.sin(hMid) * dRef;
    const travelD = Math.max(0.01, Math.hypot(xNext - x, yNext - y));
    const nextNx = -Math.sin(refNextHeading);
    const nextNy = Math.cos(refNextHeading);
    const nextCrossTrack = (xNext - ref.x[i + 1]) * nextNx + (yNext - ref.y[i + 1]) * nextNy;
    const offTrackRatio = Math.max(0, Math.abs(nextCrossTrack) - halfWidth) / Math.max(halfWidth, 1);
    // Guard loss only applies when car is actually off-track or when the next segment
    // demands grip that cross-track recovery will consume. Pure on-track offset on a
    // straight causes no braking — the steering correction handles recovery.
    const excessDrift = Math.max(0, Math.abs(nextCrossTrack) - toleranceDistance);
    const excessDriftRatio = offTrackRatio > 0
      ? 0  // handled by offTrackRatio already
      : excessDrift / Math.max(toleranceDistance + halfWidth * 0.5, 0.1);
    const nextRefK = Math.abs(signedCurvature(points[Math.min(i + 1, n - 1)].radius));
    const cornering = nextRefK > 0.005; // next segment has meaningful curvature
    const scrubLoss = driftPenaltyAccel(params, v0, demandLat, points[i].radius) * Math.min(0.35, 0.08 + gripState.kineticExcessRatio * 0.08);
    const guardLoss = cornering
      ? excessDriftRatio * excessDriftRatio * 0.4 * Math.max(maxDecel(params, v0, Math.abs(actualLat), points[i].radius), 1)
      : 0;
    const offTrackLoss = offTrackRatio * offTrackRatio * 3.5 * Math.max(maxDecel(params, v0, Math.abs(actualLat), points[i].radius), 1);
    const transientDrag = transientDragAccel(params, v0, points[i].radius, points[i + 1].radius, dRef);
    const driveAccel = maxLonAccel(params, v0, Math.abs(actualLat), points[i].radius) - transientDrag - scrubLoss - guardLoss - offTrackLoss;
    // Speed floor: never brake to zero due to offset alone; off-track is the only hard limiter.
    const vFloor = offTrackRatio > 0 ? 0.36 : Math.max(0.36, v0 * 0.5);
    const vNext = Math.sqrt(Math.max(vFloor * vFloor, v0 * v0 + 2 * driveAccel * travelD));

    v[i + 1] = Math.min(v[i + 1], vNext);
    lateralOffsets[i] = crossTrack;
    lateralOffsets[i + 1] = nextCrossTrack;
    frontSlideRatios[i] = axleState.frontSlideRatio;
    rearSlideRatios[i] = axleState.rearSlideRatio;
    actualLatAccels[i] = actualLat;
    actualSegmentDistances[i] = travelD;
    actualDistances[i + 1] = actualDistances[i] + travelD;
    actualXs[i + 1] = xNext;
    actualYs[i + 1] = yNext;
    actualHeadings[i + 1] = nextHeading;
    x = xNext;
    y = yNext;
    heading = nextHeading;
  }

  v[n - 1] = Math.min(v[n - 1], exitSpeed);
  actualLatAccels[n - 1] = actualLatAccels[n - 2] ?? 0;
  frontSlideRatios[n - 1] = frontSlideRatios[n - 2] ?? 0;
  rearSlideRatios[n - 1] = rearSlideRatios[n - 2] ?? 0;
  actualSegmentDistances[n - 1] = actualSegmentDistances[n - 2] ?? 0;
  return { lateralOffsets, frontSlideRatios, rearSlideRatios, actualXs, actualYs, actualHeadings, actualDistances, actualLatAccels, actualSegmentDistances };
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

  const vForm = lateralLimitsSlide(params, points, driftTolerance);
  solveSpeedProfile(params, points, vForm, 1, Infinity);
  solveCoordinateSlideProfile(params, points, vForm, 1, Infinity, halfWidths, driftTolerance);
  const entrySpeed = vForm[n - 1];

  const vHot = lateralLimitsSlide(params, points, driftTolerance);
  solveSpeedProfile(params, points, vHot, entrySpeed, Infinity);
  solveCoordinateSlideProfile(params, points, vHot, entrySpeed, Infinity, halfWidths, driftTolerance);

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
  const vWrap = lateralLimitsSlide(params, wPts, driftTolerance);
  vWrap[0] = Math.min(vWrap[0], vHot[startIdx]);
  solveSpeedProfile(params, wPts, vWrap, vHot[startIdx], Infinity);
  solveCoordinateSlideProfile(params, wPts, vWrap, vHot[startIdx], Infinity, undefined, driftTolerance);
  const exitSpeed = vWrap[LOOK - 1];

  const vFinal = lateralLimitsSlide(params, points, driftTolerance);
  solveSpeedProfile(params, points, vFinal, entrySpeed, exitSpeed);
  const slideState = solveCoordinateSlideProfile(params, points, vFinal, entrySpeed, exitSpeed, halfWidths, driftTolerance);

  return buildResult(
    params,
    points,
    vFinal,
    true,
    slideState.lateralOffsets,
    slideState.frontSlideRatios,
    slideState.rearSlideRatios,
    slideState.actualXs,
    slideState.actualYs,
    slideState.actualHeadings,
    slideState.actualDistances,
    slideState.actualLatAccels,
    slideState.actualSegmentDistances,
  );
}

export function simulateHotLap(params: VehicleParams, points: TrackPoint[], halfWidths?: Float64Array, driftTolerance = 0.18): SimResult {
  return simulateDriftAwareHotLap(params, points, halfWidths, driftTolerance);
}
