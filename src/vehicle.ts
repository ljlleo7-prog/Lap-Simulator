const RHO = 1.225; // kg/m³
const G = 9.81;

export type CurveMode = "torque" | "power";
export type DrivetrainLayout = "RWD" | "FWD" | "4WD";

export interface PowerCurvePoint {
  x: number; // RPM (torque mode) or km/h (power mode)
  y: number; // Nm  (torque mode) or kW  (power mode)
}

export interface VehicleParams {
  mass: number;           // kg
  dragArea: number;       // CdA m²
  liftArea: number;       // ClA m², positive = downforce
  muLat: number;          // peak lateral friction coefficient
  muLon: number;          // peak longitudinal friction coefficient
  tyreDragK: number;      // lateral-slip drag coefficient (0 = none, ~0.05 typical car, ~0.2 kart)
  curveMode: CurveMode;
  powerCurve: PowerCurvePoint[];
  // torque-mode only:
  finalDrive?: number;    // combined gear+diff ratio
  wheelRadius?: number;   // metres
  // chassis / drivetrain
  drivetrainLayout: DrivetrainLayout;
  brakeBias: number;      // front brake fraction 0–1 (0 = rear only, 0.6 = typical car)
  diffLockRear: number;   // rear diff lock 0–1 (1 = spool/solid axle like kart)
  diffLockFront: number;  // front diff lock 0–1
  weightDistFront: number; // static front weight fraction 0–1
  wheelbase: number;      // metres
  trackWidth: number;     // metres (average)
  cgHeight: number;       // centre of gravity height, metres
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function aeroDownforce(p: VehicleParams, v: number): number {
  return 0.5 * RHO * p.liftArea * v * v;
}

function aeroDrag(p: VehicleParams, v: number): number {
  return 0.5 * RHO * p.dragArea * v * v;
}

function totalNormalLoad(p: VehicleParams, v: number): number {
  return p.mass * G + aeroDownforce(p, v);
}

// ── Axle load split ───────────────────────────────────────────────────────────
// lonAccel > 0 = accelerating (weight shifts rearward), < 0 = braking (shifts forward).
export function axleLoads(p: VehicleParams, v: number, lonAccel = 0): [number, number] {
  const W = totalNormalLoad(p, v);
  const transfer = p.mass * lonAccel * p.cgHeight / p.wheelbase;
  const frontLoad = Math.max(0, p.weightDistFront * W - transfer);
  const rearLoad  = Math.max(0, (1 - p.weightDistFront) * W + transfer);
  return [frontLoad, rearLoad];
}

function drivenAxleLoad(p: VehicleParams, v: number, lonAccel: number): number {
  const [fL, rL] = axleLoads(p, v, lonAccel);
  if (p.drivetrainLayout === "RWD") return rL;
  if (p.drivetrainLayout === "FWD") return fL;
  return fL + rL;
}

// ── Braking grip ──────────────────────────────────────────────────────────────
// Rear-only braking (kart): lateral load transfer can unload the inside rear,
// reducing effective grip when cornering and braking simultaneously.
function brakingGripForce(p: VehicleParams, v: number, latAccel: number): number {
  const [fL, rL] = axleLoads(p, v, 0);
  const latTransfer = p.mass * Math.abs(latAccel) * p.cgHeight / Math.max(p.trackWidth, 0.1);
  // solid rear axle: inside rear unloads under lateral g, reducing rear brake grip
  const rearUnloadFactor = p.diffLockRear > 0.5
    ? Math.max(0.5, 1 - (latTransfer / Math.max(rL, 1)) * p.diffLockRear * 0.4)
    : 1;
  return p.brakeBias * fL * p.muLon + (1 - p.brakeBias) * rL * rearUnloadFactor * p.muLon;
}

// ── Tyre drag ─────────────────────────────────────────────────────────────────
// Derived from slip angle geometry rather than lateral G-force, so tight
// low-speed corners (large α, small aLat) produce the correct large drag.
//
// Bicycle model: α = atan(wheelbase / radius)
// Slip drag force = muLat · N · tyreDragK · sin(α)
// — the lateral force vector projects onto the longitudinal axis by sin(α).
// At high-speed large-radius corners α is small → small drag.
// At low-speed hairpins α is large (up to ~12° peak) → large drag.
// Cap α at peak_slip_angle (≈12° = 0.21 rad) beyond which the tyre is sliding
// and drag is dominated by kinetic friction (already captured by muLon).
const PEAK_SLIP_RAD = 0.21; // ~12°

function tyreDragForce(p: VehicleParams, v: number, r: number): number {
  if (r === Infinity || r <= 0) return 0;
  const L = p.wheelbase ?? 2.5;
  const alpha = Math.min(Math.atan(L / r), PEAK_SLIP_RAD);
  const N = totalNormalLoad(p, v);
  return p.tyreDragK * p.muLat * N * Math.sin(alpha);
}

// Solid-axle (spool/kart) scrub: inside rear tyre is forced to slip laterally.
// Scales with lateral load transfer squared — worst at tight corners.
function solidAxleScrub(p: VehicleParams, v: number, latAccel: number): number {
  if (p.diffLockRear < 0.5) return 0;
  const [, rL] = axleLoads(p, v, 0);
  const latTransfer = p.mass * Math.abs(latAccel) * p.cgHeight / Math.max(p.trackWidth, 0.1);
  const latFrac = Math.min(latTransfer / Math.max(rL, 1), 1);
  return p.diffLockRear * p.tyreDragK * rL * latFrac * latFrac;
}

// Linear interpolation on a sorted PowerCurvePoint array.
export function interpCurve(curve: PowerCurvePoint[], x: number): number {
  if (curve.length === 0) return 0;
  if (x <= curve[0].x) return curve[0].y;
  if (x >= curve[curve.length - 1].x) return curve[curve.length - 1].y;
  let lo = 0, hi = curve.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (curve[mid].x <= x) lo = mid; else hi = mid;
  }
  const t = (x - curve[lo].x) / (curve[hi].x - curve[lo].x);
  return curve[lo].y + t * (curve[hi].y - curve[lo].y);
}

