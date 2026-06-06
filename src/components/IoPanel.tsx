import type { CrossSection, CentreSample } from "../geometry.js";
import type { VehicleParams } from "../vehicle.js";
import type { Offsets } from "../optimizer.js";

function download(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function upload(onLoad: (data: unknown) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try { onLoad(JSON.parse(reader.result as string)); } catch { /* ignore */ }
    };
    reader.readAsText(file);
  };
  input.click();
}

// Migrate a legacy vehicle JSON that has peakPower but no powerCurve.
function migrateVehicle(raw: Record<string, unknown>): VehicleParams {
  if (!raw.powerCurve && typeof raw.peakPower === "number") {
    // Build a flat power curve: constant kW across the speed range
    const kw = raw.peakPower as number / 1000;
    return {
      mass: (raw.mass as number) ?? 700,
      dragArea: (raw.dragArea as number) ?? 0.9,
      liftArea: (raw.liftArea as number) ?? 3.0,
      muLat: (raw.muLat as number) ?? 1.8,
      muLon: (raw.muLon as number) ?? 1.8,
      tyreDragK: (raw.tyreDragK as number) ?? 0.05,
      curveMode: "power",
      powerCurve: [
        { x: 0,   y: kw },
        { x: 100, y: kw },
        { x: 300, y: kw },
      ],
    };
  }
  return raw as unknown as VehicleParams;
}

// Normalise track import: accept bare array or {sections:[...]} wrapper.
function migrateTrack(raw: unknown): CrossSection[] {
  if (Array.isArray(raw)) return raw as CrossSection[];
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.sections)) return obj.sections as CrossSection[];
  }
  return [];
}

interface RacingLineFile {
  version: 1;
  sampleCount: number;
  trackLength: number; // metres, rounded to 1 decimal for fingerprint
  offsets: number[];   // Float64Array serialised as plain array
}

export function exportRacingLine(offsets: Offsets, centreSamples: CentreSample[]): void {
  const trackLength = centreSamples.length > 0
    ? Math.round(centreSamples[centreSamples.length - 1].distance * 10) / 10
    : 0;
  const file: RacingLineFile = {
    version: 1,
    sampleCount: offsets.length,
    trackLength,
    offsets: Array.from(offsets),
  };
  download("racing-line.json", file);
}

// Returns the loaded offsets, or an error string if validation fails.
export function importRacingLine(
  raw: unknown,
  centreSamples: CentreSample[],
): Float64Array | string {
  if (!raw || typeof raw !== "object") return "Invalid file format.";
  const f = raw as Record<string, unknown>;
  if (f.version !== 1) return "Unknown racing line file version.";
  if (!Array.isArray(f.offsets)) return "Missing offsets array.";

  const expectedCount = centreSamples.length;
  const expectedLength = centreSamples.length > 0
    ? Math.round(centreSamples[centreSamples.length - 1].distance * 10) / 10
    : 0;

  if (f.sampleCount !== expectedCount) {
    return `Sample count mismatch: file has ${f.sampleCount}, track has ${expectedCount}. Load the matching track first.`;
  }
  // Allow 0.5 m tolerance on track length
  if (Math.abs((f.trackLength as number) - expectedLength) > 0.5) {
    return `Track length mismatch: file is ${f.trackLength} m, current track is ${expectedLength} m.`;
  }

  return new Float64Array(f.offsets as number[]);
}

interface Props {
  sections: CrossSection[];
  vehicle: VehicleParams;
  racingLineOffsets: Offsets | null;
  centreSamples: CentreSample[];
  onImportTrack: (s: CrossSection[]) => void;
  onImportVehicle: (v: VehicleParams) => void;
  onImportRacingLine: (offsets: Float64Array) => void;
}

export function IoPanel({
  sections, vehicle, racingLineOffsets, centreSamples,
  onImportTrack, onImportVehicle, onImportRacingLine,
}: Props) {
  function handleRacingLineImport(raw: unknown) {
    const result = importRacingLine(raw, centreSamples);
    if (typeof result === "string") {
      alert(result);
    } else {
      onImportRacingLine(result);
    }
  }

  return (
    <div style={{ padding: "12px 16px", borderBottom: "1px solid #222" }}>
      <div style={hdr}>Data</div>
      <Row label="Track"
        onExport={() => download("track.json", sections)}
        onImport={() => upload(d => onImportTrack(migrateTrack(d)))}
      />
      <Row label="Vehicle"
        onExport={() => download("vehicle.json", vehicle)}
        onImport={() => upload(d => onImportVehicle(migrateVehicle(d as Record<string, unknown>)))}
      />
      <Row
        label="Racing line"
        exportDisabled={!racingLineOffsets}
        onExport={() => racingLineOffsets && exportRacingLine(racingLineOffsets, centreSamples)}
        onImport={() => upload(handleRacingLineImport)}
      />
    </div>
  );
}

function Row({ label, onExport, onImport, exportDisabled = false }: {
  label: string; onExport: () => void; onImport: () => void; exportDisabled?: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
      <span style={{ fontSize: 12, color: "#aaa" }}>{label}</span>
      <div style={{ display: "flex", gap: 6 }}>
        <Btn onClick={onImport}>Import</Btn>
        <Btn onClick={onExport} disabled={exportDisabled}>Export</Btn>
      </div>
    </div>
  );
}

function Btn({ onClick, children, disabled = false }: { onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: "none", border: "1px solid #333", color: disabled ? "#333" : "#aaa",
      padding: "3px 10px", borderRadius: 3, cursor: disabled ? "default" : "pointer", fontSize: 11,
    }}>{children}</button>
  );
}

const hdr: React.CSSProperties = { fontSize: 11, fontWeight: 600, letterSpacing: 1, color: "#888", textTransform: "uppercase", marginBottom: 10 };
