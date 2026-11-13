// @vitest-environment happy-dom
// The palette's state transitions: filtering, the argument form, the
// execute/parse contract and where a result goes.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../commands/dispatch", () => ({ dispatchCommand: vi.fn() }));

import { COMMANDS, type Command } from "../commands/registry.mjs";
import { dispatchCommand } from "../commands/dispatch";
import { controlsState } from "./controlsState.svelte";
import { paletteHooks, paletteState } from "./commandPaletteState.svelte";
import { tabsState } from "./tabsState.svelte";

const mockedDispatch = vi.mocked(dispatchCommand);
const defaultCommand = paletteHooks.command;

const activateRecent = vi.fn(async () => {});
const cycleTab = vi.fn(async (_delta: 1 | -1) => {});
const swapTab = vi.fn((_delta: 1 | -1) => {});
// The runner every test replaces unless it asserts the real dispatch route.
const run = vi.fn(async (_name: string, _args: Record<string, unknown>): Promise<unknown> => ({}));

function command(name: string): Command {
  const found = COMMANDS.find((cmd) => cmd.name === name);
  if (!found) throw new Error(`no command ${name}`);
  return found;
}

beforeEach(() => {
  mockedDispatch.mockReset().mockResolvedValue({ ok: true });
  run.mockReset().mockResolvedValue({});
  paletteHooks.command = run;
  activateRecent.mockClear();
  cycleTab.mockClear();
  swapTab.mockClear();
  tabsState.activateRecent = activateRecent;
  tabsState.cycleTab = cycleTab;
  tabsState.swapTab = swapTab;

  paletteState.open = false;
  paletteState.query = "";
  paletteState.highlighted = 0;
  paletteState.context = null;
  paletteState.fieldHint = null;
  paletteState.result = null;
  delete (controlsState as unknown as { paletteTabExecutes?: boolean }).paletteTabExecutes;
});

describe("open and close", () => {
  it("opens empty and closes back to nothing", () => {
    paletteState.query = "z";
    paletteState.highlighted = 4;

    paletteState.openPalette();

    expect(paletteState.open).toBe(true);
    expect(paletteState.query).toBe("");
    expect(paletteState.highlighted).toBe(0);

    paletteState.startContext(command("load_scene"));
    paletteState.closePalette();

    expect(paletteState.open).toBe(false);
    expect(paletteState.context).toBeNull();
    expect(paletteState.query).toBe("");
  });
});

