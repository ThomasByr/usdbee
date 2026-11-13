// @vitest-environment happy-dom
// Binding matching for the configurable keybindings: a single key, or
// `mod+<key>` for the platform's command modifier.

import { describe, expect, it } from "vitest";
import { matchesBinding } from "./keys";

function key(init: KeyboardEventInit & { key: string }): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

describe("matchesBinding", () => {
  it("matches mod+p on Ctrl+P and Cmd+P, not on plain p", () => {
    expect(matchesBinding(key({ key: "p", ctrlKey: true }), "mod+p")).toBe(true);
    expect(matchesBinding(key({ key: "p", metaKey: true }), "mod+p")).toBe(true);
    expect(matchesBinding(key({ key: "p" }), "mod+p")).toBe(false);
  });

  it("is case-insensitive on the key", () => {
    expect(matchesBinding(key({ key: "P", ctrlKey: true }), "mod+p")).toBe(true);
    expect(matchesBinding(key({ key: "Z" }), "z")).toBe(true);
  });

  it('matches " " on Space alone', () => {
    expect(matchesBinding(key({ key: " " }), " ")).toBe(true);
    expect(matchesBinding(key({ key: " ", ctrlKey: true }), " ")).toBe(false);
  });

  it('matches "z" on plain z only', () => {
    expect(matchesBinding(key({ key: "z" }), "z")).toBe(true);
    expect(matchesBinding(key({ key: "z", ctrlKey: true }), "z")).toBe(false);
    expect(matchesBinding(key({ key: "z", metaKey: true }), "z")).toBe(false);
    expect(matchesBinding(key({ key: "z", altKey: true }), "z")).toBe(false);
  });

  it("matches named keys like shift", () => {
    expect(matchesBinding(key({ key: "Shift" }), "shift")).toBe(true);
    expect(matchesBinding(key({ key: "Shift", ctrlKey: true }), "shift")).toBe(false);
  });

  it("does not match a different key", () => {
    expect(matchesBinding(key({ key: "o", ctrlKey: true }), "mod+p")).toBe(false);
    expect(matchesBinding(key({ key: "q" }), "z")).toBe(false);
  });

  it("matches nothing for an empty binding", () => {
    expect(matchesBinding(key({ key: "p" }), "")).toBe(false);
  });
});
