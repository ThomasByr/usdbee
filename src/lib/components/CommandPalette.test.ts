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
import { invoke } from "@tauri-apps/api/core";
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

describe("palette path listing cache", () => {
  const entries = [
    { name: "Models", is_dir: true },
    { name: "model.usda", is_dir: false },
    { name: "bike.usda", is_dir: false },
  ];

  function rows(): string[] {
    return [...document.querySelectorAll(".suggestion")].map((el) => el.textContent?.trim() ?? "");
  }

  async function settle(): Promise<void> {
    await tick();
    await vi.advanceTimersByTimeAsync(200);
    await tick();
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockResolvedValue({ entries });
    paletteState.startContext(command("load_scene"));
    await settle();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists a directory once the debounce elapses", async () => {
    expect(rows()).toEqual(["~/Models/", "~/model.usda", "~/bike.usda"]);
  });

  it("filters the cached listing with no further call", async () => {
    paletteState.setValue("path", "~/mod");
    await tick();

    expect(rows()).toEqual(["~/Models/", "~/model.usda"]);
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
  });

  it("asks again when the typed path enters another directory", async () => {
    paletteState.setValue("path", "~/Models/");
    await settle();

    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("suggest_dir_entries", {
      prefix: "~/Models/",
    });
  });
});
