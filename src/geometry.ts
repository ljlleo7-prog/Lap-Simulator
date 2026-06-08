import type { TrackPoint } from "./track.js";

export interface CrossSection {
  id: string;
  x: number;
  y: number;
  direction: number; // degrees, CCW from +X, world coords (Y-up)
  width: number;     // metres
}

type Vec2 = { x: number; y: number };

export interface BezierSegment {
  p0: Vec2; c0: Vec2; c1: Vec2; p3: Vec2;
  invalid: boolean;
}

export interface CentreSample {
  x: number; y: number;
  distance: number;
  radius: number;
  tangentAngle: number; // radians, world coords
  segmentIndex: number;
  segmentT: number;
}

// ── Bézier math ──────────────────────────────────────────────────────────────

function tgt(dirDeg: number): Vec2 {
  const r = (dirDeg * Math.PI) / 180;
  return { x: Math.cos(r), y: Math.sin(r) };
}

function add(a: Vec2, b: Vec2): Vec2 { return { x: a.x + b.x, y: a.y + b.y }; }
function sub(a: Vec2, b: Vec2): Vec2 { return { x: a.x - b.x, y: a.y - b.y }; }
function scale(v: Vec2, s: number): Vec2 { return { x: v.x * s, y: v.y * s }; }
function len(v: Vec2): number { return Math.sqrt(v.x * v.x + v.y * v.y); }
function dot(a: Vec2, b: Vec2): number { return a.x * b.x + a.y * b.y; }
function cross2(a: Vec2, b: Vec2): number { return a.x * b.y - a.y * b.x; }

function bezierPoint(p0: Vec2, c0: Vec2, c1: Vec2, p3: Vec2, t: number): Vec2 {
  const u = 1 - t;
  return {
    x: u*u*u*p0.x + 3*u*u*t*c0.x + 3*u*t*t*c1.x + t*t*t*p3.x,
    y: u*u*u*p0.y + 3*u*u*t*c0.y + 3*u*t*t*c1.y + t*t*t*p3.y,
  };
}

function bezierDeriv1(p0: Vec2, c0: Vec2, c1: Vec2, p3: Vec2, t: number): Vec2 {
  const u = 1 - t;
  return scale(
    add(add(scale(sub(c0, p0), u*u), scale(sub(c1, c0), 2*u*t)), scale(sub(p3, c1), t*t)),
    3
  );
}

function bezierDeriv2(p0: Vec2, c0: Vec2, c1: Vec2, p3: Vec2, t: number): Vec2 {
  return scale(
    add(scale(add(sub(c1, scale(c0, 2)), p0), 1 - t), scale(add(sub(p3, scale(c1, 2)), c0), t)),
    6
  );
}

function radiusAt(p0: Vec2, c0: Vec2, c1: Vec2, p3: Vec2, t: number): number {
  const d1 = bezierDeriv1(p0, c0, c1, p3, t);
  const d2 = bezierDeriv2(p0, c0, c1, p3, t);
  const cr = Math.abs(cross2(d1, d2));
  if (cr < 1e-10) return Infinity;
  return Math.pow(len(d1), 3) / cr;
}

// ── Segment building ─────────────────────────────────────────────────────────

function isInvalid(p0: Vec2, c0: Vec2, c1: Vec2, p3: Vec2): boolean {
  const chord = sub(p3, p0);
  const chordLen = len(chord);
  if (chordLen < 0.01) return true;
  const unit = scale(chord, 1 / chordLen);
  const projC0 = dot(sub(c0, p0), unit);
  const projC1 = dot(sub(c1, p0), unit);
  if (projC0 < -chordLen * 0.5 || projC0 > chordLen * 1.5) return true;
  if (projC1 < -chordLen * 0.5 || projC1 > chordLen * 1.5) return true;
  // sample minimum radius
  for (let i = 0; i <= 20; i++) {
    if (radiusAt(p0, c0, c1, p3, i / 20) < 3) return true;
  }
  return false;
}

