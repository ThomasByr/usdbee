// Pure helpers behind the command palette's suggestion lists and result
// panel. No DOM, no reactive state.

export interface Suggestion {
  value: string;
  is_dir: boolean;
}

/** A suggestion row cap: the Rust side returns up to 500 entries and a manifest
 * can hold thousands of prims. */
const SUGGEST_ROW_CAP = 100;

/**
 * Split a typed path into the directory a backend lists and the seed the
 * client filters by. Mirrors the Rust `suggest_dir_entries` prefix rule: only a
 * trailing partial component is a seed.
 */
export function splitPrefix(prefix: string): { parent: string; seed: string } {
  if (prefix === "" || prefix === "~" || prefix.endsWith("/")) return { parent: prefix, seed: "" };
  const at = prefix.lastIndexOf("/");
  if (at < 0) return { parent: "", seed: prefix };
  return { parent: prefix.slice(0, at) || "/", seed: prefix.slice(at + 1) };
}

function join(parent: string, name: string, isDir: boolean): string {
  const base = parent === "" || parent.endsWith("/") ? parent : `${parent}/`;
  return `${base}${name}${isDir ? "/" : ""}`;
}

/** The directory a typed prefix belongs to, in one stable spelling: `~/mod`
 * and `~/` both key `~/`, so a listing cached for one serves the other. */
export function dirKey(prefix: string): string {
  const { parent } = splitPrefix(prefix);
  if (parent === "" || parent.endsWith("/")) return parent;
  return `${parent}/`;
}

/** Directory rows for the focused `file_path` field, filtered by the typed seed. */
export function filterDirEntries(prefix: string, entries: { name: string; is_dir: boolean }[]): Suggestion[] {
  const { parent, seed } = splitPrefix(prefix);
  const needle = seed.toLowerCase();
  return entries
    .filter((entry) => !needle || entry.name.toLowerCase().includes(needle))
    .map((entry) => ({ value: join(parent, entry.name, entry.is_dir), is_dir: entry.is_dir }));
}

/** Prim rows for the focused `prim_path` field, filtered by the typed text. */
export function filterPrimPaths(query: string, paths: string[]): Suggestion[] {
  const needle = query.trim().toLowerCase();
  return paths
    .filter((path) => !needle || path.toLowerCase().includes(needle))
    .slice(0, SUGGEST_ROW_CAP)
    .map((path) => ({ value: path, is_dir: false }));
}

/** Arrow-key movement over a suggestion list: the ends wrap to each other. */
export function stepSuggestion(index: number, delta: -1 | 1, count: number): number {
  if (count <= 0) return 0;
  return (index + delta + count) % count;
}

/** The screenshot payload's base64, when the payload carries one. */
export function pngBase64(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as { png_base64?: unknown }).png_base64;
  return typeof value === "string" ? value : null;
}

/** Result panel text: pretty JSON for payloads, the message for errors. */
export function resultText(result: { ok: boolean; payload: unknown }): string {
  if (!result.ok) return String(result.payload);
  return JSON.stringify(result.payload, null, 2) ?? "null";
}
