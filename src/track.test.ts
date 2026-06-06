import { describe, it, expect } from "vitest";
import { buildTrackProfile, trackLength } from "./track.js";

describe("trackLength", () => {
  it("sums segment lengths", () => {
    expect(trackLength([{ length: 300, radius: Infinity }, { length: 100, radius: 50 }])).toBe(400);
  });
});

describe("buildTrackProfile", () => {
  it("first point is at distance 0", () => {
    const pts = buildTrackProfile([{ length: 100, radius: Infinity }]);
    expect(pts[0].distance).toBe(0);
  });

  it("last point distance equals track length", () => {
    const segs = [{ length: 200, radius: Infinity }, { length: 100, radius: 40 }];
    const pts = buildTrackProfile(segs);
    expect(pts[pts.length - 1].distance).toBe(300);
  });

  it("assigns correct radius to straight points", () => {
    const pts = buildTrackProfile([{ length: 50, radius: Infinity }]);
    expect(pts.every((p) => p.radius === Infinity)).toBe(true);
  });

  it("assigns corner radius to corner points", () => {
    const pts = buildTrackProfile([{ length: 50, radius: 30 }]);
    expect(pts.every((p) => p.radius === 30)).toBe(true);
  });
});
