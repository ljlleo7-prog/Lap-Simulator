import type { CrossSection } from "../geometry.js";
import type { VehicleParams } from "../vehicle.js";

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

interface Props {
  sections: CrossSection[];
  vehicle: VehicleParams;
  onImportTrack: (s: CrossSection[]) => void;
  onImportVehicle: (v: VehicleParams) => void;
}

export function IoPanel({ sections, vehicle, onImportTrack, onImportVehicle }: Props) {
  return (
    <div style={{ padding: "12px 16px", borderBottom: "1px solid #222" }}>
      <div style={hdr}>Data</div>
      <Row label="Track"
        onExport={() => download("track.json", sections)}
        onImport={() => upload(d => onImportTrack(d as CrossSection[]))}
      />
      <Row label="Vehicle"
        onExport={() => download("vehicle.json", vehicle)}
        onImport={() => upload(d => onImportVehicle(d as VehicleParams))}
      />
    </div>
  );
}

function Row({ label, onExport, onImport }: { label: string; onExport: () => void; onImport: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
      <span style={{ fontSize: 12, color: "#aaa" }}>{label}</span>
      <div style={{ display: "flex", gap: 6 }}>
        <Btn onClick={onImport}>Import</Btn>
        <Btn onClick={onExport}>Export</Btn>
      </div>
    </div>
  );
}

function Btn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      background: "none", border: "1px solid #333", color: "#aaa",
      padding: "3px 10px", borderRadius: 3, cursor: "pointer", fontSize: 11,
    }}>{children}</button>
  );
}

const hdr: React.CSSProperties = { fontSize: 11, fontWeight: 600, letterSpacing: 1, color: "#888", textTransform: "uppercase", marginBottom: 10 };
