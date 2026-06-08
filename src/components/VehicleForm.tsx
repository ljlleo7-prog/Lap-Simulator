import React from "react";
import type { VehicleParams, DrivetrainLayout } from "../vehicle.js";
import { PowerCurveEditor } from "./PowerCurveEditor.tsx";

interface Props {
  params: VehicleParams;
  onChange: (p: VehicleParams) => void;
}

// ── Presets ───────────────────────────────────────────────────────────────────

const PRESETS: { label: string; description: string; values: VehicleParams }[] = [
  {
    label: "— preset —",
    description: "",
    values: {} as VehicleParams,
  },
  {
    label: "Shifter Kart",
    description:
      "125cc gearbox kart (ICC/KZ class). Spool rear axle — no differential, both rear wheels driven together. " +
      "This generates large tyre drag at tight hairpins (tyreDragK 0.22) and can unload the inside rear under combined braking and cornering. " +
      "Brake bias is rear-only (0%) because karts have no front brakes. " +
      "Setup tip: if the sim shows the kart losing too much time in hairpins vs reality, try reducing tyreDragK toward 0.15. " +
      "Peak power ~28 Nm @ 10000 RPM ≈ 29 kW; very rev-dependent, drops off sharply below 7000 RPM.",
    values: {
      mass: 165, dragArea: 0.35, liftArea: 0.0,
      muLat: 1.7, muLon: 1.7, tyreDragK: 0.22,
      curveMode: "torque", finalDrive: 12.0, wheelRadius: 0.215,
      drivetrainLayout: "RWD", brakeBias: 0.0, diffLockRear: 1.0, diffLockFront: 0.0,
      weightDistFront: 0.43, wheelbase: 1.05, trackWidth: 1.4, cgHeight: 0.27,
      yawInertia: 35, steeringLockDeg: 35,
      corneringStiffnessFront: 9000, corneringStiffnessRear: 12000, yawDragK: 0.35,
      powerCurve: [
        { x: 4000, y: 12 }, { x: 6000, y: 18 }, { x: 8000, y: 25 },
        { x: 10000, y: 28 }, { x: 12000, y: 27 }, { x: 14000, y: 22 },
      ],
    },
  },
  {
    label: "Entertainment Kart (200cc)",
    description:
      "Adult rental / entertainment kart — e.g. 丰速200cc / GX200-class single-speed karts. " +
      "Single-speed spool axle, governed to ~55–70 km/h with a ~6.5 hp / 4.8 kW engine. " +
      "Much heavier and less grippy than shifter karts. " +
      "tyreDragK is higher (0.28) because rental kart tyres run at higher slip angles and often on worn compound. " +
      "Brake bias rear-only (0%) same as all karts. " +
      "Setup tip: 丰速/GX200 tracks are typically tight with short straights — the optimizer will strongly favour apex widening. " +
      "μ around 0.9–1.0 better matches worn rental tyre grip than race-kart tyre values.",
    values: {
      mass: 200, dragArea: 0.38, liftArea: 0.0,
      muLat: 0.95, muLon: 0.95, tyreDragK: 0.28,
      curveMode: "power", finalDrive: 10.0, wheelRadius: 0.215,
      drivetrainLayout: "RWD", brakeBias: 0.0, diffLockRear: 1.0, diffLockFront: 0.0,
      weightDistFront: 0.42, wheelbase: 1.05, trackWidth: 1.35, cgHeight: 0.29,
      yawInertia: 42, steeringLockDeg: 34,
      corneringStiffnessFront: 7000, corneringStiffnessRear: 9500, yawDragK: 0.45,
      powerCurve: [
        { x: 0, y: 2.5 }, { x: 20, y: 4.2 }, { x: 35, y: 4.8 },
        { x: 50, y: 4.5 }, { x: 60, y: 3.5 }, { x: 70, y: 1.5 },
      ],
    },
  },
  {
    label: "Formula Car",
    description:
      "Open-wheel formula car (F3 / F4 class). High downforce (ClA 4.5 m²) means grip improves significantly at speed — " +
      "corner speeds on fast sweepers are much higher than on slow hairpins despite the same μ. " +
      "Rear-limited traction (RWD, 30% diff lock). Brake bias 62% front is typical for a well-balanced setup. " +
      "Setup tip: increase liftArea to explore higher-downforce aero configs. " +
      "Reducing tyreDragK below 0.05 approximates a very clean aero-tyre package.",
    values: {
      mass: 750, dragArea: 1.1, liftArea: 4.5,
      muLat: 2.0, muLon: 2.0, tyreDragK: 0.06,
      curveMode: "torque", finalDrive: 7.0, wheelRadius: 0.33,
      drivetrainLayout: "RWD", brakeBias: 0.62, diffLockRear: 0.3, diffLockFront: 0.0,
      weightDistFront: 0.45, wheelbase: 3.1, trackWidth: 1.8, cgHeight: 0.30,
      yawInertia: 950, steeringLockDeg: 25,
      corneringStiffnessFront: 120000, corneringStiffnessRear: 140000, yawDragK: 0.08,
      powerCurve: [
        { x: 4000, y: 400 }, { x: 7000, y: 520 }, { x: 10000, y: 580 },
        { x: 13000, y: 540 }, { x: 16000, y: 440 }, { x: 18000, y: 330 },
      ],
    },
  },
  {
    label: "GT Car",
    description:
      "GT3 / endurance-class GT car. Heavier than formula, moderate downforce. " +
      "50% rear diff lock models a plated LSD in partial lock. Brake bias 58% front is rear-biased vs formula " +
      "to help rotation on entry. " +
      "Setup tip: CGHeight 0.45 m makes this sensitive to weight transfer — " +
      "raising brakeBias toward 0.62 will improve braking stability at the cost of less rotation.",
    values: {
      mass: 1350, dragArea: 0.9, liftArea: 2.0,
      muLat: 1.6, muLon: 1.6, tyreDragK: 0.07,
      curveMode: "torque", finalDrive: 6.5, wheelRadius: 0.34,
      drivetrainLayout: "RWD", brakeBias: 0.58, diffLockRear: 0.5, diffLockFront: 0.0,
      weightDistFront: 0.46, wheelbase: 2.7, trackWidth: 2.0, cgHeight: 0.45,
      yawInertia: 1800, steeringLockDeg: 30,
      corneringStiffnessFront: 95000, corneringStiffnessRear: 105000, yawDragK: 0.14,
      powerCurve: [
        { x: 2000, y: 500 }, { x: 4000, y: 620 }, { x: 6000, y: 650 },
        { x: 7000, y: 600 }, { x: 8000, y: 500 }, { x: 9000, y: 380 },
      ],
    },
  },
  {
    label: "Road Car",
    description:
      "Typical FWD road car on standard tyres. Front-heavy (60% front weight), high CG. " +
      "Low μ (1.0) reflects street-compound tyres. tyreDragK 0.04 is low — street tyres have good self-aligning torque. " +
      "FWD means traction is front-axle limited; under power the front wheels also steer, " +
      "so the sim will show more understeer penalty than an equivalent RWD car. " +
      "Setup tip: to model a sports-biased road car, shift weightDistFront to 0.52 and raise muLat to 1.2.",
    values: {
      mass: 1500, dragArea: 0.7, liftArea: 0.1,
      muLat: 1.0, muLon: 1.0, tyreDragK: 0.04,
      curveMode: "power", finalDrive: 8.0, wheelRadius: 0.32,
      drivetrainLayout: "FWD", brakeBias: 0.65, diffLockRear: 0.0, diffLockFront: 0.0,
      weightDistFront: 0.60, wheelbase: 2.6, trackWidth: 1.7, cgHeight: 0.55,
      yawInertia: 2200, steeringLockDeg: 34,
      corneringStiffnessFront: 60000, corneringStiffnessRear: 52000, yawDragK: 0.20,
      powerCurve: [
        { x: 0, y: 100 }, { x: 50, y: 120 }, { x: 100, y: 115 },
        { x: 150, y: 100 }, { x: 200, y: 75 }, { x: 250, y: 50 },
      ],
    },
  },
];

