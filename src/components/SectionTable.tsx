import type { CrossSection } from "../geometry.js";

interface Props {
  sections: CrossSection[];
  selectedId: string | null;
  onChange: (s: CrossSection[]) => void;
  onSelect: (id: string | null) => void;
}

export function SectionTable({ sections, selectedId, onChange, onSelect }: Props) {
  function update(id: string, field: keyof CrossSection, val: string) {
    onChange(sections.map(s => s.id !== id ? s : { ...s, [field]: parseFloat(val) || 0 }));
  }

  function add() {
    const last = sections[sections.length - 1];
    const id = crypto.randomUUID();
    onChange([...sections, { id, x: (last?.x ?? 0) + 50, y: last?.y ?? 0, direction: last?.direction ?? 0, width: last?.width ?? 10 }]);
    onSelect(id);
  }

  function remove(id: string) {
    if (sections.length <= 2) return;
    onChange(sections.filter(s => s.id !== id));
    if (selectedId === id) onSelect(null);
  }

  return (
    <div style={panel}>
      <div style={panelHeader}>Track Sections</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
          <thead>
            <tr>
              {["", "#", "X (m)", "Y (m)", "Dir (°)", "W (m)"].map(h => (
                <th key={h} style={th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sections.map((s, i) => (
              <tr
                key={s.id}
                onClick={() => onSelect(s.id === selectedId ? null : s.id)}
                style={{ background: s.id === selectedId ? "#1e3a5f" : "transparent", cursor: "pointer" }}
              >
                <td style={td}>
                  <button
                    onClick={e => { e.stopPropagation(); remove(s.id); }}
                    disabled={sections.length <= 2}
                    style={removeBtn}
                  >✕</button>
                </td>
                <td style={td}>{i + 1}</td>
                {(["x", "y", "direction", "width"] as const).map(f => (
                  <td key={f} style={td}>
                    <input
                      type="number"
                      value={s[f]}
                      step={f === "direction" ? 5 : 1}
                      onClick={e => e.stopPropagation()}
                      onChange={e => update(s.id, f, e.target.value)}
                      style={numInput}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button onClick={add} style={addBtn}>+ Add section</button>
    </div>
  );
}

const panel: React.CSSProperties = { padding: "12px 16px", borderBottom: "1px solid #222" };
const panelHeader: React.CSSProperties = { fontSize: 11, fontWeight: 600, letterSpacing: 1, color: "#888", textTransform: "uppercase", marginBottom: 10 };
const th: React.CSSProperties = { textAlign: "left", padding: "4px 6px", color: "#666", fontWeight: 400 };
const td: React.CSSProperties = { padding: "2px 4px" };
const numInput: React.CSSProperties = { width: 58, background: "#1a1a1a", border: "1px solid #333", color: "#e0e0e0", padding: "2px 4px", borderRadius: 3, fontSize: 12 };
const removeBtn: React.CSSProperties = { background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 14, padding: "0 4px" };
const addBtn: React.CSSProperties = { marginTop: 10, background: "none", border: "1px solid #333", color: "#aaa", padding: "5px 12px", cursor: "pointer", borderRadius: 4, fontSize: 12, width: "100%" };
