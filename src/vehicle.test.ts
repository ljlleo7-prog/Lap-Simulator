import { describe, it, expect } from "vitest";
import { maxLateralAccel, maxLonAccel, maxDecel } from "./vehicle.js";
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
  powerCurve: [
    { x: 2000, y: 300 },
    { x: 6000, y: 420 },
    { x: 12000, y: 250 },
  ],
};

describe("maxLateralAccel", () => {
  it("increases with speed due to downforce", () => {
    expect(maxLateralAccel(car, 50)).toBeGreaterThan(maxLateralAccel(car, 0));
  });

  it("is positive at rest", () => {
    expect(maxLateralAccel(car, 0)).toBeGreaterThan(0);
  });
});

describe("maxLonAccel", () => {
  it("is positive at low speed (traction-limited)", () => {
    expect(maxLonAccel(car, 5)).toBeGreaterThan(0);
  });

  it("decreases at high speed (power-limited)", () => {
    expect(maxLonAccel(car, 10)).toBeGreaterThan(maxLonAccel(car, 60));
  });
});

describe("maxDecel", () => {
  it("is greater than maxLonAccel at high speed (aero drag aids braking)", () => {
    expect(maxDecel(car, 70)).toBeGreaterThan(maxLonAccel(car, 70));
  });

  it("is positive", () => {
    expect(maxDecel(car, 30)).toBeGreaterThan(0);
  });
});
