const RHO = 1.225; // kg/m³

export type CurveMode = "torque" | "power";

export interface PowerCurvePoint {
  x: number; // RPM (torque mode) or km/h (power mode)
  y: number; // Nm  (torque mode) or kW  (power mode)
}

export interface VehicleParams {
  mass: number;      // kg
  dragArea: number;  // CdA m²
  liftArea: number;  // ClA m², positive = downforce
  muLat: number;     // peak lateral friction coefficient
  muLon: number;     // peak longitudinal friction coefficient
  tyreDragK: number; // lateral-slip drag coefficient (0 = none, ~0.05 typical)
  curveMode: CurveMode;
  powerCurve: PowerCurvePoint[];
  // torque-mode only:
  finalDrive?: number;   // combined gear+diff ratio
  wheelRadius?: number;  // metres
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function aeroDownforce(p: VehicleParams, v: number): number {
  return 0.5 * RHO * p.liftArea * v * v;
}

function aeroDrag(p: VehicleParams, v: number): number {
  return 0.5 * RHO * p.dragArea * v * v;
}

function normalLoad(p: VehicleParams, v: number): number {
  return p.mass * 9.81 + aeroDownforce(p, v);
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

// Max traction force (N) from power curve at speed v (m/s).
function peakTractionForce(p: VehicleParams, v: number): number {
  if (p.curveMode === "torque") {
    const fd = p.finalDrive ?? 8.5;
    const wr = p.wheelRadius ?? 0.33;
    const rpm = (v / wr) * fd * (60 / (2 * Math.PI));
    const torque = interpCurve(p.powerCurve, rpm);
    return (torque * fd) / wr;
  } else {
    // power mode: curve is kW vs km/h
    const vKmh = v * 3.6;
    const kw = interpCurve(p.powerCurve, vKmh);
    return (kw * 1000) / Math.max(v, 1);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function maxLateralAccel(p: VehicleParams, v: number): number {
  return (p.muLat * normalLoad(p, v)) / p.mass;
}

// Fraction of longitudinal grip remaining given a lateral acceleration already used.
// Implements the friction circle: (aLat/aLatMax)² + (aLon/aLonMax)² ≤ 1
export function lonAvailFraction(p: VehicleParams, v: number, latAccel: number): number {
  const aLatMax = maxLateralAccel(p, v);
  if (aLatMax <= 0) return 1;
  const frac = Math.abs(latAccel) / aLatMax;
  return Math.sqrt(Math.max(0, 1 - frac * frac));
}

// Tyre-drag force from cornering slip (opposes forward motion).
function tyreDragForce(p: VehicleParams, v: number, latAccel: number): number {
  const aLatMax = maxLateralAccel(p, v);
  if (aLatMax <= 0) return 0;
  const latFrac = Math.abs(latAccel) / aLatMax;
  return p.tyreDragK * p.muLat * normalLoad(p, v) * latFrac;
}

export function maxLonAccel(p: VehicleParams, v: number, latAccel = 0): number {
  const tractionForce = peakTractionForce(p, v);
  const gripForce = p.muLon * normalLoad(p, v) * lonAvailFraction(p, v, latAccel);
  const drag = aeroDrag(p, v) + tyreDragForce(p, v, latAccel);
  return (Math.min(tractionForce, gripForce) - drag) / p.mass;
}

export function maxDecel(p: VehicleParams, v: number, latAccel = 0): number {
  const gripForce = p.muLon * normalLoad(p, v) * lonAvailFraction(p, v, latAccel);
  const drag = aeroDrag(p, v) + tyreDragForce(p, v, latAccel);
  // drag aids braking; tyre drag from cornering also reduces available braking
  return (gripForce + aeroDrag(p, v) - tyreDragForce(p, v, latAccel)) / p.mass;
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
