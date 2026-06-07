import { describe, it, expect } from "vitest";
import { simulate } from "./integrator.js";
import { buildTrackProfile } from "./track.js";
import type { VehicleParams } from "./vehicle.js";

const car: VehicleParams = {
  mass: 700,
  dragArea: 0.9,
  liftArea: 3.0,
  muLat: 1.8,
  muLon: 1.8,
  tyreDragK: 0.05,
  curveMode: "torque",
  finalDrive: 8.5,
  wheelRadius: 0.33,
  drivetrainLayout: "RWD",
  brakeBias: 0.6,
  diffLockRear: 0.0,
  diffLockFront: 0.0,
  weightDistFront: 0.45,
  wheelbase: 2.5,
  trackWidth: 1.8,
  cgHeight: 0.35,
  powerCurve: [
    { x: 2000, y: 300 },
    { x: 6000, y: 420 },
    { x: 12000, y: 250 },
  ],
};

const ovalTrack = buildTrackProfile([
  { length: 500, radius: Infinity },
  { length: 157, radius: 50 },  // ~180° at r=50
  { length: 500, radius: Infinity },
  { length: 157, radius: 50 },
]);

describe("simulate", () => {
  it("returns a positive lap time", () => {
    const result = simulate(car, ovalTrack);
    expect(result.lapTime).toBeGreaterThan(0);
  });

  it("speed array length matches track points", () => {
    const result = simulate(car, ovalTrack);
    expect(result.speeds.length).toBe(ovalTrack.length);
  });

  it("all speeds are non-negative", () => {
    const result = simulate(car, ovalTrack);
    expect(Array.from(result.speeds).every((v) => v >= 0)).toBe(true);
  });

  it("corner speeds are lower than straight speeds", () => {
    const result = simulate(car, ovalTrack);
    const cornerPts = ovalTrack
      .map((p, i) => ({ i, r: p.radius }))
      .filter((p) => p.r < Infinity);
    const straightPts = ovalTrack
      .map((p, i) => ({ i, r: p.radius }))
      .filter((p) => p.r === Infinity);

    const avgCornerSpeed =
      cornerPts.reduce((s, p) => s + result.speeds[p.i], 0) / cornerPts.length;
    const avgStraightSpeed =
      straightPts.reduce((s, p) => s + result.speeds[p.i], 0) / straightPts.length;

    expect(avgCornerSpeed).toBeLessThan(avgStraightSpeed);
  });

  it("lap time is physically plausible (20s–120s for ~1.3 km track)", () => {
    const result = simulate(car, ovalTrack);
    expect(result.lapTime).toBeGreaterThan(20);
    expect(result.lapTime).toBeLessThan(120);
  });
});
