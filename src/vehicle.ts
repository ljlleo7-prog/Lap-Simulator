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
  kineticGripRatio?: number; // sliding grip multiplier relative to static peak
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
  yawInertia: number;     // kg·m²
  steeringLockDeg: number; // max front wheel steer angle
  corneringStiffnessFront: number; // N/rad
  corneringStiffnessRear: number;  // N/rad
  yawDragK: number;       // yaw inertia drag scale
}

const DEFAULT_PARAMS: VehicleParams = {
  mass: 700, dragArea: 0.9, liftArea: 3.0,
  muLat: 1.8, muLon: 1.8, kineticGripRatio: 0.8, tyreDragK: 0.05,
  curveMode: "torque", finalDrive: 8.5, wheelRadius: 0.33,
  drivetrainLayout: "RWD", brakeBias: 0.6, diffLockRear: 0, diffLockFront: 0,
  weightDistFront: 0.45, wheelbase: 2.5, trackWidth: 1.8, cgHeight: 0.35,
  yawInertia: 900, steeringLockDeg: 32,
  corneringStiffnessFront: 70000, corneringStiffnessRear: 80000, yawDragK: 0.15,
  powerCurve: [{ x: 2000, y: 300 }, { x: 6000, y: 420 }, { x: 12000, y: 250 }],
};

