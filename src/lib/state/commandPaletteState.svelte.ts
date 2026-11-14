// The command palette's state: the filtered list, the argument form and the
// result panel. Renders nothing and touches no DOM — the component owns keys
// and suggestions.

import type { Command } from "../commands/registry.mjs";
import { COMMANDS } from "../commands/registry.mjs";
import { dispatchCommand } from "../commands/dispatch";
import { rankCommands } from "../commands/score";
import { bridgeViewer } from "../commands/viewerRef";
import { tabsState } from "./tabsState.svelte";

export interface PaletteContext {
  cmd: Command;
  values: Record<string, string>;
  focus: number;
}

export interface PaletteResult {
  ok: boolean;
  payload: unknown;
}

// Read-only commands keep the palette open with their payload; every other
// command is an action whose success closes it.
const READ_ONLY = new Set([
  "status",
  "inspect_scene",
  "search_objects",
  "get_performance",
  "box_report",
  // F5: no-arg lists the stage's cameras; a framing run leaves its result
  // (camera, fov) on screen, so the palette stays open for another pick.
  "look_through_camera",
  "screenshot",
]);

// Commands that own a long-running load: the palette closes as soon as the
// args parse, so it does not sit on top of the load's own progress UI.
const EAGER_CLOSE = new Set(["load_scene"]);

// The palette-only commands drive the tab store instead of the dispatcher.
const TAB_CALLS: Record<string, () => unknown> = {
  recent_tab: () => tabsState.activateRecent(),
  next_tab: () => tabsState.cycleTab(1),
  previous_tab: () => tabsState.cycleTab(-1),
  swap_tab_left: () => tabsState.swapTab(-1),
  swap_tab_right: () => tabsState.swapTab(1),
};

// Test seam, the tabsState init-hook pattern: tests swap the runner to watch
// execution without a viewport. The component never sets it.
export const paletteHooks = {
  command: (name: string, args: Record<string, unknown>): Promise<unknown> =>
    dispatchCommand(bridgeViewer(), name, args, { guarded: true }),
};

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === "string" ? e : String(e);
}

export const paletteState = $state({
  open: false,
  query: "",
  highlighted: 0,
  context: null as PaletteContext | null,
  // Why the last submit did not dispatch (bad number, empty required field).
  fieldHint: null as string | null,
  result: null as PaletteResult | null,

  openPalette(): void {
    this.open = true;
    this.reset();
  },

  closePalette(): void {
    this.open = false;
    this.reset();
  },

  reset(): void {
    this.query = "";
    this.highlighted = 0;
    this.context = null;
    this.fieldHint = null;
    this.result = null;
  },

  matches(): ReturnType<typeof rankCommands> {
    return rankCommands(COMMANDS, this.query);
  },

  // Context mode is a form: every arg is visible, focus is the field the
  // keyboard drives. A path arg starts at `~/` so the home listing shows up.
  startContext(cmd: Command): void {
    const values: Record<string, string> = {};
    for (const arg of cmd.args) values[arg.key] = arg.autocomplete === "file_path" ? "~/" : "";
    this.context = { cmd, values, focus: 0 };
    this.fieldHint = null;
    this.result = null;
  },

  exitContext(): void {
    this.context = null;
    this.fieldHint = null;
  },

  setFocus(i: number): void {
    const args = this.context?.cmd.args;
    if (!this.context || !args?.length) return;
    this.context.focus = Math.min(Math.max(i, 0), args.length - 1);
    this.fieldHint = null;
  },

  setValue(key: string, raw: string): void {
    if (!this.context) return;
    this.context.values[key] = raw;
    this.fieldHint = null;
  },

  // Backspace on an empty field leaves the form; the query survives so the
  // command list comes back as the user left it. With no form open, an empty
  // query clears the result panel and returns to the command list.
  backspaceOnEmpty(): void {
    const ctx = this.context;
    if (!ctx) {
      this.result = null;
      return;
    }
    const arg = ctx.cmd.args[ctx.focus];
    if (arg && (ctx.values[arg.key] ?? "").trim()) return;
    this.exitContext();
  },

  async submit(): Promise<void> {
    await this.execute();
  },

  async execute(): Promise<void> {
    const ctx = this.context;
    if (!ctx) return;
    this.fieldHint = null;
    const args = this.parseArgs(ctx);
    if (args === null) return;

    const name = ctx.cmd.name;
    if (EAGER_CLOSE.has(name)) {
      // The load orchestrator already shows load failures, so the dispatch is
      // fire-and-forget: only its own viewport errors would go unreported.
      this.closePalette();
      void paletteHooks.command(name, args).catch(() => {});
      return;
    }
    try {
      const payload = TAB_CALLS[name] ? await TAB_CALLS[name]() : await paletteHooks.command(name, args);
      if (READ_ONLY.has(name)) {
        this.result = { ok: true, payload };
        return;
      }
      this.closePalette();
    } catch (e) {
      this.result = { ok: false, payload: errorMessage(e) };
    }
  },

  // Values to dispatch payload; null means fieldHint explains the refusal.
  parseArgs(ctx: PaletteContext): Record<string, unknown> | null {
    const args: Record<string, unknown> = {};
    for (const [index, arg] of ctx.cmd.args.entries()) {
      const raw = (ctx.values[arg.key] ?? "").trim();
      if (!raw) {
        if (arg.optional) continue;
        return this.reject(index, `${arg.key} is required`);
      }
      if (arg.type === "number") {
        const value = Number(raw);
        if (!Number.isFinite(value) || (arg.int && !Number.isInteger(value))) {
          return this.reject(index, `${arg.key} must be a${arg.int ? "n integer" : " number"}`);
        }
        args[arg.key] = value;
        continue;
      }
      if (arg.type === "vec3") {
        const parts = raw.split(/[\s,]+/).map(Number);
        if (parts.length !== 3 || !parts.every(Number.isFinite)) {
          return this.reject(index, `${arg.key} must be three numbers, e.g. 1 2 3`);
        }
        args[arg.key] = parts;
        continue;
      }
      args[arg.key] = raw;
    }
    return args;
  },

  // Point the form at the field that needs fixing, not wherever focus was.
  reject(index: number, hint: string): null {
    if (this.context) this.context.focus = index;
    this.fieldHint = hint;
    return null;
  },
});
