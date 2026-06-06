export interface VehicleParams {
  mass: number;       // kg
  peakPower: number;  // W
  dragArea: number;   // CdA m²
  liftArea: number;   // ClA m², positive = downforce
  muLat: number;      // peak lateral friction coefficient
  muLon: number;      // peak longitudinal friction coefficient
}

const RHO = 1.225; // kg/m³

function aeroDownforce(params: VehicleParams, v: number): number {
  return 0.5 * RHO * params.liftArea * v * v;
}

function aeroDrag(params: VehicleParams, v: number): number {
  return 0.5 * RHO * params.dragArea * v * v;
}

function normalLoad(params: VehicleParams, v: number): number {
  return params.mass * 9.81 + aeroDownforce(params, v);
}

export function maxLateralAccel(params: VehicleParams, v: number): number {
  return (params.muLat * normalLoad(params, v)) / params.mass;
}

export function maxLonAccel(params: VehicleParams, v: number): number {
  const tractionForce = v > 0 ? params.peakPower / v : Infinity;
  const gripForce = params.muLon * normalLoad(params, v);
  return (Math.min(tractionForce, gripForce) - aeroDrag(params, v)) / params.mass;
}

export function maxDecel(params: VehicleParams, v: number): number {
  return (params.muLon * normalLoad(params, v) + aeroDrag(params, v)) / params.mass;
}
