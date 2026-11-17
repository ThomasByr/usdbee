// The one list of things the app can do. Plain ESM data with no imports so
// both the Node MCP server and the Svelte palette can load it.

/**
 * @typedef {"string" | "number" | "vec3"} ArgType
 * @typedef {"file_path" | "prim_path"} AutocompleteKind
 *
 * @typedef {object} Arg
 * @property {string} key
 * @property {ArgType} type
 * @property {true} [optional]
 * @property {true} [int] integer-only number
 * @property {AutocompleteKind} [autocomplete]
 * @property {string} [describe]
 *
 * @typedef {object} Command
 * @property {string} name
 * @property {string} description
 * @property {false} [mcp] false when the palette can run it but the MCP bridge cannot
 * @property {Arg[]} args
 */

/** @type {Command[]} */
export const COMMANDS = [
  {
    name: "status",
    description: "What the app has open: stage_loaded, stage_id, playing, time (USD time code).",
    args: [],
  },
  {
    name: "load_scene",
    description: "Open a USD scene through the app's own load path (errors surface as tool errors).",
    args: [
      {
        key: "path",
        type: "string",
        autocomplete: "file_path",
        describe: "path to a .usd/.usda/.usdc/.usdz file",
      },
    ],
  },
  {
    name: "unload_scene",
    description: "Close the active stage without the dirty-scene prompt.",
    args: [],
  },
  {
    name: "inspect_scene",
    description: "Prim/geometry/animation counts plus the top of the tree (depth-capped, first ~200 nodes).",
    args: [{ key: "max_depth", type: "number", int: true, optional: true, describe: "depth cap, default 3" }],
  },
  {
    name: "search_objects",
    description: "Case-insensitive substring search over prim paths and names.",
    args: [
      { key: "query", type: "string", autocomplete: "prim_path", describe: "substring to look for" },
      { key: "limit", type: "number", int: true, optional: true, describe: "max matches, default 50" },
    ],
  },
  {
    name: "select_node",
    description:
      "Select a prim's render node like a hierarchy click: orange box, gizmo anchor, stage details.",
    args: [
      {
        key: "path",
        type: "string",
        autocomplete: "prim_path",
        describe: "prim path, e.g. /CarbonFrameBike; empty string clears",
      },
    ],
  },
  {
    name: "transform_object",
    description:
      "Author a prim's local transform through the gizmo path (undo/redo and caches apply). Only the channels given are written.",
    args: [
      { key: "path", type: "string", autocomplete: "prim_path", describe: "prim path, e.g. /World/Wheel" },
      { key: "position", type: "vec3", optional: true, describe: "local translation [x,y,z]" },
      { key: "rotation", type: "vec3", optional: true, describe: "local rotation [x,y,z] in degrees" },
      { key: "scale", type: "vec3", optional: true, describe: "local scale [x,y,z]" },
    ],
  },
  { name: "play", description: "Start timeline playback.", args: [] },
  { name: "pause", description: "Pause timeline playback.", args: [] },
  {
    name: "set_time",
    description: "Move the playhead to an absolute USD time code (unsnapped).",
    args: [{ key: "time", type: "number" }],
  },
  {
    name: "step_frame",
    description:
      "Move the playhead by a signed number of frames (1 = next, -1 = previous), clamped to the stage range.",
    args: [{ key: "frames", type: "number", int: true }],
  },
  { name: "next_frame", description: "Step the playhead one frame forward.", mcp: false, args: [] },
  { name: "previous_frame", description: "Step the playhead one frame backward.", mcp: false, args: [] },
  {
    name: "get_performance",
    description: "Frame diagnostics of the render loop, verbatim snapshot.",
    args: [],
  },
  {
    name: "box_report",
    description:
      "Cached vs precise AABB of the selected subtree, plus its widest meshes (hidden ones flagged).",
    args: [],
  },
  {
    name: "reset_performance",
    description: "Clear the frame diagnostics.",
    args: [],
  },
  {
    name: "set_camera",
    description:
      "Move the default viewport camera and pin the view: position and target are reapplied after every scene rebuild or load, so screenshots stay comparable. Omitted channels keep their current value.",
    args: [
      {
        key: "position",
        type: "vec3",
        optional: true,
        describe: "camera position [x,y,z], viewer/screen space",
      },
      { key: "target", type: "vec3", optional: true, describe: "look-at point [x,y,z], viewer/screen space" },
      { key: "fov", type: "number", optional: true, describe: "vertical field of view in degrees" },
    ],
  },
  {
    name: "look_through_camera",
    description:
      "Frame the viewport through one of the stage's own camera prims: position, look direction and vertical FOV come from its USD transform and lens, and the view is pinned like set_camera. Orthographic cameras are framed by position and direction only, with the current FOV kept. Without a path, lists the stage's cameras.",
    args: [
      {
        key: "path",
        type: "string",
        optional: true,
        autocomplete: "prim_path",
        describe: "camera prim path, e.g. /World/Cam_wide; omit to list the cameras",
      },
    ],
  },
  {
    name: "screenshot",
    description: "Render the viewport and return it as a PNG image.",
    args: [],
  },
  {
    name: "close_app",
    description: "Close the running app (window state is saved first).",
    args: [],
  },

  // Palette-only: the app runs these against its own tab state.
  {
    name: "release_camera",
    description:
      "Release a look-through camera: back to the free camera, restoring the field of view and clipping range the first pick replaced. The view stays where the controls left it; not pinned, so no error when nothing is pinned.",
    args: [],
  },
  {
    name: "recent_tab",
    description: "Activate the tab you were on before the current one.",
    mcp: false,
    args: [],
  },
  {
    name: "next_tab",
    description: "Activate the next stage tab (wraps around).",
    mcp: false,
    args: [],
  },
  {
    name: "previous_tab",
    description: "Activate the previous stage tab (wraps around).",
    mcp: false,
    args: [],
  },
  {
    name: "swap_tab_left",
    description: "Move the current tab one slot to the left.",
    mcp: false,
    args: [],
  },
  {
    name: "swap_tab_right",
    description: "Move the current tab one slot to the right.",
    mcp: false,
    args: [],
  },
];

/**
 * Display title for a command: `load_scene` -> "Load scene".
 * @param {string | Command} cmd
 */
export function commandTitle(cmd) {
  const words = (typeof cmd === "string" ? cmd : cmd.name).replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