const DRIVETRAIN_OPTIONS: DrivetrainLayout[] = ["RWD", "FWD", "4WD"];

const NUM_FIELDS: { key: keyof VehicleParams; label: string; unit: string; min: number; step: number; max?: number }[] = [
  { key: "mass",            label: "Mass",            unit: "kg",  min: 50,   step: 5 },
  { key: "dragArea",        label: "Drag CdA",        unit: "m²",  min: 0.1,  step: 0.05 },
  { key: "liftArea",        label: "Downforce ClA",   unit: "m²",  min: 0,    step: 0.1 },
  { key: "muLat",           label: "Lateral grip μ",  unit: "",    min: 0.5,  step: 0.05 },
  { key: "muLon",           label: "Long. grip μ",    unit: "",    min: 0.5,  step: 0.05 },
  { key: "tyreDragK",       label: "Tyre drag k",     unit: "",    min: 0,    step: 0.01, max: 0.5 },
];

const CHASSIS_FIELDS: { key: keyof VehicleParams; label: string; unit: string; min: number; step: number; max?: number }[] = [
  { key: "weightDistFront", label: "Front weight",    unit: "%",     min: 0.1,  step: 0.01, max: 0.9 },
  { key: "wheelbase",       label: "Wheelbase",       unit: "m",     min: 0.8,  step: 0.05 },
  { key: "trackWidth",      label: "Track width",     unit: "m",     min: 0.8,  step: 0.05 },
  { key: "cgHeight",        label: "CG height",       unit: "m",     min: 0.1,  step: 0.01 },
  { key: "yawInertia",      label: "Yaw inertia",     unit: "kgm²",  min: 10,   step: 10 },
  { key: "steeringLockDeg", label: "Steer lock",      unit: "°",     min: 5,    step: 1,    max: 60 },
  { key: "corneringStiffnessFront", label: "Front Cα", unit: "N/rad", min: 1000, step: 1000 },
  { key: "corneringStiffnessRear",  label: "Rear Cα",  unit: "N/rad", min: 1000, step: 1000 },
  { key: "yawDragK",        label: "Yaw drag k",      unit: "",      min: 0,    step: 0.01, max: 1.0 },
  { key: "brakeBias",       label: "Brake bias (F)",  unit: "%",    min: 0,    step: 0.01, max: 1.0 },
  { key: "diffLockRear",    label: "Rear diff lock",  unit: "",      min: 0,    step: 0.05, max: 1.0 },
  { key: "diffLockFront",   label: "Front diff lock", unit: "",      min: 0,    step: 0.05, max: 1.0 },
];

