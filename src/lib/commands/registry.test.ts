import { describe, expect, it } from "vitest";
import { COMMANDS, commandTitle } from "./registry.mjs";

const ALLOWED_TYPES = ["string", "number", "vec3"];
const AUTOCOMPLETE_KINDS = ["file_path", "prim_path"];

const TAB_COMMANDS = {
  recent_tab: "Activate the tab you were on before the current one.",
  next_tab: "Activate the next stage tab (wraps around).",
  previous_tab: "Activate the previous stage tab (wraps around).",
  swap_tab_left: "Move the current tab one slot to the left.",
  swap_tab_right: "Move the current tab one slot to the right.",
};

describe("command registry", () => {
  it("names every command once, in snake_case", () => {
    const names = COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  it("describes every command", () => {
    for (const command of COMMANDS) {
      expect(command.description.trim()).not.toBe("");
    }
  });

  it("declares args with known types and hints", () => {
    for (const command of COMMANDS) {
      for (const arg of command.args) {
        expect(ALLOWED_TYPES).toContain(arg.type);
        expect(typeof arg.key).toBe("string");
        if (arg.optional !== undefined) expect(arg.optional).toBe(true);
        if (arg.describe !== undefined) expect(typeof arg.describe).toBe("string");
        if (arg.autocomplete !== undefined) {
          // Autocomplete is a text affordance: a list of paths fills a string.
          expect(arg.type).toBe("string");
          expect(AUTOCOMPLETE_KINDS).toContain(arg.autocomplete);
        }
      }
    }
  });

  it("exposes the 19 bridge commands the MCP server registers", () => {
    const bridge = COMMANDS.filter((command) => command.mcp !== false);
    expect(bridge.map((command) => command.name)).toEqual([
      "status",
      "load_scene",
      "unload_scene",
      "inspect_scene",
      "search_objects",
      "select_node",
      "transform_object",
      "play",
      "pause",
      "set_time",
      "step_frame",
      "get_performance",
      "box_report",
      "reset_performance",
      "set_camera",
      "look_through_camera",
      "screenshot",
      "close_app",
      "release_camera",
    ]);
  });

  it("carries the palette-only frame stepping commands", () => {
    for (const name of ["next_frame", "previous_frame"]) {
      expect(COMMANDS).toContainEqual(expect.objectContaining({ name, mcp: false, args: [] }));
    }
  });

  it("carries the palette-only camera cycle", () => {
    expect(COMMANDS).toContainEqual({
      name: "cycle_camera",
      description:
        "Advance the viewport's camera to the next one in the cycle (free camera, then each stage camera, wrapping).",
      mcp: false,
      args: [],
    });
  });

  it("carries the palette-only tab commands", () => {
    for (const [name, description] of Object.entries(TAB_COMMANDS)) {
      expect(COMMANDS).toContainEqual({ name, description, mcp: false, args: [] });
    }
  });
});

describe("commandTitle", () => {
  it("turns a snake_case name into a sentence-case title", () => {
    expect(commandTitle("load_scene")).toBe("Load scene");
    expect(commandTitle("status")).toBe("Status");
    expect(commandTitle("swap_tab_left")).toBe("Swap tab left");
  });
});
