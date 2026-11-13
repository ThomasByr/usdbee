// Pure palette helpers: splitting a typed path prefix into the directory the
// backend lists plus the seed the client filters by, and the result panel's
// payload rendering.

import { describe, expect, it } from "vitest";
import { filterDirEntries, filterPrimPaths, pngBase64, resultText, splitPrefix } from "./palette";

const entries = [
  { name: "Code", is_dir: true },
  { name: "cover.png", is_dir: false },
  { name: "bike.usd", is_dir: false },
  { name: "couch.usda", is_dir: false },
];

describe("splitPrefix", () => {
  it("splits a partially typed last component", () => {
    expect(splitPrefix("~/Code/us")).toEqual({ parent: "~/Code", seed: "us" });
    expect(splitPrefix("/usr/loc")).toEqual({ parent: "/usr", seed: "loc" });
  });

  it("lists a directory with no seed when the path ends in a separator", () => {
    expect(splitPrefix("~/Code/")).toEqual({ parent: "~/Code/", seed: "" });
    expect(splitPrefix("/")).toEqual({ parent: "/", seed: "" });
    expect(splitPrefix("~/")).toEqual({ parent: "~/", seed: "" });
  });

  it("treats home as a directory, not a seed", () => {
    expect(splitPrefix("~")).toEqual({ parent: "~", seed: "" });
    expect(splitPrefix("")).toEqual({ parent: "", seed: "" });
  });
});

describe("filterDirEntries", () => {
  it("keeps only entries whose name contains the typed seed", () => {
    expect(filterDirEntries("~/Code/us", entries)).toEqual([
      { value: "~/Code/bike.usd", is_dir: false },
      { value: "~/Code/couch.usda", is_dir: false },
    ]);
  });

  it("builds full paths for every entry when there is no seed", () => {
    expect(filterDirEntries("~/Code/", entries).map((s) => s.value)).toEqual([
      "~/Code/Code/",
      "~/Code/cover.png",
      "~/Code/bike.usd",
      "~/Code/couch.usda",
    ]);
  });

  it("joins from home and from the filesystem root", () => {
    expect(filterDirEntries("~", [{ name: "Code", is_dir: true }])).toEqual([
      { value: "~/Code/", is_dir: true },
    ]);
    expect(filterDirEntries("/", [{ name: "usr", is_dir: true }])).toEqual([
      { value: "/usr/", is_dir: true },
    ]);
  });

  it("accepts a directory from the seeded home prefix", () => {
    expect(filterDirEntries("~/", entries)).toEqual([
      { value: "~/Code/", is_dir: true },
      { value: "~/cover.png", is_dir: false },
      { value: "~/bike.usd", is_dir: false },
      { value: "~/couch.usda", is_dir: false },
    ]);
  });

  it("matches the seed case-insensitively", () => {
    expect(filterDirEntries("~/Code/CO", entries).map((s) => s.value)).toEqual([
      "~/Code/Code/",
      "~/Code/cover.png",
      "~/Code/couch.usda",
    ]);
  });
});

describe("filterPrimPaths", () => {
  const paths = ["/World", "/World/Bike", "/World/Bike/Wheel", "/Environment"];

  it("keeps prim paths containing the typed text", () => {
    expect(filterPrimPaths("wheel", paths).map((s) => s.value)).toEqual(["/World/Bike/Wheel"]);
  });

  it("lists every path for an empty query", () => {
    expect(filterPrimPaths("", paths)).toHaveLength(paths.length);
  });

  it("caps the rows it returns", () => {
    const many = Array.from({ length: 500 }, (_, i) => `/Prim${i}`);
    expect(filterPrimPaths("", many).length).toBeLessThanOrEqual(100);
  });
});

describe("result panel", () => {
  it("reads the base64 out of a screenshot payload", () => {
    expect(pngBase64({ png_base64: "AAAA" })).toBe("AAAA");
    expect(pngBase64({ png_base64: 4 })).toBeNull();
    expect(pngBase64({ stage_loaded: true })).toBeNull();
    expect(pngBase64("plain")).toBeNull();
    expect(pngBase64(null)).toBeNull();
  });

  it("pretty-prints a JSON payload and shows errors verbatim", () => {
    expect(resultText({ ok: true, payload: { a: 1 } })).toBe('{\n  "a": 1\n}');
    expect(resultText({ ok: false, payload: "no viewport available" })).toBe("no viewport available");
    expect(resultText({ ok: true, payload: undefined })).toBe("null");
  });
});