function peakTractionForce(p: VehicleParams, v: number): number {
  if (p.curveMode === "torque") {
    const fd = p.finalDrive ?? 8.5;
    const wr = p.wheelRadius ?? 0.33;
    const rpm = (v / wr) * fd * (60 / (2 * Math.PI));
    const torque = interpCurve(p.powerCurve, rpm);
    return (torque * fd) / wr;
  } else {
    const vKmh = v * 3.6;
    const kw = interpCurve(p.powerCurve, vKmh);
    return (kw * 1000) / Math.max(v, 1);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

// maxLateralAccel now uses speed-dependent normal load (includes aero downforce).
export function maxLateralAccel(p: VehicleParams, v: number): number {
  return (p.muLat * totalNormalLoad(p, v)) / p.mass;
}

// Friction circle: fraction of longitudinal grip remaining given lateral accel used.
export function lonAvailFraction(p: VehicleParams, v: number, latAccel: number): number {
  const aLatMax = maxLateralAccel(p, v);
  if (aLatMax <= 0) return 1;
  const frac = Math.abs(latAccel) / aLatMax;
  return Math.sqrt(Math.max(0, 1 - frac * frac));
}

export function maxLonAccel(p: VehicleParams, v: number, latAccel = 0, r = Infinity): number {
  const tractionForce = peakTractionForce(p, v);
  const drivenLoad    = drivenAxleLoad(p, v, 1.0);
  const gripForce     = p.muLon * drivenLoad * lonAvailFraction(p, v, latAccel);
  const drag          = aeroDrag(p, v) + tyreDragForce(p, v, r) + solidAxleScrub(p, v, latAccel);
  return (Math.min(tractionForce, gripForce) - drag) / p.mass;
}

export function maxDecel(p: VehicleParams, v: number, latAccel = 0, r = Infinity): number {
  const brakeForce = brakingGripForce(p, v, latAccel) * lonAvailFraction(p, v, latAccel);
  const drag       = aeroDrag(p, v) + tyreDragForce(p, v, r) + solidAxleScrub(p, v, latAccel);
  return (brakeForce + drag) / p.mass;
}

// Derived peak power in kW (for display only).
export function derivedPeakPowerKw(p: VehicleParams): number {
  if (p.curveMode === "torque") {
    const fd = p.finalDrive ?? 8.5;
    const wr = p.wheelRadius ?? 0.33;
    return Math.max(...p.powerCurve.map(pt => pt.y * pt.x * Math.PI / 30 * fd / wr)) / 1000;
  } else {
    return Math.max(...p.powerCurve.map(pt => pt.y));
  }
}