export function buildBezierSegments(sections: CrossSection[], closed = true): BezierSegment[] {
  const n = sections.length;
  if (n < 2) return [];
  const count = closed ? n : n - 1;
  const segs: BezierSegment[] = [];
  for (let i = 0; i < count; i++) {
    const a = sections[i];
    const b = sections[(i + 1) % n];
    const p0: Vec2 = { x: a.x, y: a.y };
    const p3: Vec2 = { x: b.x, y: b.y };
    const alpha = len(sub(p3, p0)) / 3;
    const t0 = tgt(a.direction);
    const t1 = tgt(b.direction);
    const c0 = add(p0, scale(t0, alpha));
    const c1 = sub(p3, scale(t1, alpha));
    segs.push({ p0, c0, c1, p3, invalid: isInvalid(p0, c0, c1, p3) });
  }
  return segs;
}

// ── Centre-line sampling ──────────────────────────────────────────────────────

const SAMPLE_STEP = 3; // metres
const LUT_STEPS = 200;

function buildArcLUT(seg: BezierSegment): number[] {
  // lut[i] = cumulative arc length at t = i/LUT_STEPS
  const lut = [0];
  let prev = seg.p0;
  for (let i = 1; i <= LUT_STEPS; i++) {
    const t = i / LUT_STEPS;
    const pt = bezierPoint(seg.p0, seg.c0, seg.c1, seg.p3, t);
    lut.push(lut[i - 1] + len(sub(pt, prev)));
    prev = pt;
  }
  return lut;
}

function tForArcLength(lut: number[], s: number): number {
  const total = lut[LUT_STEPS];
  if (s <= 0) return 0;
  if (s >= total) return 1;
  let lo = 0, hi = LUT_STEPS;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (lut[mid] < s) lo = mid; else hi = mid;
  }
  const frac = (s - lut[lo]) / (lut[hi] - lut[lo]);
  return (lo + frac) / LUT_STEPS;
}

export function sampleCentreLine(segments: BezierSegment[], step = SAMPLE_STEP): CentreSample[] {
  const samples: CentreSample[] = [];
  let cumDist = 0;
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    const lut = buildArcLUT(seg);
    const segLen = lut[LUT_STEPS];
    const steps = Math.max(1, Math.floor(segLen / step));
    for (let k = 0; k < steps; k++) {
      const s = (k / steps) * segLen;
      const t = tForArcLength(lut, s);
      const pt = bezierPoint(seg.p0, seg.c0, seg.c1, seg.p3, t);
      const d1 = bezierDeriv1(seg.p0, seg.c0, seg.c1, seg.p3, t);
      const r = radiusAt(seg.p0, seg.c0, seg.c1, seg.p3, t);
      samples.push({
        x: pt.x, y: pt.y,
        distance: cumDist + s,
        radius: r,
        tangentAngle: Math.atan2(d1.y, d1.x),
        segmentIndex: si,
        segmentT: t,
      });
    }
    cumDist += segLen;
  }
  return samples;
}

export function computeHalfWidths(
  samples: CentreSample[],
  sections: CrossSection[],
  segments: BezierSegment[],
): Float64Array {
  const n = sections.length;
  const hw = new Float64Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const si = s.segmentIndex;
    const wA = sections[si].width;
    const wB = sections[(si + 1) % n].width;
    const lut = buildArcLUT(segments[si]);
    const segLen = lut[LUT_STEPS];
    hw[i] = (wA + (wB - wA) * (s.segmentT * segLen / Math.max(segLen, 0.01))) / 2;
  }
  return hw;
}

// ── Edge points ───────────────────────────────────────────────────────────────

export function edgePoints(
  samples: CentreSample[],
  sections: CrossSection[],
  segments: BezierSegment[],
): { left: Vec2[]; right: Vec2[] } {
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  const n = sections.length;

  // build LUT once per segment, not once per sample
  const lutCache: (number[] | null)[] = new Array(segments.length).fill(null);
  const segLens: number[] = new Array(segments.length).fill(0);

  for (const s of samples) {
    const si = s.segmentIndex;
    if (!lutCache[si]) {
      lutCache[si] = buildArcLUT(segments[si]);
      segLens[si] = lutCache[si]![LUT_STEPS];
    }
    const segLen = segLens[si];
    const wA = sections[si].width;
    const wB = sections[(si + 1) % n].width;
    const w = wA + (wB - wA) * (s.segmentT * segLen / Math.max(segLen, 0.01));
    const halfW = w / 2;
    const nx = -Math.sin(s.tangentAngle);
    const ny = Math.cos(s.tangentAngle);
    left.push({ x: s.x + nx * halfW, y: s.y + ny * halfW });
    right.push({ x: s.x - nx * halfW, y: s.y - ny * halfW });
  }
  return { left, right };
}