describe("matches", () => {
  it("lists every command for an empty query", () => {
    const { nameMatches, descriptionMatches } = paletteState.matches();

    expect(nameMatches.map((cmd) => cmd.name)).toEqual(COMMANDS.map((cmd) => cmd.name));
    expect(descriptionMatches).toEqual([]);
  });

  it("ranks name matches above description matches without duplicates", () => {
    paletteState.query = "shot";

    const { nameMatches, descriptionMatches } = paletteState.matches();

    expect(nameMatches[0].name).toBe("screenshot");
    const names = [...nameMatches, ...descriptionMatches].map((cmd) => cmd.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("context form", () => {
  it("seeds only file_path args with ~/", () => {
    paletteState.startContext(command("load_scene"));
    expect(paletteState.context?.values).toEqual({ path: "~/" });
    expect(paletteState.context?.focus).toBe(0);

    paletteState.startContext(command("select_node"));
    expect(paletteState.context?.values).toEqual({ path: "" });

    paletteState.startContext(command("transform_object"));
    expect(paletteState.context?.values).toEqual({ path: "", position: "", rotation: "", scale: "" });
  });

  it("writes values and clamps the focused field", () => {
    paletteState.startContext(command("set_camera"));

    paletteState.setValue("fov", "60");
    paletteState.setFocus(5);

    expect(paletteState.context?.values.fov).toBe("60");
    expect(paletteState.context?.focus).toBe(2);

    paletteState.setFocus(-3);
    expect(paletteState.context?.focus).toBe(0);
  });

  it("backspace on an empty field exits the form but keeps the query", () => {
    paletteState.query = "cam";
    paletteState.startContext(command("set_camera"));

    paletteState.backspaceOnEmpty();

    expect(paletteState.context).toBeNull();
    expect(paletteState.query).toBe("cam");
  });

  it("backspace on a filled field does nothing", () => {
    paletteState.startContext(command("set_camera"));
    paletteState.setValue("position", "1");
    paletteState.setFocus(0);

    paletteState.backspaceOnEmpty();

    expect(paletteState.context?.values.position).toBe("1");
  });

  it("backspace treats a whitespace-only field as empty", () => {
    paletteState.query = "cam";
    paletteState.startContext(command("set_camera"));
    paletteState.setValue("fov", "  ");

    paletteState.backspaceOnEmpty();

    expect(paletteState.context).toBeNull();
    expect(paletteState.query).toBe("cam");
  });

  it("backspace exits a context whose focused index has no arg", () => {
    paletteState.startContext(command("pause"));

    paletteState.backspaceOnEmpty();

    expect(paletteState.context).toBeNull();
  });

  it("backspace on the empty query clears a result back to the selector", () => {
    paletteState.openPalette();
    paletteState.result = { ok: true, payload: { stage_loaded: true } };

    paletteState.backspaceOnEmpty();

    expect(paletteState.result).toBeNull();
    expect(paletteState.open).toBe(true);
  });
});

describe("submit parsing", () => {
  it("refuses to dispatch an empty required field", async () => {
    paletteState.openPalette();
    paletteState.startContext(command("load_scene"));
    paletteState.setValue("path", "");

    await paletteState.submit();

    expect(paletteState.fieldHint).toBeTruthy();
    expect(run).not.toHaveBeenCalled();
    expect(paletteState.open).toBe(true);
    expect(paletteState.context).not.toBeNull();
  });

  it("parses numbers and rejects invalid or non-integer ones", async () => {
    paletteState.startContext(command("inspect_scene"));
    paletteState.setValue("max_depth", "3");
    await paletteState.submit();
    expect(run).toHaveBeenCalledWith("inspect_scene", { max_depth: 3 });

    run.mockClear();
    paletteState.fieldHint = null;
    paletteState.setValue("max_depth", "3.5");
    await paletteState.submit();
    expect(run).not.toHaveBeenCalled();
    expect(paletteState.fieldHint).toBeTruthy();

    paletteState.setValue("max_depth", "deep");
    await paletteState.submit();
    expect(run).not.toHaveBeenCalled();
    expect(paletteState.fieldHint).toBeTruthy();
  });

  it("accepts a fractional number where the arg is not an int", async () => {
    paletteState.startContext(command("set_time"));
    paletteState.setValue("time", "1.5");

    await paletteState.submit();

    expect(run).toHaveBeenCalledWith("set_time", { time: 1.5 });
  });

  it("parses vec3 values split on spaces or commas", async () => {
    paletteState.startContext(command("set_camera"));
    paletteState.setValue("position", "1 2 3");
    await paletteState.submit();
    expect(run).toHaveBeenCalledWith("set_camera", { position: [1, 2, 3] });

    run.mockClear();
    paletteState.startContext(command("set_camera"));
    paletteState.setValue("position", "1,2.5,-3");
    await paletteState.submit();
    expect(run).toHaveBeenCalledWith("set_camera", { position: [1, 2.5, -3] });
  });

  it("rejects a vec3 that is not three finite numbers", async () => {
    paletteState.startContext(command("transform_object"));
    paletteState.setValue("path", "/World");

    for (const raw of ["1 2", "1 2 3 4", "1 2 x"]) {
      run.mockClear();
      paletteState.fieldHint = null;
      paletteState.setValue("position", raw);
      await paletteState.submit();
      expect(run).not.toHaveBeenCalled();
      expect(paletteState.fieldHint).toBeTruthy();
    }
  });

  it("omits empty optional args from the dispatch payload", async () => {
    paletteState.startContext(command("set_camera"));

    await paletteState.submit();

    expect(run).toHaveBeenCalledWith("set_camera", {});
  });

  it("executes an argless command straight from its empty form", async () => {
    paletteState.openPalette();
    paletteState.startContext(command("pause"));

    await paletteState.submit();

    expect(run).toHaveBeenCalledWith("pause", {});
    expect(paletteState.open).toBe(false);
  });

  it("does nothing without a context", async () => {
    await paletteState.submit();

    expect(run).not.toHaveBeenCalled();
  });
});

describe("execution results", () => {
  it("routes the default runner through the guarded dispatch with no viewer", async () => {
    paletteHooks.command = defaultCommand;
    paletteState.openPalette();
    paletteState.startContext(command("pause"));

    await paletteState.submit();

    expect(mockedDispatch).toHaveBeenCalledWith(null, "pause", {}, { guarded: true });
  });

  it("keeps the palette open with the payload of a read-only command", async () => {
    run.mockResolvedValue({ stage_loaded: true });
    paletteState.openPalette();
    paletteState.startContext(command("status"));

    await paletteState.submit();

    expect(paletteState.open).toBe(true);
    expect(paletteState.result).toEqual({ ok: true, payload: { stage_loaded: true } });
  });

  it("closes the palette before a load finishes, without awaiting it", async () => {
    run.mockReturnValue(new Promise(() => {}));
    paletteState.openPalette();
    paletteState.startContext(command("load_scene"));

    void paletteState.execute();

    expect(paletteState.open).toBe(false);
    expect(paletteState.context).toBeNull();
    expect(paletteState.result).toBeNull();
    expect(run).toHaveBeenCalledWith("load_scene", { path: "~/" });
  });

  it("waits for a non-eager command before closing", async () => {
    let release: (value: unknown) => void = () => {};
    run.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    paletteState.openPalette();
    paletteState.startContext(command("reset_performance"));

    const pending = paletteState.execute();
    expect(paletteState.open).toBe(true);

    release(undefined);
    await pending;

    expect(paletteState.open).toBe(false);
  });

  it("closes the palette on a successful action command", async () => {
    run.mockResolvedValue({ ok: true });
    paletteState.openPalette();
    paletteState.startContext(command("reset_performance"));

    await paletteState.submit();

    expect(paletteState.open).toBe(false);
    expect(paletteState.context).toBeNull();
    expect(paletteState.result).toBeNull();
  });

  it("surfaces a failure in the result panel and keeps the palette open", async () => {
    run.mockRejectedValue(new Error("no viewport available"));
    paletteState.openPalette();
    paletteState.startContext(command("play"));

    await paletteState.submit();

    expect(paletteState.open).toBe(true);
    expect(paletteState.result).toEqual({ ok: false, payload: "no viewport available" });
    expect(paletteState.context).not.toBeNull();
  });

  it("surfaces a string rejection verbatim", async () => {
    run.mockRejectedValue("stage is still open");

    paletteState.startContext(command("unload_scene"));
    await paletteState.submit();

    expect(paletteState.result).toEqual({ ok: false, payload: "stage is still open" });
  });
});

describe("tab commands", () => {
  it("routes each tab command to its tab store helper", async () => {
    paletteState.openPalette();

    paletteState.startContext(command("recent_tab"));
    await paletteState.submit();
    expect(activateRecent).toHaveBeenCalledTimes(1);

    paletteState.startContext(command("next_tab"));
    await paletteState.submit();
    expect(cycleTab).toHaveBeenLastCalledWith(1);

    paletteState.startContext(command("previous_tab"));
    await paletteState.submit();
    expect(cycleTab).toHaveBeenLastCalledWith(-1);

    paletteState.startContext(command("swap_tab_left"));
    await paletteState.submit();
    expect(swapTab).toHaveBeenLastCalledWith(-1);

    paletteState.startContext(command("swap_tab_right"));
    await paletteState.submit();
    expect(swapTab).toHaveBeenLastCalledWith(1);

    expect(run).not.toHaveBeenCalled();
    expect(paletteState.open).toBe(false);
  });
});
