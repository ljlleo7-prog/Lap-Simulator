import type { TrackSegment } from "../track.js";

interface Props {
  segments: TrackSegment[];
  onChange: (s: TrackSegment[]) => void;
}

export function TrackBuilder({ segments, onChange }: Props) {
  function update(i: number, field: keyof TrackSegment, val: string) {
    const next = segments.map((s, j) => {
      if (j !== i) return s;
      if (field === "radius") return { ...s, radius: val === "" || val === "∞" ? Infinity : parseFloat(val) };
      return { ...s, [field]: parseFloat(val) };
    });
    onChange(next);
  }

  function add() {
    onChange([...segments, { length: 200, radius: Infinity }]);
  }

  function remove(i: number) {
    onChange(segments.filter((_, j) => j !== i));
  }

  return (
    <div>
      <h3>Track Segments</h3>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={th}>#</th>
            <th style={th}>Length (m)</th>
            <th style={th}>Radius (m, ∞=straight)</th>
            <th style={th}></th>
          </tr>
        </thead>
        <tbody>
          {segments.map((seg, i) => (
            <tr key={i}>
              <td style={td}>{i + 1}</td>
              <td style={td}>
                <input
                  type="number"
                  value={seg.length}
                  min={1}
                  onChange={(e) => update(i, "length", e.target.value)}
                  style={{ width: 80 }}
                />
              </td>
              <td style={td}>
                <input
                  type="text"
                  value={seg.radius === Infinity ? "∞" : seg.radius}
                  onChange={(e) => update(i, "radius", e.target.value)}
                  style={{ width: 80 }}
                />
              </td>
              <td style={td}>
                <button onClick={() => remove(i)} disabled={segments.length <= 1}>✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={add} style={{ marginTop: 8 }}>+ Add segment</button>
    </div>
  );
}

const th: React.CSSProperties = { textAlign: "left", padding: "4px 8px", borderBottom: "1px solid #ccc" };
const td: React.CSSProperties = { padding: "4px 8px" };