// ── Integrator bridge ─────────────────────────────────────────────────────────

export function centreSamplesToTrackPoints(samples: CentreSample[]): TrackPoint[] {
  return samples.map(s => ({ distance: s.distance, radius: s.radius }));
}

// ── Racing line optimisation ──────────────────────────────────────────────────

export interface RacingLineSample {
  x: number; y: number;
  distance: number;
  radius: number;
}

export function racingLineFromOffsets(
  offsets: Float64Array,
  hw: Float64Array,
  samples: { x: number; y: number; tangentAngle: number }[],
): RacingLineSample[] {
  const n = offsets.length;
  const world: Vec2[] = [];
  const line: RacingLineSample[] = [];

  for (let i = 0; i < n; i++) {
    const ox = -Math.sin(samples[i].tangentAngle) * hw[i] * offsets[i] * 2;
    const oy =  Math.cos(samples[i].tangentAngle) * hw[i] * offsets[i] * 2;
    world.push({ x: samples[i].x + ox, y: samples[i].y + oy });
  }

  let dist = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) dist += len(sub(world[i], world[i - 1]));
    line.push({ x: world[i].x, y: world[i].y, distance: dist, radius: Infinity });
  }

  const rawK = new Float64Array(n);
  const STENCIL = 2;
  for (let i = 0; i < n; i++) {
    const a = world[(i - STENCIL + n) % n];
    const q = world[i];
    const b = world[(i + STENCIL) % n];
    const dax = q.x - a.x, day = q.y - a.y;
    const dbx = b.x - q.x, dby = b.y - q.y;
    const la = Math.hypot(dax, day);
    const lb = Math.hypot(dbx, dby);
    const lc = Math.hypot(b.x - a.x, b.y - a.y);
    const cross = dax * dby - day * dbx;
    if (Math.abs(cross) > 1e-9 && la > 1e-6 && lb > 1e-6 && lc > 1e-6) {
      const radius = (la * lb * lc) / Math.abs(cross);
      rawK[i] = Math.sign(cross) / radius;
    }
  }

  for (let i = 0; i < n; i++) {
    const kappa = rawK[i];
    line[i].radius = Math.abs(kappa) < 1e-12 ? Infinity : 1 / kappa;
  }

  return line;
}

