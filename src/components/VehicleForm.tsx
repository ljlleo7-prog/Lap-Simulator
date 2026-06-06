import type { VehicleParams } from "../vehicle.js";

interface Props {
  params: VehicleParams;
  onChange: (p: VehicleParams) => void;
}

const FIELDS: { key: keyof VehicleParams; label: string; unit: string; min: number; step: number }[] = [
  { key: "mass",       label: "Mass",          unit: "kg",  min: 100,  step: 10 },
  { key: "peakPower",  label: "Peak Power",    unit: "W",   min: 1000, step: 5000 },
  { key: "dragArea",   label: "Drag CdA",      unit: "m²",  min: 0.1,  step: 0.05 },
  { key: "liftArea",   label: "Downforce ClA", unit: "m²",  min: 0,    step: 0.1 },
  { key: "muLat",      label: "Lateral grip μ", unit: "",   min: 0.5,  step: 0.05 },
  { key: "muLon",      label: "Long. grip μ",  unit: "",    min: 0.5,  step: 0.05 },
];

export function VehicleForm({ params, onChange }: Props) {
  return (
    <div style={{ padding: "12px 16px", borderBottom: "1px solid #222" }}>
      <div style={header}>Vehicle Parameters</div>
      {FIELDS.map(({ key, label, unit, min, step }) => (
        <div key={key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <label style={{ fontSize: 12, color: "#aaa" }}>
            {label}{unit && <span style={{ color: "#555", marginLeft: 4 }}>{unit}</span>}
          </label>
          <input
            type="number"
            value={params[key]}
            min={min}
            step={step}
            onChange={e => onChange({ ...params, [key]: parseFloat(e.target.value) || 0 })}
            style={{ width: 90, background: "#1a1a1a", border: "1px solid #333", color: "#e0e0e0", padding: "3px 6px", borderRadius: 3, fontSize: 12 }}
          />
        </div>
      ))}
    </div>
  );
}

const header: React.CSSProperties = { fontSize: 11, fontWeight: 600, letterSpacing: 1, color: "#888", textTransform: "uppercase", marginBottom: 10 };
