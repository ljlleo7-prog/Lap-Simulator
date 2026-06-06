export interface TrackSegment {
  length: number;   // metres
  radius: number;   // metres, Infinity for straight
}

export interface TrackPoint {
  distance: number; // cumulative distance from start (m)
  radius: number;   // local radius of curvature (m)
}

export function buildTrackProfile(segments: TrackSegment[]): TrackPoint[] {
  const points: TrackPoint[] = [];
  let dist = 0;
  for (const seg of segments) {
    const step = Math.min(seg.length, 5); // ~5 m resolution
    const n = Math.max(1, Math.round(seg.length / step));
    const dx = seg.length / n;
    for (let i = 0; i < n; i++) {
      points.push({ distance: dist + dx * i, radius: seg.radius });
    }
    dist += seg.length;
  }
  points.push({ distance: dist, radius: segments[segments.length - 1].radius });
  return points;
}

export function trackLength(segments: TrackSegment[]): number {
  return segments.reduce((s, seg) => s + seg.length, 0);
}