// Returns offset ∈ [-0.5, 0.5] per sample: -0.5=left edge, +0.5=right edge
// "left" defined as +normal direction from tangent (same as edgePoints)
export function optimiseRacingLine(
  samples: CentreSample[],
  sections: CrossSection[],
  segments: BezierSegment[],
): { samples: RacingLineSample[]; offsets: Float64Array } {
  const n = samples.length;
  if (n < 3) return { samples: samples.map(s => ({ x: s.x, y: s.y, distance: s.distance, radius: s.radius })), offsets: new Float64Array(n) };

  // half-widths at each sample (interpolated between sections)
  const hw = samples.map(s => {
    const si = s.segmentIndex;
    const iB = (si + 1) % sections.length;
    const wA = sections[si].width;
    const wB = sections[iB].width;
    const lut = buildArcLUT(segments[si]);
    const segLen = lut[LUT_STEPS];
    return (wA + (wB - wA) * (s.segmentT * segLen / Math.max(segLen, 0.01))) / 2;
  });

  // signed curvature using finite differences on tangent angle
  const signedK = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const prev = samples[(i - 1 + n) % n];
    const next = samples[(i + 1) % n];
    let dAngle = next.tangentAngle - prev.tangentAngle;
    while (dAngle >  Math.PI) dAngle -= 2 * Math.PI;
    while (dAngle < -Math.PI) dAngle += 2 * Math.PI;
    const ds = next.distance - prev.distance || 0.01;
    signedK[i] = dAngle / ds;
  }

  // ── helper: world position of racing line point i given offset array ─────
  function rlPoint(arr: Float64Array, i: number): [number, number] {
    const s = samples[i];
    return [
      s.x + (-Math.sin(s.tangentAngle)) * hw[i] * arr[i] * 2,
      s.y + ( Math.cos(s.tangentAngle)) * hw[i] * arr[i] * 2,
    ];
  }

  // radius of curvature at i using a wider stencil (±STENCIL samples)
  const STENCIL = 4;
  function localRadius(arr: Float64Array, i: number): number {
    const [ax, ay] = rlPoint(arr, (i - STENCIL + n) % n);
    const [qx, qy] = rlPoint(arr, i);
    const [bx, by] = rlPoint(arr, (i + STENCIL) % n);
    const dax = qx - ax, day = qy - ay;
    const dbx = bx - qx, dby = by - qy;
    const cr = Math.abs(dax * dby - day * dbx);
    if (cr < 1e-10) return Infinity;
    return Math.pow(Math.sqrt(dax*dax+day*day) * Math.sqrt(dbx*dbx+dby*dby), 1.5) / cr;
  }

  // ── warm-start: centre line (zero seed, symmetric, no bias) ─────────────
  const opt = new Float64Array(n); // zeros

  // minimum radius over a ±WINDOW_MIN neighbourhood — rewards lifting the bottleneck
  const WINDOW_MIN = 6;
  function minWindowRadius(arr: Float64Array, i: number): number {
    let worst = Infinity;
    for (let k = -WINDOW_MIN; k <= WINDOW_MIN; k++) {
      const r = localRadius(arr, (i + k + n) % n);
      if (r < worst) worst = r;
    }
    return worst;
  }

  // ── in-place gradient descent: maximise minimum-window radius ────────────
  const ITERS = 400;
  const STEP_START = 0.03;
  const STEP_END   = 0.003;

  for (let iter = 0; iter < ITERS; iter++) {
    const step = STEP_START * Math.pow(STEP_END / STEP_START, iter / (ITERS - 1));
    for (let i = 0; i < n; i++) {
      const r0 = minWindowRadius(opt, i);
      const orig = opt[i];
      opt[i] = Math.max(-0.5, Math.min(0.5, orig + step));
      const rp = minWindowRadius(opt, i);
      opt[i] = Math.max(-0.5, Math.min(0.5, orig - step));
      const rm = minWindowRadius(opt, i);
      if (rp >= rm && rp > r0)      opt[i] = Math.max(-0.5, Math.min(0.5, orig + step));
      else if (rm > r0)             opt[i] = Math.max(-0.5, Math.min(0.5, orig - step));
      else                          opt[i] = orig;
    }
  }

  // ── smooth to remove single-sample jitter ────────────────────────────────
  const WINDOW = 5;
  const smoothed = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0, w = 0;
    for (let k = -WINDOW; k <= WINDOW; k++) {
      const wk = Math.exp(-0.5 * (k / (WINDOW * 0.5)) ** 2);
      sum += opt[(i + k + n) % n] * wk;
      w   += wk;
    }
    smoothed[i] = sum / w;
  }

  // ── build output points ───────────────────────────────────────────────────
  const result: RacingLineSample[] = [];
  let dist = 0;
  for (let i = 0; i < n; i++) {
    const [x, y] = rlPoint(smoothed, i);

    if (i > 0) {
      const prev = result[i - 1];
      dist += Math.sqrt((x - prev.x) ** 2 + (y - prev.y) ** 2);
    }

    // radius from three consecutive racing-line points
    let radius = Infinity;
    if (i > 0 && i < n - 1) {
      const [ax, ay] = rlPoint(smoothed, (i - 1 + n) % n);
      const [cx2, cy2] = rlPoint(smoothed, (i + 1) % n);
      const dax = x - ax, day = y - ay;
      const dbx = cx2 - x, dby = cy2 - y;
      const cr = Math.abs(dax * dby - day * dbx);
      if (cr > 1e-10)
        radius = Math.pow(Math.sqrt(dax*dax+day*day) * Math.sqrt(dbx*dbx+dby*dby), 1.5) / cr;
    }

    result.push({ x, y, distance: dist, radius });
  }

  return { samples: result, offsets: smoothed };
}
