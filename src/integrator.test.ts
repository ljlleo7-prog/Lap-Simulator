import { describe, it, expect } from "vitest";
import { simulate, simulateHotLap, simulateGripTargetHotLap, simulateDriftAwareHotLap } from "./integrator.js";
import { buildTrackProfile } from "./track.js";
import type { TrackPoint } from "./track.js";
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

const entertainmentKart: VehicleParams = {
  mass: 200,
  dragArea: 0.38,
  liftArea: 0,
  muLat: 0.95,
  muLon: 0.95,
  tyreDragK: 0.28,
  curveMode: "power",
  finalDrive: 10,
  wheelRadius: 0.215,
  drivetrainLayout: "RWD",
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
  powerCurve: [
    { x: 0, y: 2.5 }, { x: 20, y: 4.2 }, { x: 35, y: 4.8 },
    { x: 50, y: 4.5 }, { x: 60, y: 3.5 }, { x: 70, y: 1.5 },
  ],
};

const ovalTrack = buildTrackProfile([
  { length: 500, radius: Infinity },
  { length: 157, radius: 50 },  // ~180° at r=50
  { length: 500, radius: Infinity },
  { length: 157, radius: 50 },
]);

const brakingTrack = buildTrackProfile([
  { length: 700, radius: Infinity },
  { length: 120, radius: 28 },
  { length: 700, radius: Infinity },
  { length: 120, radius: 28 },
]);

