import { describe, it, expect } from "vitest";
import { maxLateralAccel, maxLonAccel, maxDecel, steerAngleForRadius, steeringTransitionDragForce } from "./vehicle.js";
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
  yawInertia: 900,
  steeringLockDeg: 32,
  corneringStiffnessFront: 70000,
  corneringStiffnessRear: 80000,
  yawDragK: 0.15,
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

  it("drops with higher aero drag at high speed", () => {
    expect(maxLonAccel({ ...car, dragArea: 1.8 }, 55)).toBeLessThan(maxLonAccel(car, 55));
  });

  it("keeps tiny lateral-g steering drag small", () => {
    const v = 18;
    const straight = maxLonAccel(car, v, 0, Infinity);
    const slightTurn = maxLonAccel(car, v, 0.08 * 9.81, 200);

    expect(straight - slightTurn).toBeLessThan(0.15);
  });

  it("drops more from tyre drag in a loaded corner than on a straight", () => {
    const r = 18;
    const v = 12;
    const aLat = (v * v) / r;
    const lowDragCorner = maxLonAccel({ ...car, tyreDragK: 0.02 }, v, aLat, r);
    const highDragCorner = maxLonAccel({ ...car, tyreDragK: 0.2 }, v, aLat, r);
    const lowDragStraight = maxLonAccel({ ...car, tyreDragK: 0.02 }, v, 0, Infinity);
    const highDragStraight = maxLonAccel({ ...car, tyreDragK: 0.2 }, v, 0, Infinity);

    expect(lowDragCorner - highDragCorner).toBeGreaterThan((lowDragStraight - highDragStraight) + 0.05);
  });

  it("is symmetric for left and right turns", () => {
    const v = 18;
    const r = 25;
    const aLat = (v * v) / r;
    expect(maxLonAccel(car, v, aLat, -r)).toBeCloseTo(maxLonAccel(car, v, aLat, r), 10);
    expect(steerAngleForRadius(car, -r)).toBeCloseTo(steerAngleForRadius(car, r), 10);
  });
});

describe("maxDecel", () => {
  it("is greater than maxLonAccel at high speed (aero drag aids braking)", () => {
    expect(maxDecel(car, 70)).toBeGreaterThan(maxLonAccel(car, 70));
  });

  it("is reduced while cornering because lateral load consumes friction capacity", () => {
    const straightDecel = maxDecel(car, 30, 0, Infinity);
    const cornerDecel = maxDecel(car, 30, maxLateralAccel(car, 30) * 0.7, 70);
    expect(cornerDecel).toBeLessThan(straightDecel);
  });
});

describe("steeringTransitionDragForce", () => {
  it("penalizes steering reversal more than smooth constant turning", () => {
    const smooth = steeringTransitionDragForce(car, 18, 30, 30, 3);
    const reversal = steeringTransitionDragForce(car, 18, 30, -30, 3);
    expect(reversal).toBeGreaterThan(smooth);
  });
});
