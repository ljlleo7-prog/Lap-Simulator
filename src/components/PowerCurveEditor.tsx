import { useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import type { VehicleParams, PowerCurvePoint, CurveMode } from "../vehicle.js";
import { interpCurve } from "../vehicle.js";

interface Props {
  params: VehicleParams;
  onChange: (p: VehicleParams) => void;
}

const MODES: { value: CurveMode; label: string }[] = [
  { value: "torque", label: "Torque vs RPM" },
  { value: "power",  label: "Power vs Speed" },
];

// Build chart data: torque + derived power kW for display.
function buildChartData(params: VehicleParams) {
  const { curveMode, powerCurve, finalDrive = 8.5, wheelRadius = 0.33 } = params;
  if (powerCurve.length === 0) return [];
  const xs = powerCurve.map(p => p.x);
  const min = Math.min(...xs), max = Math.max(...xs);
  const steps = 60;
  const data: { x: number; primary: number; power: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const x = min + (max - min) * (i / steps);
    const primary = interpCurve(powerCurve, x);
    let powerKw: number;
    if (curveMode === "torque") {
      // power = torque * rpm * π/30 / 1000
      powerKw = (primary * x * Math.PI / 30) / 1000;
    } else {
      powerKw = primary;
    }
    data.push({ x: Math.round(x), primary: Math.round(primary * 10) / 10, power: Math.round(powerKw * 10) / 10 });
  }
  return data;
}

function sortedCurve(curve: PowerCurvePoint[]): PowerCurvePoint[] {
  return [...curve].sort((a, b) => a.x - b.x);
}

export function PowerCurveEditor({ params, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const { curveMode, powerCurve, finalDrive = 8.5, wheelRadius = 0.33 } = params;
  const chartData = buildChartData(params);

  const xLabel = curveMode === "torque" ? "RPM" : "Speed (km/h)";
  const yLabel = curveMode === "torque" ? "Torque (Nm)" : "Power (kW)";
  const y2Label = curveMode === "torque" ? "Power (kW)" : "";

  function update(patch: Partial<VehicleParams>) {
    onChange({ ...params, ...patch });
  }

  function switchMode(mode: CurveMode) {
    if (mode === curveMode) return;
    // Convert existing curve to new domain
    if (mode === "power" && curveMode === "torque") {
      const fd = finalDrive, wr = wheelRadius;
      // torque mode → power mode: x=speed km/h, y=kW
      const converted = powerCurve.map(pt => {
        const speedKmh = (pt.x * Math.PI / 30) * wr / fd * 3.6;
        const kw = pt.y * pt.x * Math.PI / 30 / 1000;
        return { x: Math.round(speedKmh), y: Math.round(kw * 10) / 10 };
      });
      update({ curveMode: mode, powerCurve: sortedCurve(converted) });
    } else if (mode === "torque" && curveMode === "power") {
      const fd = finalDrive, wr = wheelRadius;
      // power mode → torque mode: x=RPM, y=Nm
      const converted = powerCurve.map(pt => {
        const rpm = (pt.x / 3.6) / wr * fd * 60 / (2 * Math.PI);
        const torque = pt.y > 0 && rpm > 0 ? (pt.y * 1000) / (rpm * Math.PI / 30) : 0;
        return { x: Math.round(rpm), y: Math.round(torque * 10) / 10 };
      });
      update({ curveMode: mode, powerCurve: sortedCurve(converted) });
    } else {
      update({ curveMode: mode });
    }
  }

  function updatePoint(idx: number, field: "x" | "y", val: number) {
    const next = powerCurve.map((p, i) => i === idx ? { ...p, [field]: val } : p);
    update({ powerCurve: sortedCurve(next) });
  }

  function addPoint() {
    const sorted = sortedCurve(powerCurve);
    if (sorted.length >= 2) {
      const last = sorted[sorted.length - 1];
      const second = sorted[sorted.length - 2];
      const nx = Math.round(last.x + (last.x - second.x));
      const ny = Math.round(last.y * 0.85 * 10) / 10;
      update({ powerCurve: [...sorted, { x: nx, y: ny }] });
    } else {
      update({ powerCurve: [...sorted, { x: sorted.length === 0 ? 1000 : sorted[0].x + 2000, y: 300 }] });
    }
  }

  function removePoint(idx: number) {
    if (powerCurve.length <= 2) return;
    update({ powerCurve: powerCurve.filter((_, i) => i !== idx) });
  }

  return (
    <div style={{ borderTop: "1px solid #222", paddingTop: 8 }}>
      <button onClick={() => setOpen(v => !v)} style={{
        width: "100%", background: "none", border: "none", color: "#888",
        fontSize: 11, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase",
        cursor: "pointer", textAlign: "left", padding: "4px 0", display: "flex",
        justifyContent: "space-between", alignItems: "center",
      }}>
        Power Curve <span style={{ fontSize: 10 }}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div style={{ marginTop: 8 }}>
          {/* Mode selector */}
          <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
            {MODES.map(m => (
              <button key={m.value} onClick={() => switchMode(m.value)} style={{
                flex: 1, padding: "4px 0", border: `1px solid ${curveMode === m.value ? "#3b82f6" : "#333"}`,
                background: "none", color: curveMode === m.value ? "#60a5fa" : "#555",
                borderRadius: 4, cursor: "pointer", fontSize: 10, letterSpacing: 0.3,
              }}>{m.label}</button>
            ))}
          </div>

          {/* Drivetrain params — torque mode only */}
          {curveMode === "torque" && (
            <div style={{ marginBottom: 8 }}>
              <ParamRow label="Final drive">
                <NumIn value={finalDrive} step={0.1} min={1}
                  onChange={v => update({ finalDrive: v })} />
              </ParamRow>
              <ParamRow label="Wheel radius (m)">
                <NumIn value={wheelRadius} step={0.01} min={0.1}
                  onChange={v => update({ wheelRadius: v })} />
              </ParamRow>
            </div>
          )}

          {/* Chart */}
          <div style={{ height: 160, marginBottom: 8 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 4, left: -10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                <XAxis dataKey="x" tick={{ fontSize: 9, fill: "#666" }} label={{ value: xLabel, position: "insideBottom", offset: -2, fontSize: 9, fill: "#555" }} />
                <YAxis yAxisId="left" tick={{ fontSize: 9, fill: "#60a5fa" }} />
                {curveMode === "torque" && (
                  <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 9, fill: "#f97316" }} />
                )}
                <Tooltip
                  contentStyle={{ background: "#1a1a1a", border: "1px solid #333", fontSize: 11 }}
                  labelStyle={{ color: "#888" }}
                />
                <Legend wrapperStyle={{ fontSize: 10, paddingTop: 4 }} />
                <Line yAxisId="left" type="monotone" dataKey="primary" name={yLabel}
                  stroke="#60a5fa" dot={false} strokeWidth={2} />
                {curveMode === "torque" && (
                  <Line yAxisId="right" type="monotone" dataKey="power" name={y2Label}
                    stroke="#f97316" dot={false} strokeWidth={1.5} strokeDasharray="4 2" />
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Point table */}
          <div style={{ fontSize: 11 }}>
            <div style={{ display: "flex", gap: 4, color: "#555", marginBottom: 4, paddingLeft: 4 }}>
              <span style={{ flex: 1 }}>{xLabel}</span>
              <span style={{ flex: 1 }}>{yLabel}</span>
              <span style={{ width: 20 }} />
            </div>
            {sortedCurve(powerCurve).map((pt, idx) => (
              <div key={idx} style={{ display: "flex", gap: 4, marginBottom: 4, alignItems: "center" }}>
                <NumIn value={pt.x} step={curveMode === "torque" ? 500 : 10} min={0}
                  onChange={v => updatePoint(idx, "x", v)}
                  style={{ flex: 1, width: "unset" }} />
                <NumIn value={pt.y} step={curveMode === "torque" ? 10 : 5} min={0}
                  onChange={v => updatePoint(idx, "y", v)}
                  style={{ flex: 1, width: "unset" }} />
                <button onClick={() => removePoint(idx)} disabled={powerCurve.length <= 2}
                  style={{ width: 20, height: 22, background: "none", border: "1px solid #333",
                    color: "#555", borderRadius: 3, cursor: "pointer", fontSize: 11, padding: 0 }}>×</button>
              </div>
            ))}
            <button onClick={addPoint} style={{
              width: "100%", marginTop: 4, padding: "4px 0",
              background: "none", border: "1px solid #333", color: "#888",
              borderRadius: 3, cursor: "pointer", fontSize: 11,
            }}>+ Add point</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ParamRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
      <span style={{ fontSize: 11, color: "#aaa" }}>{label}</span>
      {children}
    </div>
  );
}

interface NumInProps {
  value: number; step: number; min: number;
  onChange: (v: number) => void;
  style?: React.CSSProperties;
}
function NumIn({ value, step, min, onChange, style }: NumInProps) {
  return (
    <input type="number" value={value} min={min} step={step}
      onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) onChange(v); }}
      style={{ width: 70, background: "#1a1a1a", border: "1px solid #333", color: "#e0e0e0",
        padding: "3px 5px", borderRadius: 3, fontSize: 11, ...style }} />
  );
}