function averageSpeed(result: ReturnType<typeof simulate>, points: TrackPoint[], start: number, end: number): number {
  const idxs = points
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.distance >= start && p.distance <= end)
    .map(({ i }) => i);
  return idxs.reduce((sum, i) => sum + result.speeds[i], 0) / idxs.length;
}

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

  it("brakes materially before a tight corner", () => {
    const result = simulate(car, brakingTrack);
    const approachSpeed = averageSpeed(result, brakingTrack, 560, 620);
    const entrySpeed = averageSpeed(result, brakingTrack, 690, 720);
    const approachAccels = brakingTrack
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.distance >= 560 && p.distance <= 700)
      .map(({ i }) => result.lonAccels[i]);

    expect(entrySpeed).toBeLessThan(approachSpeed * 0.9);
    expect(Math.min(...approachAccels)).toBeLessThan(-1);
  });

  it("accelerates after corner exit onto the following straight", () => {
    const result = simulate(car, brakingTrack);
    const exitSpeed = averageSpeed(result, brakingTrack, 820, 860);
    const laterStraightSpeed = averageSpeed(result, brakingTrack, 1040, 1100);
    const exitAccels = brakingTrack
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.distance >= 820 && p.distance <= 1040)
      .map(({ i }) => result.lonAccels[i]);

    expect(laterStraightSpeed).toBeGreaterThan(exitSpeed * 1.08);
    expect(Math.max(...exitAccels)).toBeGreaterThan(0.5);
  });

  it("shows braking and re-acceleration for a 丰速200cc-style entertainment kart", () => {
    const result = simulateHotLap(entertainmentKart, brakingTrack);
    const straightSpeed = averageSpeed(result, brakingTrack, 520, 620);
    const cornerSpeed = averageSpeed(result, brakingTrack, 720, 800);
    const exitSpeed = averageSpeed(result, brakingTrack, 820, 880);
    const laterStraightSpeed = averageSpeed(result, brakingTrack, 1120, 1220);
    const approachAccels = brakingTrack
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.distance >= 560 && p.distance <= 700)
      .map(({ i }) => result.lonAccels[i]);

    expect(straightSpeed).toBeGreaterThan(cornerSpeed * 1.15);
    expect(laterStraightSpeed).toBeGreaterThan(exitSpeed * 1.08);
    expect(Math.min(...approachAccels)).toBeLessThan(-0.5);
  });

  it("produces stable hot-lap results across the start-finish seam", () => {
    const result = simulateHotLap(car, ovalTrack);
    expect(result.lapTime).toBeGreaterThan(20);
    expect(result.speeds[result.speeds.length - 1]).toBeLessThan(100);
  });

  it("keeps grip-target hot laps non-sliding", () => {
    const result = simulateGripTargetHotLap(entertainmentKart, brakingTrack);
    expect(Math.max(...result.slideRatios)).toBe(0);
  });

  it("allows drift-aware hot laps to slide without stopping", () => {
    const slideTrack = buildTrackProfile([
      { length: 250, radius: Infinity },
      { length: 40, radius: 8 },
      { length: 250, radius: Infinity },
      { length: 40, radius: 8 },
    ]);
    const result = simulateDriftAwareHotLap({ ...entertainmentKart, muLat: 0.55, muLon: 0.55, tyreDragK: 0.35 }, slideTrack);
    expect(Math.max(...result.slideRatios)).toBeGreaterThan(0);
    expect(Math.min(...result.speeds)).toBeGreaterThan(0.5);
    expect(Number.isFinite(result.lapTime)).toBe(true);
  });

  it("reports lateral offset and axle slide when overdriving grip", () => {
    const slideTrack = buildTrackProfile([
      { length: 250, radius: Infinity },
      { length: 40, radius: 8 },
      { length: 250, radius: Infinity },
      { length: 40, radius: 8 },
    ]);
    const result = simulateDriftAwareHotLap({ ...entertainmentKart, muLat: 0.55, muLon: 0.55, tyreDragK: 0.35 }, slideTrack, new Float64Array(slideTrack.length).fill(5), 0.8);

    expect(result.lateralOffsets.length).toBe(slideTrack.length);
    expect(result.frontSlideRatios.length).toBe(slideTrack.length);
    expect(result.rearSlideRatios.length).toBe(slideTrack.length);
    expect(Math.max(...result.lateralOffsets)).toBeGreaterThan(0);
    expect(Math.max(...result.frontSlideRatios, ...result.rearSlideRatios)).toBeGreaterThan(0);
    expect(result.actualXs).toBeDefined();
    expect(result.actualYs).toBeDefined();
    expect(result.actualXs!.length).toBe(slideTrack.length);
    expect(result.actualYs!.length).toBe(slideTrack.length);
  });


  it("includes drifted path distance in sample timing", () => {
    const slideTrack = buildTrackProfile([
      { length: 250, radius: Infinity },
      { length: 45, radius: 8 },
      { length: 250, radius: Infinity },
      { length: 45, radius: 8 },
    ]);
    const looseKart = { ...entertainmentKart, muLat: 0.5, muLon: 0.5, tyreDragK: 0.35 };
    const slide = simulateDriftAwareHotLap(looseKart, slideTrack, new Float64Array(slideTrack.length).fill(8), 0.8);

    expect(slide.sampleTimes.length).toBe(slideTrack.length);
    expect(slide.sampleTimes[slide.sampleTimes.length - 1]).toBeCloseTo(slide.lapTime, 10);
    expect(slide.actualDistances?.length).toBe(slideTrack.length);
    expect(slide.actualDistances![slide.actualDistances!.length - 1]).toBeGreaterThan(0);
  });


  it("makes stricter drift tolerance slower on a slide-prone lap", () => {
    const slideTrack = buildTrackProfile([
      { length: 250, radius: Infinity },
      { length: 45, radius: 8 },
      { length: 250, radius: Infinity },
      { length: 45, radius: 8 },
    ]);
    const looseKart = { ...entertainmentKart, muLat: 0.5, muLon: 0.5, tyreDragK: 0.35 };
    const strict = simulateDriftAwareHotLap(looseKart, slideTrack, new Float64Array(slideTrack.length).fill(8), 0.05);
    const permissive = simulateDriftAwareHotLap(looseKart, slideTrack, new Float64Array(slideTrack.length).fill(8), 0.5);

    expect(strict.lapTime).toBeGreaterThan(permissive.lapTime);
    expect(averageSpeed(strict, slideTrack, 235, 260)).toBeLessThan(averageSpeed(permissive, slideTrack, 235, 260));
  });

  it("makes narrow off-track sliding slower than wide sliding", () => {
    const slideTrack = buildTrackProfile([
      { length: 250, radius: Infinity },
      { length: 45, radius: 8 },
      { length: 250, radius: Infinity },
      { length: 45, radius: 8 },
    ]);
    const looseKart = { ...entertainmentKart, muLat: 0.5, muLon: 0.5, tyreDragK: 0.35 };
    const narrow = simulateDriftAwareHotLap(looseKart, slideTrack, new Float64Array(slideTrack.length).fill(0.2), 0.8);
    const wide = simulateDriftAwareHotLap(looseKart, slideTrack, new Float64Array(slideTrack.length).fill(8), 0.8);

    expect(narrow.lapTime).toBeGreaterThan(wide.lapTime);
  });
});
