import { useRef, useCallback, useState, useEffect } from "react";
import type { CrossSection, BezierSegment, CentreSample, RacingLineSample } from "../geometry.js";
import { edgePoints } from "../geometry.js";
import type { SimResult } from "../integrator.js";
import type { VehicleParams } from "../vehicle.js";
import { steerAngleForRadius } from "../vehicle.js";

interface Props {
  sections: CrossSection[];
  committedSegments: BezierSegment[];
  committedCentreSamples: CentreSample[];
  racingLine: RacingLineSample[];
  useOptLine: boolean;
  result: SimResult | null;
  vehicle: VehicleParams;
  pathDisplay: "intended" | "drifted" | "both";
  playbackLine: RacingLineSample[];
  playbackIndex: number;
  playbackAlpha: number;
  playbackActive: boolean;
  selectedId: string | null;
  onDrag: (s: CrossSection[]) => void;
  onCommit: (s: CrossSection[]) => void;
  onSelect: (id: string | null) => void;
  hw: Float64Array;
  optOffsets: Float64Array | null;
  onOffsetChange: (o: Float64Array) => void;
  bgImageUrl: string | null;
  bgOpacity: number;
  imageRect: { x: number; y: number; w: number; h: number } | null;
  onImageRect: (r: { x: number; y: number; w: number; h: number }) => void;
  calibMode: "off" | "point" | "distance";
  onCalibModeOff: () => void;
  trackLength: number;
  onDistanceCalib: (metres: number) => void;
  showGrid: boolean;
  gridSize: 50 | 100;
  editLineMode: boolean;
  handleStride: number;
  gaussianWidth: number;
  trackLocked: boolean;
}

function toSvgPath(pts: { x: number; y: number }[], close = false): string {
  if (!pts.length) return "";
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
  return close ? d + " Z" : d;
}

function segmentsToCubicPath(segs: BezierSegment[]): string {
  if (!segs.length) return "";
  const f = (n: number) => n.toFixed(2);
  const s0 = segs[0];
  let d = `M${f(s0.p0.x)},${f(s0.p0.y)}`;
  for (const s of segs)
    d += ` C${f(s.c0.x)},${f(s.c0.y)} ${f(s.c1.x)},${f(s.c1.y)} ${f(s.p3.x)},${f(s.p3.y)}`;
  return d + " Z";
}

function speedColor(v: number, min: number, max: number): string {
  const t = max > min ? (v - min) / (max - min) : 0;
  const r = Math.round(t * 220 + 35);
  const b = Math.round((1 - t) * 220 + 35);
  return `rgb(${r},80,${b})`;
}

type DragMode =
  | { kind: "move"; id: string; ox: number; oy: number }
  | { kind: "edit"; id: string; startX: number; startY: number; origDir: number; origWidth: number };

interface HoverInfo { sampleIndex: number }

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function driftedPath(line: RacingLineSample[], lateralOffsets: Float64Array | undefined): RacingLineSample[] {
  if (!lateralOffsets || line.length === 0) return line;
  return line.map((p, i) => {
    const prev = line[Math.max(0, i - 1)];
    const next = line[Math.min(line.length - 1, i + 1)];
    const len = Math.hypot(next.x - prev.x, next.y - prev.y) || 1;
    const nx = -(next.y - prev.y) / len;
    const ny = (next.x - prev.x) / len;
    const offset = lateralOffsets[i] ?? 0;
    return { ...p, x: p.x + nx * offset, y: p.y + ny * offset };
  });
}

function actualResultPath(line: RacingLineSample[], result: SimResult | null): RacingLineSample[] {
  if (!result?.actualXs || !result.actualYs || result.actualXs.length === 0)
    return driftedPath(line, result?.lateralOffsets);
  return Array.from(result.actualXs, (x, i) => ({
    ...(line[i] ?? line[line.length - 1]),
    x,
    y: result.actualYs![i],
    distance: result.actualDistances?.[i] ?? line[i]?.distance ?? i,
    tangentAngle: result.actualHeadings?.[i] ?? (line[i] as RacingLineSample)?.tangentAngle ?? 0,
  }));
}

