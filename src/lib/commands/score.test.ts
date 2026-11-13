// The ranking the palette relies on: name matches above description matches,
// best match first inside each group.

import { describe, expect, it } from "vitest";
import type { Command } from "./registry.mjs";
import { COMMANDS } from "./registry.mjs";
import { rankCommands } from "./score";

const cmds: Command[] = [
  { name: "set_camera", description: "Move the viewport camera.", args: [] },
  { name: "play", description: "Start timeline playback.", args: [] },
  { name: "play_scene", description: "Load a scene and start it.", args: [] },
  { name: "status", description: "What the app has open.", args: [] },
  { name: "screenshot", description: "Render the viewport and return it as a PNG image.", args: [] },
  { name: "close_app", description: "Close the running app.", args: [] },
];

const names = (list: Command[]) => list.map((cmd) => cmd.name);

describe("rankCommands", () => {
  it("puts an exact name match first", () => {
    expect(names(rankCommands(cmds, "play").nameMatches).slice(0, 1)).toEqual(["play"]);
  });

  it("ranks a prefix above a scattered subsequence", () => {
    expect(names(rankCommands(cmds, "st").nameMatches)).toEqual(["status", "set_camera", "screenshot"]);
  });

  it("ignores case", () => {
    expect(rankCommands(cmds, "ST")).toEqual(rankCommands(cmds, "st"));
  });

  it("ranks the shorter name first when both match equally", () => {
    expect(names(rankCommands(cmds, "pla").nameMatches)).toEqual(["play", "play_scene"]);
  });

  it("keeps a name match out of the description group", () => {
    // play's own description holds "pl" as well.
    const { nameMatches, descriptionMatches } = rankCommands(cmds, "pl");
    expect(names(nameMatches)).toContain("play");
    expect(names(descriptionMatches)).not.toContain("play");
  });

  it("falls back to the description, earlier match first", () => {
    const { nameMatches, descriptionMatches } = rankCommands(cmds, "viewport");
    expect(nameMatches).toEqual([]);
    expect(names(descriptionMatches)).toEqual(["set_camera", "screenshot"]);
  });

  it("drops commands that match nothing", () => {
    expect(rankCommands(cmds, "zzz")).toEqual({ nameMatches: [], descriptionMatches: [] });
  });

  it("returns every command in registry order for an empty query", () => {
    expect(rankCommands(COMMANDS, "").nameMatches).toEqual(COMMANDS);
    expect(rankCommands(COMMANDS, "").descriptionMatches).toEqual([]);
  });
});