export function VehicleForm({ params, onChange }: Props) {
  const [showChassis, setShowChassis] = React.useState(false);
  const [selectedPreset, setSelectedPreset] = React.useState("— preset —");
  const presetInfo = PRESETS.find(p => p.label === selectedPreset)?.description ?? "";

  function applyPreset(label: string) {
    setSelectedPreset(label);
    const p = PRESETS.find(pr => pr.label === label);
    if (p && label !== "— preset —") onChange(p.values);
  }

  function numVal(key: keyof VehicleParams): number {
    const v = params[key] as number;
    // display as percentage for 0–1 fraction fields
    if (key === "weightDistFront" || key === "brakeBias") return Math.round(v * 100);
    return v;
  }

  function handleNum(key: keyof VehicleParams, raw: string) {
    let v = parseFloat(raw) || 0;
    if (key === "weightDistFront" || key === "brakeBias") v = v / 100;
    onChange({ ...params, [key]: v });
  }

  return (
    <div style={{ padding: "12px 16px", borderBottom: "1px solid #222" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={header}>Vehicle Parameters</div>
        <select
          value={selectedPreset}
          onChange={e => applyPreset(e.target.value)}
          style={{ fontSize: 11, background: "#1a1a1a", border: "1px solid #333", color: "#aaa", borderRadius: 3, padding: "2px 6px" }}
        >
          {PRESETS.map(p => <option key={p.label} value={p.label}>{p.label}</option>)}
        </select>
      </div>

      {presetInfo && (
        <div style={{
          marginBottom: 10, padding: "8px 10px", background: "#111827",
          border: "1px solid #1f2937", borderRadius: 5,
          fontSize: 11, lineHeight: 1.45, color: "#9ca3af",
        }}>
          {presetInfo}
        </div>
      )}

      {NUM_FIELDS.map(({ key, label, unit, min, step, max }) => (
        <Row key={key} label={label} unit={unit}>
          <NumInput value={numVal(key)} min={min} step={step} max={max} onChange={v => handleNum(key, v)} />
        </Row>
      ))}

      {/* Drivetrain layout */}
      <Row label="Drivetrain" unit="">
        <div style={{ display: "flex", gap: 3 }}>
          {DRIVETRAIN_OPTIONS.map(opt => (
            <button
              key={opt}
              onClick={() => onChange({ ...params, drivetrainLayout: opt })}
              style={{
                padding: "2px 7px", fontSize: 11, borderRadius: 3, cursor: "pointer",
                background: params.drivetrainLayout === opt ? "#1d4ed8" : "#1a1a1a",
                border: `1px solid ${params.drivetrainLayout === opt ? "#3b82f6" : "#333"}`,
                color: params.drivetrainLayout === opt ? "#fff" : "#888",
              }}
            >{opt}</button>
          ))}
        </div>
      </Row>

      {/* Chassis section — collapsible */}
      <button
        onClick={() => setShowChassis(v => !v)}
        style={{ width: "100%", background: "none", border: "none", color: "#555", fontSize: 11, textAlign: "left", cursor: "pointer", padding: "4px 0", letterSpacing: 0.5 }}
      >
        {showChassis ? "▾" : "▸"} Chassis &amp; Brakes
      </button>

      {showChassis && CHASSIS_FIELDS.map(({ key, label, unit, min, step, max }) => (
        <Row key={key} label={label} unit={unit}>
          <NumInput value={numVal(key)} min={min} step={step} max={max} onChange={v => handleNum(key, v)} />
        </Row>
      ))}

      <PowerCurveEditor params={params} onChange={onChange} />
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Row({ label, unit, children }: { label: string; unit: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
      <label style={{ fontSize: 12, color: "#aaa" }}>
        {label}{unit && <span style={{ color: "#555", marginLeft: 4 }}>{unit}</span>}
      </label>
      {children}
    </div>
  );
}

function NumInput({ value, min, step, max, onChange }: { value: number; min: number; step: number; max?: number; onChange: (s: string) => void }) {
  return (
    <input
      type="number" value={value} min={min} step={step} max={max}
      onChange={e => onChange(e.target.value)}
      style={{ width: 90, background: "#1a1a1a", border: "1px solid #333", color: "#e0e0e0", padding: "3px 6px", borderRadius: 3, fontSize: 12 }}
    />
  );
}

const header: React.CSSProperties = { fontSize: 11, fontWeight: 600, letterSpacing: 1, color: "#888", textTransform: "uppercase" };