function carPose(line: RacingLineSample[], index: number, alpha: number) {
  const n = line.length;
  if (n === 0 || index < 0) return null;
  const i = Math.min(index, n - 1);
  const nextI = Math.min(i + 1, n - 1);
  const prevI = Math.max(i - 1, 0);
  const p = line[i];
  const q = line[nextI];
  const prev = line[prevI];
  const next = line[Math.min(i + 1, n - 1)];
  const x = q ? lerp(p.x, q.x, alpha) : p.x;
  const y = q ? lerp(p.y, q.y, alpha) : p.y;
  const heading = Math.atan2(next.y - prev.y, next.x - prev.x);
  return { x, y, heading, radius: p.radius };
}

export function TrackCanvas({
  sections, committedSegments: segments, committedCentreSamples: centreSamples,
  racingLine, useOptLine, result, vehicle, pathDisplay, playbackLine, playbackIndex, playbackAlpha, playbackActive, selectedId,
  onDrag, onCommit, onSelect,
  hw, optOffsets, onOffsetChange,
  bgImageUrl, bgOpacity, imageRect, onImageRect,
  calibMode, onCalibModeOff, trackLength, onDistanceCalib,
  showGrid, gridSize, editLineMode, handleStride, gaussianWidth, trackLocked,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<DragMode | null>(null);
  const lineDrag = useRef<{ index: number; x: number; y: number } | null>(null);
  const lineDragGhostRef = useRef<SVGCircleElement>(null);
  const lastClick = useRef<{ id: string; time: number } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [calibPoints, setCalibPoints] = useState<{ x: number; y: number }[]>([]);
  const [calibDist, setCalibDist] = useState("");
  const [distCalibDist, setDistCalibDist] = useState("");

  const edges = sections.length >= 2 && centreSamples.length > 0
    ? edgePoints(centreSamples, sections, segments)
    : null;

  const allPts = [
    ...centreSamples.map(s => ({ x: s.x, y: s.y })),
    ...(edges ? [...edges.left, ...edges.right] : []),
    ...sections.map(s => ({ x: s.x, y: s.y })),
  ];
  let vb = { minX: -100, minY: -100, w: 200, h: 200 };
  if (allPts.length > 0) {
    const xs = allPts.map(p => p.x), ys = allPts.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const pad = Math.max((maxX - minX) * 0.15, (maxY - minY) * 0.15, 30);
    vb = { minX: minX - pad, minY: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
  }

  function svgCoords(clientX: number, clientY: number) {
    const ctm = svgRef.current!.getScreenCTM()!.inverse();
    return new DOMPoint(clientX, clientY).matrixTransform(ctm);
  }

  const activeLine = useOptLine ? racingLine : centreSamples;
  const requestedLine: RacingLineSample[] = activeLine;
  const driftLine: RacingLineSample[] = result ? actualResultPath(activeLine, result) : activeLine;
  const HOVER_THRESHOLD_SQ = (vb.w * 0.015) ** 2;

  const sectionsRef = useRef(sections);
  const onDragRef = useRef(onDrag);
  const onCommitRef = useRef(onCommit);
  const centreSamplesRef = useRef(centreSamples);
  const hwRef = useRef(hw);
  const optOffsetsRef = useRef(optOffsets);
  const onOffsetChangeRef = useRef(onOffsetChange);
  const vbRef = useRef(vb);
  const gaussianWidthRef = useRef(gaussianWidth);
  sectionsRef.current = sections;
  onDragRef.current = onDrag;
  onCommitRef.current = onCommit;
  centreSamplesRef.current = centreSamples;
  hwRef.current = hw;
  optOffsetsRef.current = optOffsets;
  onOffsetChangeRef.current = onOffsetChange;
  vbRef.current = vb;
  gaussianWidthRef.current = gaussianWidth;

  useEffect(() => {
    const wrap = wrapRef.current!;

    function onMove(e: PointerEvent) {
      if (lineDrag.current !== null) {
        e.stopPropagation();
        const pt = svgCoords(e.clientX, e.clientY);
        lineDrag.current.x = pt.x;
        lineDrag.current.y = pt.y;
        if (lineDragGhostRef.current) {
          lineDragGhostRef.current.setAttribute("cx", String(pt.x));
          lineDragGhostRef.current.setAttribute("cy", String(pt.y));
          lineDragGhostRef.current.style.display = "";
        }
        return;
      }
      const d = drag.current;
      if (!d) return;
      e.stopPropagation();
      if (d.kind === "move") {
        const pt = svgCoords(e.clientX, e.clientY);
        onDragRef.current(sectionsRef.current.map(s =>
          s.id !== d.id ? s : { ...s, x: pt.x - d.ox, y: pt.y - d.oy }
        ));
      } else {
        const svg = svgRef.current!;
        const rect = svg.getBoundingClientRect();
        const scale = vbRef.current.w / rect.width;
        const dx = (e.clientX - d.startX) * scale;
        const dy = (e.clientY - d.startY) * scale;
        onDragRef.current(sectionsRef.current.map(s => {
          if (s.id !== d.id) return s;
          return {
            ...s,
            direction: ((d.origDir + dx * 0.5) % 360 + 360) % 360,
            width: Math.max(2, d.origWidth - dy * 0.15),
          };
        }));
      }
    }

    function onUp(e: PointerEvent) {
      if (lineDrag.current !== null) {
        e.stopPropagation();
        const { index: i, x, y } = lineDrag.current;
        const cs = centreSamplesRef.current[i];
        const h = hwRef.current[i];
        if (cs && h) {
          const nx = -Math.sin(cs.tangentAngle), ny = Math.cos(cs.tangentAngle);
          const signed = (x - cs.x) * nx + (y - cs.y) * ny;
          const newOff = Math.max(-0.5, Math.min(0.5, signed / (h * 2)));
          const base = optOffsetsRef.current;
          const n = centreSamplesRef.current.length;
          const updated = new Float64Array(base ?? new Float64Array(n));
          const delta = newOff - updated[i];
          const totalDist = centreSamplesRef.current[n - 1].distance;
          const sigmaM = totalDist * gaussianWidthRef.current;
          const distI = cs.distance;
          for (let j = 0; j < n; j++) {
            let d = Math.abs(centreSamplesRef.current[j].distance - distI);
            if (d > totalDist / 2) d = totalDist - d;
            const w = Math.exp(-(d * d) / (2 * sigmaM * sigmaM));
            updated[j] = Math.max(-0.5, Math.min(0.5, updated[j] + delta * w));
          }
          onOffsetChangeRef.current(updated);
        }
        if (lineDragGhostRef.current) lineDragGhostRef.current.style.display = "none";
        lineDrag.current = null;
        return;
      }
      if (drag.current !== null) {
        e.stopPropagation();
        onCommitRef.current(sectionsRef.current);
        drag.current = null;
      }
    }

    wrap.addEventListener("pointermove", onMove, { capture: true });
    wrap.addEventListener("pointerup", onUp, { capture: true });
    return () => {
      wrap.removeEventListener("pointermove", onMove, { capture: true } as EventListenerOptions);
      wrap.removeEventListener("pointerup", onUp, { capture: true } as EventListenerOptions);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerDown = useCallback((e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    const now = Date.now();
    const isDouble = lastClick.current?.id === id && now - lastClick.current.time < 300;
    lastClick.current = { id, time: now };
    if (isDouble) {
      setEditingId(prev => prev === id ? null : id);
      onSelect(id);
      drag.current = null;
      return;
    }
    onSelect(id);
    const sec = sections.find(s => s.id === id)!;
    if (editingId === id) {
      drag.current = { kind: "edit", id, startX: e.clientX, startY: e.clientY, origDir: sec.direction, origWidth: sec.width };
    } else {
      const pt = svgCoords(e.clientX, e.clientY);
      drag.current = { kind: "move", id, ox: pt.x - sec.x, oy: pt.y - sec.y };
    }
  }, [sections, onSelect, editingId]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (drag.current !== null || lineDrag.current !== null || !result || !activeLine.length) {
      if (hover !== null) setHover(null);
      return;
    }
    const pt = svgCoords(e.clientX, e.clientY);
    let best = -1, bestDist = Infinity;
    for (let i = 0; i < activeLine.length; i++) {
      const s = activeLine[i];
      const d = (s.x - pt.x) ** 2 + (s.y - pt.y) ** 2;
      if (d < bestDist) { bestDist = d; best = i; }
    }
    const next = bestDist < HOVER_THRESHOLD_SQ ? { sampleIndex: best } : null;
    if (next?.sampleIndex !== hover?.sampleIndex) setHover(next);
  }, [result, activeLine, HOVER_THRESHOLD_SQ, hover]);

  const onCanvasClick = useCallback((e: React.MouseEvent) => {
    if (trackLocked) return;
    if (calibMode === "point") {
      const pt = svgCoords(e.clientX, e.clientY);
      setCalibPoints(prev => prev.length >= 2 ? [{ x: pt.x, y: pt.y }] : [...prev, { x: pt.x, y: pt.y }]);
      return;
    }
    if (calibMode === "distance") return;
    if ((e.target as Element).tagName !== "rect") return;
    setEditingId(null);
    const pt = svgCoords(e.clientX, e.clientY);
    const last = sections[sections.length - 1];
    const id = crypto.randomUUID();
    const next = [...sections, { id, x: pt.x, y: pt.y, direction: last?.direction ?? 0, width: last?.width ?? 10 }];
    onDrag(next);
    onCommit(next);
    onSelect(id);
  }, [trackLocked, calibMode, sections, onDrag, onCommit, onSelect]);

  const speeds = result ? Array.from(result.speeds) : [];
  const lonAccels = result ? Array.from(result.lonAccels) : [];
  const latAccels = result ? Array.from(result.latAccels) : [];
  const minSpeed = speeds.length ? Math.min(...speeds) : 0;
  const maxSpeed = speeds.length ? Math.max(...speeds) : 1;
  const maxG = Math.max(...lonAccels.map(Math.abs), ...latAccels.map(Math.abs), 1e-3) / 9.81;

  const invalidSet = new Set(segments.map((seg, i) => seg.invalid ? i : -1).filter(i => i >= 0));
  const u = Math.max(vb.w, vb.h);
  const circleR = u * 0.08;
  const playbackDisplayLine = pathDisplay === "intended" ? playbackLine : actualResultPath(playbackLine, result);
  const pose = carPose(playbackDisplayLine, playbackIndex, playbackAlpha);
  const telemetryIndex = playbackActive ? playbackIndex : hover?.sampleIndex ?? -1;
  const telemetryLine = playbackActive ? playbackDisplayLine : pathDisplay === "intended" ? requestedLine : driftLine;

  const gridLines: React.ReactNode[] = [];
  if (showGrid) {
    const step = gridSize;
    const textSz = u * 0.016;
    const startX = Math.floor(vb.minX / step) * step;
    const startY = Math.floor(vb.minY / step) * step;
    for (let x = startX; x <= vb.minX + vb.w; x += step) {
      gridLines.push(<line key={`gx${x}`} x1={x} y1={vb.minY} x2={x} y2={vb.minY + vb.h} stroke="#252525" strokeWidth={u * 0.001} />);
      gridLines.push(<text key={`gxt${x}`} x={x} y={vb.minY + textSz * 1.3} fill="#383838" fontSize={textSz} textAnchor="middle">{x}m</text>);
    }
    for (let y = startY; y <= vb.minY + vb.h; y += step) {
      gridLines.push(<line key={`gy${y}`} x1={vb.minX} y1={y} x2={vb.minX + vb.w} y2={y} stroke="#252525" strokeWidth={u * 0.001} />);
      gridLines.push(<text key={`gyt${y}`} x={vb.minX + textSz * 0.6} y={y} fill="#383838" fontSize={textSz} dominantBaseline="middle">{y}m</text>);
    }
  }

  const si = telemetryIndex;

  return (
    <div ref={wrapRef} style={{ width: "100%", height: "100%" }}>
      <svg
        ref={svgRef}
        viewBox={`${vb.minX} ${vb.minY} ${vb.w} ${vb.h}`}
        style={{ width: "100%", height: "100%", background: "#0a0a0a", userSelect: "none" }}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(null)}
        onClick={onCanvasClick}
        preserveAspectRatio="xMidYMid meet"
      >
        {bgImageUrl && imageRect && (
          <image href={bgImageUrl} x={imageRect.x} y={imageRect.y} width={imageRect.w} height={imageRect.h}
            opacity={bgOpacity} preserveAspectRatio="xMidYMid meet" />
        )}

        {showGrid && <g>{gridLines}</g>}

        <rect x={vb.minX} y={vb.minY} width={vb.w} height={vb.h} fill="transparent" />

        {edges && centreSamples.length > 1 && (
          <path d={toSvgPath(edges.left) + " " + toSvgPath([...edges.right].reverse()) + " Z"} fill="#1e1e1e" stroke="none" />
        )}

        {segments.map((seg, i) => seg.invalid && (
          <line key={i} x1={seg.p0.x} y1={seg.p0.y} x2={seg.p3.x} y2={seg.p3.y}
            stroke="#ef4444" strokeWidth={u * 0.004} strokeOpacity={0.4} strokeDasharray="8 4" />
        ))}

        {edges && <>
          <path d={toSvgPath(edges.left)}  fill="none" stroke="#444" strokeWidth={u * 0.0015} />
          <path d={toSvgPath(edges.right)} fill="none" stroke="#444" strokeWidth={u * 0.0015} />
        </>}

        {segments.length > 1 && (
          <path d={segmentsToCubicPath(segments)} fill="none" stroke="#333"
            strokeWidth={u * 0.001} strokeDasharray={`${vb.w * 0.012} ${vb.w * 0.006}`} />
        )}

        {(pathDisplay === "intended" || pathDisplay === "both" || !result) && requestedLine.length > 1 && requestedLine.map((s, i) => {
          if (i === 0) return null;
          const prev = requestedLine[i - 1];
          const col = result ? speedColor(speeds[i] ?? 0, minSpeed, maxSpeed) : "#3b82f6";
          return <line key={`req${i}`} x1={prev.x} y1={prev.y} x2={s.x} y2={s.y}
            stroke={col} strokeWidth={u * (useOptLine ? 0.004 : 0.002)} opacity={useOptLine ? 1 : 0.45} />;
        })}

        {(pathDisplay === "drifted" || pathDisplay === "both") && result && driftLine.length > 1 && driftLine.map((s, i) => {
          if (i === 0) return null;
          const drifting = (result.lateralOffsets[i] ?? 0) > 0.05 || (result.lateralOffsets[i - 1] ?? 0) > 0.05 || (result.slideRatios[i] ?? 0) > 0 || (result.slideRatios[i - 1] ?? 0) > 0;
          if (pathDisplay === "both" && !drifting) return null;
          const prev = driftLine[i - 1];
          const frontSlide = Math.max(result.frontSlideRatios[i] ?? 0, result.frontSlideRatios[i - 1] ?? 0);
          const rearSlide = Math.max(result.rearSlideRatios[i] ?? 0, result.rearSlideRatios[i - 1] ?? 0);
          const driftColor = frontSlide > rearSlide * 1.15 ? "#22d3ee" : "#facc15";
          return <line key={`drift${i}`} x1={prev.x} y1={prev.y} x2={s.x} y2={s.y}
            stroke={driftColor} strokeWidth={u * (useOptLine ? 0.0045 : 0.003)} opacity={0.95}
            strokeDasharray={`${u * 0.012} ${u * 0.008}`} />;
        })}

        {editLineMode && racingLine.map((s, i) => {
          if (i % handleStride !== 0) return null;
          return (
            <circle key={`hl${i}`} cx={s.x} cy={s.y} r={u * 0.009}
              fill="#a855f7" stroke="#0f0f0f" strokeWidth={u * 0.002}
              style={{ cursor: "grab" }}
              onPointerDown={e => {
                e.stopPropagation();
                (e.target as Element).setPointerCapture(e.pointerId);
                lineDrag.current = { index: i, x: s.x, y: s.y };
                if (lineDragGhostRef.current) {
                  lineDragGhostRef.current.setAttribute("cx", String(s.x));
                  lineDragGhostRef.current.setAttribute("cy", String(s.y));
                  lineDragGhostRef.current.style.display = "";
                }
              }}
            />
          );
        })}

        <circle ref={lineDragGhostRef} cx={0} cy={0} r={u * 0.011}
          fill="none" stroke="#c084fc" strokeWidth={u * 0.002}
          strokeDasharray={`${u * 0.006} ${u * 0.004}`}
          style={{ display: "none", pointerEvents: "none" }} />

        {sections.map((sec, i) => {
          const rad = (sec.direction * Math.PI) / 180;
          const tx = Math.cos(rad), ty = Math.sin(rad);
          const nx = -ty, ny = tx;
          const hw2 = sec.width / 2;
          const invalid = invalidSet.has(i) || invalidSet.has((i - 1 + segments.length) % segments.length);
          const isEdit = sec.id === editingId;
          const color = invalid ? "#ef4444" : isEdit ? "#f59e0b" : sec.id === selectedId ? "#60a5fa" : "#666";
          const aLen = Math.min(hw2 * 0.8, vb.w * 0.03);
          return (
            <g key={sec.id}>
              <line x1={sec.x + nx * hw2} y1={sec.y + ny * hw2} x2={sec.x - nx * hw2} y2={sec.y - ny * hw2}
                stroke={color} strokeWidth={u * 0.002} />
              <polygon
                points={`${sec.x+tx*aLen},${sec.y+ty*aLen} ${sec.x-tx*aLen*0.4+nx*aLen*0.3},${sec.y-ty*aLen*0.4+ny*aLen*0.3} ${sec.x-tx*aLen*0.4-nx*aLen*0.3},${sec.y-ty*aLen*0.4-ny*aLen*0.3}`}
                fill={color} opacity={0.8} />
            </g>
          );
        })}

        {sections.map(sec => {
          const isEdit = sec.id === editingId;
          return (
            <circle key={sec.id}
              cx={sec.x} cy={sec.y} r={u * 0.012}
              fill={isEdit ? "#f59e0b" : sec.id === selectedId ? "#60a5fa" : "#3b82f6"}
              stroke="#0f0f0f" strokeWidth={u * 0.003}
              style={{ cursor: trackLocked || editLineMode ? "default" : isEdit ? "crosshair" : "grab" }}
              onPointerDown={trackLocked || editLineMode ? undefined : e => onPointerDown(e, sec.id)}
            />
          );
        })}

        {editingId && (() => {
          const sec = sections.find(s => s.id === editingId);
          if (!sec) return null;
          return <circle cx={sec.x} cy={sec.y} r={u * 0.028}
            fill="none" stroke="#f59e0b" strokeWidth={u * 0.001}
            strokeDasharray={`${u*0.008} ${u*0.004}`} opacity={0.5} />;
        })()}

        {calibMode === "point" && calibPoints.map((p, i) => (
          <circle key={`cp${i}`} cx={p.x} cy={p.y} r={u * 0.01} fill="#facc15" />
        ))}
        {calibMode === "point" && calibPoints.length === 2 && <>
          <line x1={calibPoints[0].x} y1={calibPoints[0].y} x2={calibPoints[1].x} y2={calibPoints[1].y}
            stroke="#facc15" strokeWidth={u * 0.002} strokeDasharray={`${u*0.006} ${u*0.004}`} />
          <foreignObject x={calibPoints[1].x + u * 0.02} y={calibPoints[1].y - u * 0.04} width={170} height={50}>
            <div style={{ background: "#1a1a1a", border: "1px solid #facc15", borderRadius: 4, padding: "5px 7px", display: "flex", gap: 4, alignItems: "center" }}
              onClick={e => e.stopPropagation()}>
              <input type="number" placeholder="metres" value={calibDist}
                onChange={e => setCalibDist(e.target.value)}
                style={{ width: 70, fontSize: 12, background: "#111", color: "#e0e0e0", border: "1px solid #333", borderRadius: 3, padding: "2px 4px" }} autoFocus />
              <button onClick={e => {
                e.stopPropagation();
                const d = parseFloat(calibDist);
                if (!d || d <= 0 || !imageRect) return;
                const p0 = calibPoints[0], p1 = calibPoints[1];
                const svgDist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
                const scale = d / svgDist;
                onImageRect({ x: p0.x + (imageRect.x - p0.x) * scale, y: p0.y + (imageRect.y - p0.y) * scale, w: imageRect.w * scale, h: imageRect.h * scale });
                setCalibPoints([]); setCalibDist("");
              }} style={{ fontSize: 12, padding: "2px 6px", background: "#facc15", color: "#000", border: "none", borderRadius: 3, cursor: "pointer" }}>OK</button>
            </div>
          </foreignObject>
        </>}

        {calibMode === "distance" && (() => {
          const ox = vb.minX + vb.w * 0.5;
          const oy = vb.minY + vb.h * 0.5;
          return (
            <foreignObject x={ox - 130} y={oy - 44} width={260} height={88}>
              <div style={{ background: "#111", border: "2px solid #34d399", borderRadius: 6, padding: "10px 14px" }}
                onClick={e => e.stopPropagation()}>
                <div style={{ fontSize: 11, color: "#34d399", marginBottom: 6, letterSpacing: 1 }}>
                  DISTANCE CALIBRATION — current: {(trackLength / 1000).toFixed(3)} km
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    type="number" placeholder="known lap distance (m)" value={distCalibDist}
                    onChange={e => setDistCalibDist(e.target.value)}
                    style={{ flex: 1, fontSize: 12, background: "#1a1a1a", color: "#e0e0e0", border: "1px solid #444", borderRadius: 3, padding: "3px 6px" }}
                    autoFocus
                  />
                  <button onClick={e => {
                    e.stopPropagation();
                    const d = parseFloat(distCalibDist);
                    if (!d || d <= 0) return;
                    onDistanceCalib(d);
                    setDistCalibDist("");
                  }} style={{ fontSize: 12, padding: "3px 8px", background: "#34d399", color: "#000", border: "none", borderRadius: 3, cursor: "pointer", fontWeight: 600 }}>Apply</button>
                  <button onClick={e => { e.stopPropagation(); onCalibModeOff(); setDistCalibDist(""); }}
                    style={{ fontSize: 12, padding: "3px 8px", background: "none", color: "#888", border: "1px solid #333", borderRadius: 3, cursor: "pointer" }}>✕</button>
                </div>
              </div>
            </foreignObject>
          );
        })()}

        {pose && result && (() => {
          const scale = Math.max(u * 0.006, 1.2);
          const bodyL = Math.max(vehicle.wheelbase * 1.45, vehicle.wheelbase + 0.8);
          const bodyW = Math.max(vehicle.trackWidth * 1.25, vehicle.trackWidth + 0.35);
          const wheelL = Math.max(vehicle.wheelbase * 0.22, 0.35);
          const wheelW = Math.max(vehicle.trackWidth * 0.12, 0.16);
          const steerSign = pose.radius === Infinity ? 0 : Math.sign(pose.radius);
          const steer = steerAngleForRadius(vehicle, pose.radius) * steerSign;
          const toDeg = 180 / Math.PI;
          const wheel = (key: string, x: number, y: number, angle = 0) => (
            <rect key={key} x={x - wheelL / 2} y={y - wheelW / 2} width={wheelL} height={wheelW} rx={wheelW * 0.25}
              fill="#0f172a" stroke="#e5e7eb" strokeWidth={scale * 0.12}
              transform={`rotate(${angle * toDeg} ${x} ${y})`} />
          );
          return (
            <g transform={`translate(${pose.x} ${pose.y}) rotate(${pose.heading * toDeg})`} style={{ pointerEvents: "none" }}>
              <rect x={-bodyL / 2} y={-bodyW / 2} width={bodyL} height={bodyW} rx={bodyW * 0.18}
                fill="#2563eb" fillOpacity={0.9} stroke="#bfdbfe" strokeWidth={scale * 0.18} />
              <polygon points={`${bodyL / 2 + scale * 0.9},0 ${bodyL / 2 - scale * 0.7},${-bodyW * 0.32} ${bodyL / 2 - scale * 0.7},${bodyW * 0.32}`}
                fill="#facc15" stroke="#111827" strokeWidth={scale * 0.12} />
              <rect x={-bodyL * 0.05} y={-bodyW * 0.32} width={bodyL * 0.34} height={bodyW * 0.64} rx={bodyW * 0.12}
                fill="#93c5fd" fillOpacity={0.7} />
              {wheel("fl", vehicle.wheelbase / 2, -vehicle.trackWidth / 2, steer)}
              {wheel("fr", vehicle.wheelbase / 2, vehicle.trackWidth / 2, steer)}
              {wheel("rl", -vehicle.wheelbase / 2, -vehicle.trackWidth / 2)}
              {wheel("rr", -vehicle.wheelbase / 2, vehicle.trackWidth / 2)}
            </g>
          );
        })()}

        {(playbackActive || hover) && result && si >= 0 && (() => {
          const sample = telemetryLine[si];
          if (!sample) return null;
          const vms = speeds[si] ?? 0;
          const lonG = (lonAccels[si] ?? 0) / 9.81;
          const latG = (latAccels[si] ?? 0) / 9.81;
          const kmh = vms * 3.6;
          const cx = vb.minX + vb.w * 0.82;
          const cy = vb.minY + vb.h * 0.18;
          const gScale = circleR / Math.max(maxG, 1);
          const offset = result.lateralOffsets[si] ?? 0;
          const frontSlide = result.frontSlideRatios[si] ?? 0;
          const rearSlide = result.rearSlideRatios[si] ?? 0;
          const balance = frontSlide > rearSlide * 1.15 ? "understeer" : rearSlide > frontSlide * 1.15 ? "oversteer" : frontSlide > 0 || rearSlide > 0 ? "4w slide" : "grip";
          const textSize = u * 0.022;
          return (
            <g>
              <circle cx={sample.x} cy={sample.y} r={u * 0.018} fill="none" stroke={playbackActive ? "#22c55e" : "#facc15"} strokeWidth={u * 0.003} />
              <circle cx={sample.x} cy={sample.y} r={u * 0.006} fill={playbackActive ? "#22c55e" : "#facc15"} />
              <circle cx={cx} cy={cy} r={circleR} fill="#0f0f0f" fillOpacity={0.85} stroke="#333" strokeWidth={u * 0.002} />
              <line x1={cx - circleR} y1={cy} x2={cx + circleR} y2={cy} stroke="#2a2a2a" strokeWidth={u * 0.001} />
              <line x1={cx} y1={cy - circleR} x2={cx} y2={cy + circleR} stroke="#2a2a2a" strokeWidth={u * 0.001} />
              <circle cx={cx} cy={cy} r={circleR * 0.5} fill="none" stroke="#2a2a2a" strokeWidth={u * 0.001} strokeDasharray={`${u*0.005} ${u*0.003}`} />
              <circle cx={cx + lonG * gScale} cy={cy - latG * gScale} r={u * 0.008} fill={playbackActive ? "#22c55e" : "#facc15"} />
              <text x={cx + circleR * 0.52} y={cy + textSize * 0.4} fill="#444" fontSize={textSize * 0.7} textAnchor="middle">+lon</text>
              <text x={cx} y={cy - circleR - textSize * 0.3} fill="#444" fontSize={textSize * 0.7} textAnchor="middle">lat</text>
              {[`${playbackActive ? "LIVE " : ""}${kmh.toFixed(1)} km/h`, `lon  ${lonG >= 0 ? "+" : ""}${lonG.toFixed(2)}g`, `lat  ${latG.toFixed(2)}g`, `off  ${offset.toFixed(2)} m`, balance, `dist ${((sample.distance ?? 0) / 1000).toFixed(2)} km`]
                .map((line, i) => <text key={i} x={cx} y={cy + circleR + textSize * (1.4 + i * 1.3)} fill="#e0e0e0" fontSize={textSize} textAnchor="middle" fontFamily="monospace">{line}</text>)}
            </g>
          );
        })()}
      </svg>
    </div>
  );
}
