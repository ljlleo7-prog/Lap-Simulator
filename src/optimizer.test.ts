import { describe, expect, it } from "vitest";
import { simulateHotLap } from "./integrator.js";
import { offsetsToTrackPoints, fitness, lapTimeForOffsets } from "./optimizer.js";

describe("offsetsToTrackPoints", () => {
  it("keeps small visual steering curvature instead of clamping it away", () => {
    const n = 80;
    const offsets = new Float64Array(n);
    const hw = new Float64Array(n).fill(4);
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    const tangents = new Float64Array(n);

    for (let i = 0; i < n; i++) {
      xs[i] = i * 5;
      ys[i] = 0;
      offsets[i] = Math.sin((i / n) * Math.PI * 2) * 0.01;
    }

    const points = offsetsToTrackPoints(offsets, hw, xs, ys, tangents);
    const finite = points.filter(p => p.radius < Infinity);

    expect(finite.length).toBeGreaterThan(0);
    expect(Math.min(...finite.map(p => Math.abs(p.radius)))).toBeGreaterThan(1000);
  });

  it("keeps optimizer fitness aligned with simulated lap time", () => {
    const n = 260;
    const offsets = new Float64Array(n);
    const hw = new Float64Array(n).fill(4);
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    const tangents = new Float64Array(n);
    const vehicle = {
      mass: 200,
      dragArea: 0.38,
      liftArea: 0,
      muLat: 0.95,
      muLon: 0.95,
      tyreDragK: 0.28,
      curveMode: "power" as const,
      finalDrive: 10,
      wheelRadius: 0.215,
      drivetrainLayout: "RWD" as const,
      brakeBias: 0,
      diffLockRear: 1,
      diffLockFront: 0,
      weightDistFront: 0.42,
      wheelbase: 1.05,
      trackWidth: 1.35,
      cgHeight: 0.29,
      yawInertia: 42,
      steeringLockDeg: 34,
      corneringStiffnessFront: 7000,
      corneringStiffnessRear: 9500,
      yawDragK: 0.45,
      powerCurve: [{ x: 0, y: 2.5 }, { x: 20, y: 4.2 }, { x: 35, y: 4.8 }, { x: 50, y: 4.5 }, { x: 60, y: 3.5 }, { x: 70, y: 1.5 }],
    };

    for (let i = 0; i < n; i++) {
      const theta = (i / n) * Math.PI * 2;
      xs[i] = 80 * Math.cos(theta);
      ys[i] = 80 * Math.sin(theta);
      tangents[i] = theta + Math.PI / 2;
      offsets[i] = Math.sin(theta * 24) * 0.08;
    }

    const points = offsetsToTrackPoints(offsets, hw, xs, ys, tangents);
    expect(fitness(offsets, vehicle, hw, xs, ys, tangents)).toBeCloseTo(simulateHotLap(vehicle, points, hw).lapTime, 8);
    expect(fitness(offsets, vehicle, hw, xs, ys, tangents)).toBeCloseTo(lapTimeForOffsets(offsets, vehicle, hw, xs, ys, tangents), 8);
  });

  it("reflects visible steering wobble in the lateral-g profile", () => {
    const n = 260;
    const smooth = new Float64Array(n);
    const wobble = new Float64Array(n);
    const hw = new Float64Array(n).fill(4);
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    const tangents = new Float64Array(n);
    const vehicle = {
      mass: 200,
      dragArea: 0.38,
      liftArea: 0,
      muLat: 0.95,
      muLon: 0.95,
      tyreDragK: 0.28,
      curveMode: "power" as const,
      finalDrive: 10,
      wheelRadius: 0.215,
      drivetrainLayout: "RWD" as const,
      brakeBias: 0,
      diffLockRear: 1,
      diffLockFront: 0,
      weightDistFront: 0.42,
      wheelbase: 1.05,
      trackWidth: 1.35,
      cgHeight: 0.29,
      yawInertia: 42,
      steeringLockDeg: 34,
      corneringStiffnessFront: 7000,
      corneringStiffnessRear: 9500,
      yawDragK: 0.45,
      powerCurve: [{ x: 0, y: 2.5 }, { x: 20, y: 4.2 }, { x: 35, y: 4.8 }, { x: 50, y: 4.5 }, { x: 60, y: 3.5 }, { x: 70, y: 1.5 }],
    };

    for (let i = 0; i < n; i++) {
      const theta = (i / n) * Math.PI * 2;
      xs[i] = 80 * Math.cos(theta);
      ys[i] = 80 * Math.sin(theta);
      tangents[i] = theta + Math.PI / 2;
      wobble[i] = Math.sin(theta * 24) * 0.08;
    }

    const smoothResult = simulateHotLap(vehicle, offsetsToTrackPoints(smooth, hw, xs, ys, tangents));
    const wobbleResult = simulateHotLap(vehicle, offsetsToTrackPoints(wobble, hw, xs, ys, tangents));
    const spread = (values: Float64Array) => Math.max(...values) - Math.min(...values);

    expect(spread(wobbleResult.latAccels)).toBeGreaterThan(spread(smoothResult.latAccels) + 0.5);
  });

  it("makes steering wobble slower in actual simulated lap time", () => {
    const n = 260;
    const smooth = new Float64Array(n);
    const wobble = new Float64Array(n);
    const hw = new Float64Array(n).fill(4);
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    const tangents = new Float64Array(n);
    const vehicle = {
      mass: 200,
      dragArea: 0.38,
      liftArea: 0,
      muLat: 0.95,
      muLon: 0.95,
      tyreDragK: 0.28,
      curveMode: "power" as const,
      finalDrive: 10,
      wheelRadius: 0.215,
      drivetrainLayout: "RWD" as const,
      brakeBias: 0,
      diffLockRear: 1,
      diffLockFront: 0,
      weightDistFront: 0.42,
      wheelbase: 1.05,
      trackWidth: 1.35,
      cgHeight: 0.29,
      yawInertia: 42,
      steeringLockDeg: 34,
      corneringStiffnessFront: 7000,
      corneringStiffnessRear: 9500,
      yawDragK: 0.45,
      powerCurve: [{ x: 0, y: 2.5 }, { x: 20, y: 4.2 }, { x: 35, y: 4.8 }, { x: 50, y: 4.5 }, { x: 60, y: 3.5 }, { x: 70, y: 1.5 }],
    };

    for (let i = 0; i < n; i++) {
      const theta = (i / n) * Math.PI * 2;
      xs[i] = 80 * Math.cos(theta);
      ys[i] = 80 * Math.sin(theta);
      tangents[i] = theta + Math.PI / 2;
      wobble[i] = Math.sin(theta * 24) * 0.08;
    }

    const wobbleResult = simulateHotLap(vehicle, offsetsToTrackPoints(wobble, hw, xs, ys, tangents));

    expect(wobbleResult.lapTime).toBeGreaterThan(lapTimeForOffsets(smooth, vehicle, hw, xs, ys, tangents));
    expect(Math.min(...wobbleResult.speeds)).toBeGreaterThan(1);
  });
});
