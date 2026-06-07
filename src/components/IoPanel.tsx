import { useState } from "react";
import type { CrossSection, CentreSample } from "../geometry.js";
import type { VehicleParams } from "../vehicle.js";
import type { Offsets } from "../optimizer.js";

// ── file helpers ──────────────────────────────────────────────────────────────

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
  input.type = "file"; input.accept = ".json";
  input.onchange = () => {
    const file = input.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { try { onLoad(JSON.parse(reader.result as string)); } catch { /* ignore */ } };
    reader.readAsText(file);
  };
  input.click();
}

// ── migration helpers ─────────────────────────────────────────────────────────

function migrateVehicle(raw: Record<string, unknown>): VehicleParams {
  const defaults: Partial<VehicleParams> = {
    drivetrainLayout: "RWD",
    brakeBias: 0.6,
    diffLockRear: 0.0,
    diffLockFront: 0.0,
    weightDistFront: 0.45,
    wheelbase: 2.5,
    trackWidth: 1.8,
    cgHeight: 0.35,
  };
  if (!raw.powerCurve && typeof raw.peakPower === "number") {
    const kw = (raw.peakPower as number) / 1000;
    return {
      ...defaults,
      mass: (raw.mass as number) ?? 700,
      dragArea: (raw.dragArea as number) ?? 0.9,
      liftArea: (raw.liftArea as number) ?? 3.0,
      muLat: (raw.muLat as number) ?? 1.8,
      muLon: (raw.muLon as number) ?? 1.8,
      tyreDragK: (raw.tyreDragK as number) ?? 0.05,
      curveMode: "power",
      powerCurve: [{ x: 0, y: kw }, { x: 100, y: kw }, { x: 300, y: kw }],
    } as VehicleParams;
  }
  return { ...defaults, ...raw } as VehicleParams;
}

function migrateTrack(raw: unknown): CrossSection[] {
  if (Array.isArray(raw)) return raw as CrossSection[];
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.sections)) return obj.sections as CrossSection[];
  }
  return [];
}

// ── racing line file format ───────────────────────────────────────────────────

interface RacingLineFile {
  version: 1;
  sampleCount: number;
  trackLength: number;
  offsets: number[];
}

export function exportRacingLine(offsets: Offsets, centreSamples: CentreSample[], name: string) {
  const trackLength = centreSamples.length > 0
    ? Math.round(centreSamples[centreSamples.length - 1].distance * 10) / 10 : 0;
  const file: RacingLineFile = { version: 1, sampleCount: offsets.length, trackLength, offsets: Array.from(offsets) };
  download(`${name || "racing-line"}.json`, file);
}

export function importRacingLine(raw: unknown, centreSamples: CentreSample[]): Float64Array | string {
  if (!raw || typeof raw !== "object") return "Invalid file format.";
  const f = raw as Record<string, unknown>;
  if (f.version !== 1) return "Unknown racing line file version.";
  if (!Array.isArray(f.offsets)) return "Missing offsets array.";
  const expectedCount = centreSamples.length;
  const expectedLength = centreSamples.length > 0
    ? Math.round(centreSamples[centreSamples.length - 1].distance * 10) / 10 : 0;
  if (f.sampleCount !== expectedCount)
    return `Sample count mismatch: file has ${f.sampleCount}, track has ${expectedCount}. Load the matching track first.`;
  if (Math.abs((f.trackLength as number) - expectedLength) > 0.5)
    return `Track length mismatch: file is ${f.trackLength} m, current track is ${expectedLength} m.`;
  return new Float64Array(f.offsets as number[]);
}

// ── Car Setup I/O panel ───────────────────────────────────────────────────────

interface CarIoProps {
  vehicle: VehicleParams;
  sessionName: string;
  onImportVehicle: (v: VehicleParams) => void;
}

export function CarIoPanel({ vehicle, sessionName, onImportVehicle }: CarIoProps) {
  const name = sessionName.trim() || "vehicle";
  return (
    <div style={section}>
      <div style={hdr}>Files</div>
      <Row label="Vehicle"
        onExport={() => download(`${name}.json`, vehicle)}
        onImport={() => upload(d => onImportVehicle(migrateVehicle(d as Record<string, unknown>)))}
      />
    </div>
  );
}

// ── Track & Opt I/O panel ─────────────────────────────────────────────────────

interface TrackIoProps {
  sections: CrossSection[];
  racingLineOffsets: Offsets | null;
  centreSamples: CentreSample[];
  sessionName: string;
  onImportTrack: (s: CrossSection[]) => void;
  onImportRacingLine: (offsets: Float64Array) => void;
}

export function TrackIoPanel({
  sections, racingLineOffsets, centreSamples, sessionName,
  onImportTrack, onImportRacingLine,
}: TrackIoProps) {
  const trackName = sessionName.trim() || "track";

  function handleRacingLineImport(raw: unknown) {
    const result = importRacingLine(raw, centreSamples);
    if (typeof result === "string") alert(result);
    else onImportRacingLine(result);
  }

  return (
    <div style={section}>
      <div style={hdr}>Files</div>
      <Row label="Track"
        onExport={() => download(`${trackName}.json`, sections)}
        onImport={() => upload(d => onImportTrack(migrateTrack(d)))}
      />
      <Row label="Racing line"
        exportDisabled={!racingLineOffsets}
        onExport={() => racingLineOffsets && exportRacingLine(racingLineOffsets, centreSamples, trackName)}
        onImport={() => upload(handleRacingLineImport)}
      />
    </div>
  );
}

// ── shared primitives ─────────────────────────────────────────────────────────

function Row({ label, onExport, onImport, exportDisabled = false }: {
  label: string; onExport: () => void; onImport: () => void; exportDisabled?: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
      <span style={{ fontSize: 11, color: "#aaa" }}>{label}</span>
      <div style={{ display: "flex", gap: 5 }}>
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
      padding: "2px 8px", borderRadius: 3, cursor: disabled ? "default" : "pointer", fontSize: 11,
    }}>{children}</button>
  );
}

const section: React.CSSProperties = { padding: "10px 14px", borderBottom: "1px solid #1e1e1e" };
const hdr: React.CSSProperties = { fontSize: 10, fontWeight: 600, letterSpacing: 1, color: "#555", textTransform: "uppercase", marginBottom: 8 };
