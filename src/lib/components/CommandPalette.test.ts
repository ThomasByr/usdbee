// @vitest-environment happy-dom
// The overlay closes only for a press that starts on it. A click that lands
// on the overlay because the form reflowed under the pointer (focusing a
// lower argument field collapses the suggestion list above it) must not close
// the form and lose the values already typed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({ entries: [] })) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("$lib/commands/dispatch", () => ({
  dispatchCommand: vi.fn(),
  fetchManifest: vi.fn(async () => []),
}));

import CommandPalette from "./CommandPalette.svelte";
import { COMMANDS, type Command } from "$lib/commands/registry.mjs";
import { paletteState } from "$lib/state/commandPaletteState.svelte";

let instance: ReturnType<typeof mount> | null = null;

function command(name: string): Command {
  const found = COMMANDS.find((cmd) => cmd.name === name);
  if (!found) throw new Error(`no command ${name}`);
  return found;
}

beforeEach(async () => {
  paletteState.openPalette();
  paletteState.startContext(command("search_objects"));
  instance = mount(CommandPalette, { target: document.body });
  await tick();
});

afterEach(() => {
  if (instance !== null) unmount(instance);
  instance = null;
  paletteState.closePalette();
  document.body.innerHTML = "";
});

describe("palette overlay dismissal", () => {
  it("closes on a press that starts on the overlay", async () => {
    const overlay = document.querySelector<HTMLDivElement>(".palette-overlay")!;

    overlay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await tick();

    expect(paletteState.open).toBe(false);
  });

  it("keeps the form when the click only lands on the overlay after a reflow", async () => {
    const field = document.querySelector<HTMLDivElement>(".palette-field")!;
    const overlay = document.querySelector<HTMLDivElement>(".palette-overlay")!;

    // The press starts inside the form; the browser then dispatches the click
    // at the overlay because the focused field's input moved.
    field.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    expect(paletteState.open).toBe(true);
    expect(paletteState.context?.values).toEqual({ query: "", limit: "" });
  });
});
