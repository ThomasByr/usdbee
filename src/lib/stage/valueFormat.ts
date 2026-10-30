import type { ValuePayload } from "./types";

// Number formatting: 6 significant digits trim f32/f64 JSON noise (0.30000001192... -> 0.3)
// without hiding small magnitudes the way toFixed would.
function num(n: unknown): string {
  const v = Number(n);
  if (Number.isInteger(v)) return String(v);
  return String(parseFloat(v.toPrecision(6)));
}

// Row-major matrices (matrix2d/3d/4d and their _arrays) render one bracketed
// row per line; ValueView switches to pre-formatted multiline display for them.
function formatMatrix(cells: unknown[], size: number): string {
  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += size) {
    rows.push(
      "[" +
        cells
          .slice(i, i + size)
          .map(num)
          .join(", ") +
        "]",
    );
  }
  return rows.join("\n");
}

function matrixSize(type: string): number | null {
  if (type === "matrix2d") return 2;
  if (type === "matrix3d") return 3;
  if (type === "matrix4d") return 4;
  return null;
}

function formatScalar(x: unknown): string {
  if (Array.isArray(x)) return "[" + x.map(formatScalar).join(", ") + "]";
  if (typeof x === "number") return num(x);
  return String(x);
}

export function formatValue(value: ValuePayload): string {
  const { type, data } = value;
  if (type === "unauthored" || data === null || data === undefined) return "unauthored";
  const size = matrixSize(type);
  if (size !== null && Array.isArray(data)) return formatMatrix(data, size);
  if (type.startsWith("matrix") && type.endsWith("_array") && Array.isArray(data)) {
    const inner = matrixSize(type.slice(0, -6))!;
    return (data as unknown[][]).map((m) => formatMatrix(m, inner)).join("\n\n");
  }
  if (Array.isArray(data)) return formatScalar(data);
  return formatScalar(data);
}
