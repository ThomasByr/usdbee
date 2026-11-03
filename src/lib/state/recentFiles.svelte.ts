// Recent files (Task 12): the persisted `usdbee_recent` list. Entries are
// `{ path, name }` pairs, most-recent-first, capped at 10. Recorded on
// every successful open (dialog, drag-drop, recent list itself).

export interface RecentFileEntry {
  path: string;
  name: string;
}

export const RECENT_STORAGE_KEY = "usdbee_recent";
export const MAX_RECENT_FILES = 10;

// The display name of a recent entry: the last path segment.
export function recentFileName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

// Migration-safe parse: a missing, corrupt or malformed stored value
// collapses to an empty list; well-formed entries survive as-is.
export function parseStoredRecent(raw: string | null): RecentFileEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const entries: RecentFileEntry[] = [];
    for (const item of parsed) {
      if (entries.length >= MAX_RECENT_FILES) break;
      if (
        typeof item === "object" &&
        item !== null &&
        typeof (item as RecentFileEntry).path === "string" &&
        typeof (item as RecentFileEntry).name === "string"
      ) {
        entries.push({ path: (item as RecentFileEntry).path, name: (item as RecentFileEntry).name });
      }
    }
    return entries;
  } catch {
    return [];
  }
}

function persist(entries: RecentFileEntry[]): void {
  localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(entries));
}

export const recentFiles = $state({
  entries: parseStoredRecent(localStorage.getItem(RECENT_STORAGE_KEY)),

  // Dedupe by path: an existing entry moves to the front.
  add(path: string): void {
    const name = recentFileName(path);
    this.entries = [{ path, name }, ...this.entries.filter((e) => e.path !== path)].slice(
      0,
      MAX_RECENT_FILES,
    );
    persist(this.entries);
  },

  remove(path: string): void {
    this.entries = this.entries.filter((e) => e.path !== path);
    persist(this.entries);
  },

  clear(): void {
    this.entries = [];
    persist(this.entries);
  },
});
