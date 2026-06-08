import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ScatterChart, Scatter, ReferenceLine,
} from "recharts";
import type { SimResult } from "../integrator.js";
import type { TrackPoint } from "../track.js";

interface Props { result: SimResult; trackPoints: TrackPoint[]; playbackIndex?: number }

export function Results({ result, trackPoints, playbackIndex = -1 }: Props) {
  const { speeds, lonAccels, latAccels } = result;

  const data = Array.from(speeds).map((v, i) => ({
    distance: Math.round((trackPoints[i]?.distance ?? i) * 10) / 10,
    speed: Math.round(v * 3.6 * 10) / 10,
    lon: Math.round(lonAccels[i] / 9.81 * 100) / 100,
    lat: Math.round(latAccels[i] / 9.81 * 100) / 100,
    offset: Math.round((result.lateralOffsets[i] ?? 0) * 100) / 100,
    frontSlide: Math.round((result.frontSlideRatios[i] ?? 0) * 100) / 100,
    rearSlide: Math.round((result.rearSlideRatios[i] ?? 0) * 100) / 100,
  }));

  const ggData = data.map(d => ({ lon: d.lon, lat: d.lat }));
  const current = playbackIndex >= 0 ? data[Math.min(playbackIndex, data.length - 1)] : null;
  const currentGg = current ? [{ lon: current.lon, lat: current.lat }] : [];

  const chartProps = {
    style: { background: "transparent" },
    margin: { top: 8, right: 16, bottom: 4, left: 0 },
  };

  return (
    <div style={{ display: "flex", height: "100%", gap: 0, background: "#0a0a0a" }}>
      <ChartBox label="Speed (km/h)">
        <LineChart data={data} {...chartProps}>
          <CartesianGrid stroke="#1e1e1e" />
          <XAxis dataKey="distance" tick={tickStyle} />
          <YAxis tick={tickStyle} width={38} />
          <Tooltip contentStyle={tooltipStyle} />
          {current && <ReferenceLine x={current.distance} stroke="#22c55e" strokeWidth={1.5} />}
          <Line type="monotone" dataKey="speed" dot={false} stroke="#3b82f6" strokeWidth={1.5} />
        </LineChart>
      </ChartBox>

      <ChartBox label="Long. / Lat. g">
        <LineChart data={data} {...chartProps}>
          <CartesianGrid stroke="#1e1e1e" />
          <XAxis dataKey="distance" tick={tickStyle} />
          <YAxis tick={tickStyle} width={38} />
          <ReferenceLine y={0} stroke="#333" />
          <Tooltip contentStyle={tooltipStyle} />
          {current && <ReferenceLine x={current.distance} stroke="#22c55e" strokeWidth={1.5} />}
          <Line type="monotone" dataKey="lon" name="Long. g" dot={false} stroke="#ef4444" strokeWidth={1.5} />
          <Line type="monotone" dataKey="lat" name="Lat. g" dot={false} stroke="#22c55e" strokeWidth={1.5} />
        </LineChart>
      </ChartBox>

      <ChartBox label="Path offset (m)">
        <LineChart data={data} {...chartProps}>
          <CartesianGrid stroke="#1e1e1e" />
          <XAxis dataKey="distance" tick={tickStyle} />
          <YAxis tick={tickStyle} width={38} />
          <ReferenceLine y={0} stroke="#333" />
          <Tooltip contentStyle={tooltipStyle} />
          {current && <ReferenceLine x={current.distance} stroke="#22c55e" strokeWidth={1.5} />}
          <Line type="monotone" dataKey="offset" name="Offset m" dot={false} stroke="#f59e0b" strokeWidth={1.5} />
          <Line type="monotone" dataKey="frontSlide" name="Front slide" dot={false} stroke="#38bdf8" strokeWidth={1} />
          <Line type="monotone" dataKey="rearSlide" name="Rear slide" dot={false} stroke="#f97316" strokeWidth={1} />
        </LineChart>
      </ChartBox>

      <ChartBox label="G-G diagram">
        <ScatterChart {...chartProps}>
          <CartesianGrid stroke="#1e1e1e" />
          <XAxis dataKey="lon" name="Long. g" type="number" domain={["auto","auto"]} tick={tickStyle} />
          <YAxis dataKey="lat" name="Lat. g" type="number" domain={["auto","auto"]} tick={tickStyle} width={38} />
          <Tooltip contentStyle={tooltipStyle} />
          <Scatter data={ggData} fill="#a855f7" opacity={0.5} />
          {currentGg.length > 0 && <Scatter data={currentGg} fill="#22c55e" opacity={1} />}
        </ScatterChart>
      </ChartBox>
    </div>
  );
}

function ChartBox({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", borderRight: "1px solid #1a1a1a", padding: "6px 8px" }}>
      <div style={{ fontSize: 10, color: "#555", letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      <ResponsiveContainer width="100%" height="100%">{children as React.ReactElement}</ResponsiveContainer>
    </div>
  );
}

const tickStyle = { fill: "#555", fontSize: 10 };
const tooltipStyle: React.CSSProperties = { background: "#1a1a1a", border: "1px solid #333", color: "#e0e0e0", fontSize: 11 };