function params(p: VehicleParams | Partial<VehicleParams> | undefined): VehicleParams {
  return { ...DEFAULT_PARAMS, ...(p ?? {}) } as VehicleParams;
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
export function axleLoads(raw: VehicleParams, v: number, lonAccel = 0): [number, number] {
  const p = params(raw);
  const W = totalNormalLoad(p, v);
  const transfer = p.mass * lonAccel * p.cgHeight / p.wheelbase;
  const frontLoad = Math.max(0, p.weightDistFront * W - transfer);
  const rearLoad  = Math.max(0, (1 - p.weightDistFront) * W + transfer);
  return [frontLoad, rearLoad];
}

function drivenAxleLoadFromLoads(p: VehicleParams, frontLoad: number, rearLoad: number): number {
  if (p.drivetrainLayout === "RWD") return rearLoad;
  if (p.drivetrainLayout === "FWD") return frontLoad;
  return frontLoad + rearLoad;
}

function drivenAxleLoad(p: VehicleParams, v: number, lonAccel: number): number {
  const [fL, rL] = axleLoads(p, v, lonAccel);
  return drivenAxleLoadFromLoads(p, fL, rL);
}

// ── Braking grip ──────────────────────────────────────────────────────────────
// Rear-only braking (kart): lateral load transfer can unload the inside rear,
// reducing effective grip when cornering and braking simultaneously.
function brakingGripForceFromLoads(p: VehicleParams, frontLoad: number, rearLoad: number, latAccel: number): number {
  const latTransfer = p.mass * Math.abs(latAccel) * p.cgHeight / Math.max(p.trackWidth, 0.1);
  const rearUnloadFactor = p.diffLockRear > 0.5
    ? Math.max(0.5, 1 - (latTransfer / Math.max(rearLoad, 1)) * p.diffLockRear * 0.4)
    : 1;
  return p.brakeBias * frontLoad * p.muLon + (1 - p.brakeBias) * rearLoad * rearUnloadFactor * p.muLon;
}

function brakingGripForce(p: VehicleParams, v: number, latAccel: number, lonAccel: number): number {
  const [fL, rL] = axleLoads(p, v, lonAccel);
  return brakingGripForceFromLoads(p, fL, rL, latAccel);
}

// Bicycle-model projection drag: when the front tyres generate lateral force at
// steer angle α, part of that force opposes longitudinal motion by tan(α).
const PEAK_SLIP_RAD = 0.21; // ~12°

function tyreDragForce(p: VehicleParams, latAccel: number, r: number): number {
  if (r === Infinity || r === 0 || latAccel === 0) return 0;
  const steer = Math.min(steerAngleForRadius(p, r), PEAK_SLIP_RAD);
  const frontShare = Math.max(0.25, Math.min(0.75, p.weightDistFront));
  const lateralForce = p.mass * Math.abs(latAccel) * frontShare;
  return p.tyreDragK * lateralForce * Math.abs(Math.tan(steer));
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

function curvatureMagnitudeRadius(r: number): number {
  return Math.abs(r);
}

export function steerAngleForRadius(raw: VehicleParams, r: number): number {
  const p = params(raw);
  if (r === Infinity || r === 0) return 0;
  return Math.atan(p.wheelbase / curvatureMagnitudeRadius(r));
}

export function steeringExcessDragForce(raw: VehicleParams, v: number, r: number): number {
  const p = params(raw);
  if (r === Infinity || r === 0) return 0;
  const maxSteer = (p.steeringLockDeg * Math.PI) / 180;
  const excess = Math.max(0, steerAngleForRadius(p, r) / Math.max(maxSteer, 1e-6) - 1);
  return excess * excess * p.muLat * totalNormalLoad(p, v) * 0.25;
}

export function corneringComplianceDragForce(raw: VehicleParams, v: number, latAccel: number, r: number): number {
  const p = params(raw);
  if (r === Infinity || r === 0 || latAccel === 0) return 0;
  const alpha = steerAngleForRadius(p, r);
  const latForce = p.mass * Math.abs(latAccel);
  const latCapacity = p.muLat * totalNormalLoad(p, v);
  const utilization = Math.min(1, latForce / Math.max(latCapacity, 1));
  const [fL, rL] = axleLoads(p, v, 0);
  const fForce = latForce * p.weightDistFront;
  const rForce = latForce * (1 - p.weightDistFront);
  const fSlip = fForce / Math.max(p.corneringStiffnessFront * alpha, 1);
  const rSlip = rForce / Math.max(p.corneringStiffnessRear * alpha, 1);
  const compliance = Math.max(0, (fSlip * fL + rSlip * rL) / Math.max(fL + rL, 1) - 1);
  return compliance * utilization * utilization * p.tyreDragK * latForce * Math.abs(Math.tan(alpha));
}

export function steeringTransitionDragForce(raw: VehicleParams, v: number, r0: number, r1: number, ds: number): number {
  const p = params(raw);
  const k0 = r0 === Infinity ? 0 : 1 / r0;
  const k1 = r1 === Infinity ? 0 : 1 / r1;
  const steer0 = Math.atan(p.wheelbase * k0);
  const steer1 = Math.atan(p.wheelbase * k1);
  const dSteerDs = (steer1 - steer0) / Math.max(ds, 0.01);
  const dBearingDs = (k1 - k0) / Math.max(ds, 0.01);
  const reversal = k0 * k1 < 0 ? Math.min(Math.abs(k1 - k0) * p.wheelbase, 0.5) : 0;
  const normalLoad = totalNormalLoad(p, v);
  const rateLoss = (dSteerDs * dSteerDs * p.wheelbase * 2500 + dBearingDs * dBearingDs * p.wheelbase * 800) * normalLoad;
  return p.tyreDragK * (1 + p.diffLockRear) * rateLoss * Math.max(v, 1) + reversal * p.muLat * normalLoad * p.tyreDragK * 8.0;
}

export function yawInertiaDragForce(raw: VehicleParams, v: number, r0: number, r1: number, ds: number): number {
  const p = params(raw);
  if (!Number.isFinite(r0) && !Number.isFinite(r1)) return 0;
  const k0 = r0 === Infinity ? 0 : 1 / r0;
  const k1 = r1 === Infinity ? 0 : 1 / r1;
  const yawAccel = v * v * Math.abs(k1 - k0) / Math.max(ds, 0.01);
  const yawTorque = p.yawInertia * yawAccel;
  return p.yawDragK * yawTorque / Math.max(p.wheelbase, 0.1);
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
export function maxLateralAccel(raw: VehicleParams, v: number): number {
  const p = params(raw);
  return (p.muLat * totalNormalLoad(p, v)) / p.mass;
}

export interface LateralGripState {
  demand: number;
  staticLimit: number;
  kineticLimit: number;
  slideRatio: number;
  kineticExcessRatio: number;
}

export function maxKineticLateralAccel(raw: VehicleParams, v: number): number {
  const p = params(raw);
  const ratio = Math.max(0.1, Math.min(1, p.kineticGripRatio ?? 0.8));
  return maxLateralAccel(p, v) * ratio;
}

export function lateralGripState(raw: VehicleParams, v: number, latAccelDemand: number): LateralGripState {
  const demand = Math.abs(latAccelDemand);
  const staticLimit = maxLateralAccel(raw, v);
  const kineticLimit = maxKineticLateralAccel(raw, v);
  const slideRatio = Math.max(0, demand / Math.max(staticLimit, 1e-6) - 1);
  const kineticExcessRatio = Math.max(0, demand / Math.max(kineticLimit, 1e-6) - 1);
  return { demand, staticLimit, kineticLimit, slideRatio, kineticExcessRatio };
}

export function driftAuthorityFactor(raw: VehicleParams, v: number, latAccelDemand: number): number {
  const state = lateralGripState(raw, v, latAccelDemand);
  if (state.slideRatio <= 0) return 1;
  return Math.max(0.08, 1 / (1 + 8 * state.slideRatio * state.slideRatio + 4 * state.kineticExcessRatio));
}

export function driftPenaltyAccel(raw: VehicleParams, v: number, latAccelDemand: number, r: number): number {
  if (r === Infinity || r === 0) return 0;
  const state = lateralGripState(raw, v, latAccelDemand);
  if (state.slideRatio <= 0) return 0;
  const slipSeverity = state.slideRatio + 2.5 * state.kineticExcessRatio;
  return state.staticLimit * (0.08 * state.slideRatio + 0.28 * slipSeverity * slipSeverity);
}

// Friction circle: fraction of longitudinal grip remaining given lateral accel used.
export function lonAvailFraction(raw: VehicleParams, v: number, latAccel: number): number {
  const p = params(raw);
  const aLatMax = maxLateralAccel(p, v);
  if (aLatMax <= 0) return 1;
  const frac = Math.abs(latAccel) / aLatMax;
  return Math.sqrt(Math.max(0, 1 - frac * frac));
}

function parasiticTireLossForce(p: VehicleParams, v: number, latAccel: number, r: number): number {
  return tyreDragForce(p, latAccel, r)
    + steeringExcessDragForce(p, v, r)
    + corneringComplianceDragForce(p, v, latAccel, r)
    + solidAxleScrub(p, v, latAccel);
}

export function maxLonAccel(raw: VehicleParams, v: number, latAccel = 0, r = Infinity): number {
  const p = params(raw);
  const tractionForce = peakTractionForce(p, v);
  const externalDrag = aeroDrag(p, v);
  const tyreLoss = parasiticTireLossForce(p, v, latAccel, r);
  let accel = Math.max(0, (Math.min(tractionForce, p.muLon * drivenAxleLoad(p, v, 0)) - tyreLoss - externalDrag) / p.mass);

  for (let i = 0; i < 3; i++) {
    const [fL, rL] = axleLoads(p, v, accel);
    const drivenLoad = drivenAxleLoadFromLoads(p, fL, rL);
    const gripForce = p.muLon * drivenLoad * lonAvailFraction(p, v, latAccel);
    const usableDrive = Math.max(0, Math.min(tractionForce, gripForce) - tyreLoss);
    accel = (usableDrive - externalDrag) / p.mass;
  }

  return accel;
}

export function maxDecel(raw: VehicleParams, v: number, latAccel = 0, r = Infinity): number {
  const p = params(raw);
  const externalDrag = aeroDrag(p, v);
  let decel = (brakingGripForce(p, v, latAccel, 0) * lonAvailFraction(p, v, latAccel) + externalDrag) / p.mass;

  for (let i = 0; i < 3; i++) {
    const brakeForce = brakingGripForce(p, v, latAccel, -decel) * lonAvailFraction(p, v, latAccel);
    decel = (brakeForce + externalDrag) / p.mass;
  }

  return decel;
}

// Derived peak power in kW (for display only).
export function derivedPeakPowerKw(raw: VehicleParams): number {
  const p = params(raw);
  if (p.curveMode === "torque") {
    const fd = p.finalDrive ?? 8.5;
    const wr = p.wheelRadius ?? 0.33;
    return Math.max(...p.powerCurve.map(pt => pt.y * pt.x * Math.PI / 30 * fd / wr)) / 1000;
  } else {
    return Math.max(...p.powerCurve.map(pt => pt.y));
  }
}
