// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_RECENT_FILES,
  parseStoredRecent,
  recentFileName,
  recentFiles,
  RECENT_STORAGE_KEY,
} from "./recentFiles.svelte";

beforeEach(() => {
  localStorage.clear();
  recentFiles.clear();
});

describe("parseStoredRecent (migration-safe load)", () => {
  it("returns an empty list for a missing value", () => {
    expect(parseStoredRecent(null)).toEqual([]);
    expect(parseStoredRecent(undefined as unknown as string)).toEqual([]);
  });

  it("returns an empty list for corrupt JSON", () => {
    expect(parseStoredRecent("{not json")).toEqual([]);
  });

  it("returns an empty list for non-array stored values", () => {
    expect(parseStoredRecent('{"path":"a.usda"}')).toEqual([]);
    expect(parseStoredRecent('"a string"')).toEqual([]);
  });

  it("skips malformed entries but keeps the valid ones", () => {
    const raw = JSON.stringify([
      { path: "/a.usda", name: "a.usda" },
      { path: 42 },
      "nope",
      null,
      { name: "missing path" },
      { path: "/b.usda", name: "b.usda" },
    ]);
    expect(parseStoredRecent(raw)).toEqual([
      { path: "/a.usda", name: "a.usda" },
      { path: "/b.usda", name: "b.usda" },
    ]);
  });

  it("caps a stored list to the maximum size", () => {
    const raw = JSON.stringify(
      Array.from({ length: 25 }, (_, i) => ({ path: `/f${i}.usda`, name: `f${i}.usda` })),
    );
    expect(parseStoredRecent(raw)).toHaveLength(MAX_RECENT_FILES);
  });
});

describe("recentFiles module load", () => {
  it("loads an empty list over a corrupt stored value and leaves unrelated keys untouched", async () => {
    localStorage.setItem(RECENT_STORAGE_KEY, "}}}corrupt");
    localStorage.setItem("usdbee_theme", "dark");
    localStorage.setItem("unrelated", "keep me");

    // Re-import so the module-level load runs against the corrupt value.
    vi.resetModules();
    const { recentFiles: fresh } = await import("./recentFiles.svelte");

    expect(fresh.entries).toEqual([]);
    expect(localStorage.getItem("usdbee_theme")).toBe("dark");
    expect(localStorage.getItem("unrelated")).toBe("keep me");
  });

  it("restores persisted entries on load", async () => {
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify([{ path: "/scene/a.usda", name: "a.usda" }]));

    vi.resetModules();
    const { recentFiles: fresh } = await import("./recentFiles.svelte");

    expect(fresh.entries).toEqual([{ path: "/scene/a.usda", name: "a.usda" }]);
  });
});

describe("recentFileName", () => {
  it("takes the last path segment", () => {
    expect(recentFileName("/scene/sub/bike.usda")).toBe("bike.usda");
    expect(recentFileName("C:\\assets\\model.usd")).toBe("model.usd");
  });
});

describe("add", () => {
  it("adds entries most-recent-first with the file name", () => {
    recentFiles.add("/scene/a.usda");
    recentFiles.add("/scene/b.usdc");

    expect(recentFiles.entries).toEqual([
      { path: "/scene/b.usdc", name: "b.usdc" },
      { path: "/scene/a.usda", name: "a.usda" },
    ]);
  });

  it("moves an existing path to the front instead of duplicating", () => {
    recentFiles.add("/scene/a.usda");
    recentFiles.add("/scene/b.usda");
    recentFiles.add("/scene/a.usda");

    expect(recentFiles.entries).toEqual([
      { path: "/scene/a.usda", name: "a.usda" },
      { path: "/scene/b.usda", name: "b.usda" },
    ]);
  });

  it("caps the list at 10, evicting the oldest", () => {
    for (let i = 0; i < 12; i++) recentFiles.add(`/scene/f${i}.usda`);

    expect(recentFiles.entries).toHaveLength(10);
    expect(recentFiles.entries[0]).toEqual({ path: "/scene/f11.usda", name: "f11.usda" });
    expect(recentFiles.entries.map((e) => e.path)).not.toContain("/scene/f0.usda");
    expect(recentFiles.entries.map((e) => e.path)).not.toContain("/scene/f1.usda");
    expect(recentFiles.entries.map((e) => e.path)).toContain("/scene/f2.usda");
  });

  it("persists to localStorage", () => {
    recentFiles.add("/scene/a.usda");

    expect(JSON.parse(localStorage.getItem(RECENT_STORAGE_KEY)!)).toEqual([
      { path: "/scene/a.usda", name: "a.usda" },
    ]);
  });
});

describe("remove", () => {
  it("removes only the matching path", () => {
    recentFiles.add("/scene/a.usda");
    recentFiles.add("/scene/b.usda");
    recentFiles.add("/scene/c.usda");

    recentFiles.remove("/scene/b.usda");

    expect(recentFiles.entries.map((e) => e.path)).toEqual(["/scene/c.usda", "/scene/a.usda"]);
    expect(JSON.parse(localStorage.getItem(RECENT_STORAGE_KEY)!)).toHaveLength(2);
  });
});

describe("clear", () => {
  it("empties the list and the storage", () => {
    recentFiles.add("/scene/a.usda");
    recentFiles.add("/scene/b.usda");

    recentFiles.clear();

    expect(recentFiles.entries).toEqual([]);
    expect(JSON.parse(localStorage.getItem(RECENT_STORAGE_KEY)!)).toEqual([]);
  });
});
