import { VehicleParams, maxLateralAccel, maxLonAccel, maxDecel } from "./vehicle.js";
import { TrackPoint } from "./track.js";

export interface SimResult {
  lapTime: number;        // seconds
  speeds: Float64Array;   // m/s at each track point
  lonAccels: Float64Array; // m/s² (positive = accel, negative = brake)
  latAccels: Float64Array; // m/s²
}

export function simulate(params: VehicleParams, points: TrackPoint[]): SimResult {
  const n = points.length;
  const v = new Float64Array(n);
  const lonA = new Float64Array(n);
  const latA = new Float64Array(n);

  // Step 1: corner-speed limit from lateral grip
  for (let i = 0; i < n; i++) {
    const r = points[i].radius;
    const vLat = r === Infinity ? Infinity : Math.sqrt(maxLateralAccel(params, 0) * r);
    v[i] = vLat;
  }

  function dx(i: number): number {
    if (i + 1 >= n) return points[i].distance - points[i - 1].distance;
    return points[i + 1].distance - points[i].distance;
  }

  // Step 2: forward pass — apply acceleration limit
  v[0] = Math.min(v[0], 1); // start from near-zero
  for (let i = 0; i < n - 1; i++) {
    const aMax = maxLonAccel(params, v[i]);
    const d = dx(i);
    const vNext = Math.sqrt(Math.max(0, v[i] * v[i] + 2 * aMax * d));
    v[i + 1] = Math.min(v[i + 1], vNext);
  }

  // Step 3: backward pass — apply braking limit
  for (let i = n - 2; i >= 0; i--) {
    const bMax = maxDecel(params, v[i + 1]);
    const d = dx(i);
    const vPrev = Math.sqrt(Math.max(0, v[i + 1] * v[i + 1] + 2 * bMax * d));
    v[i] = Math.min(v[i], vPrev);
  }

  // Step 4: compute accelerations and lap time
  let lapTime = 0;
  for (let i = 0; i < n - 1; i++) {
    const d = dx(i);
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
