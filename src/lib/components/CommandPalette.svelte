<script lang="ts">
  // The palette UI: the command list, the argument form with its suggestion
  // lists, and the result panel. Keys and suggestions live here; the state
  // module owns what the palette remembers and the dispatcher runs commands.
  import { invoke } from "@tauri-apps/api/core";
  import { tick } from "svelte";
  import { commandTitle, type Command } from "$lib/commands/registry.mjs";
  import { fetchManifest } from "$lib/commands/dispatch";
  import { paletteState } from "$lib/state/commandPaletteState.svelte";
  import { controlsState } from "$lib/state/controlsState.svelte";
  import { stageState } from "$lib/stage/stageState.svelte";
  import type { RenderNode } from "$lib/stage/types";
  import {
    filterDirEntries,
    filterPrimPaths,
    pngBase64,
    resultText,
    stepSuggestion,
    type Suggestion,
  } from "$lib/utils/palette";

  // Home listings and manifests are large; typing waits for a pause.
  const DEBOUNCE_MS = 150;

  let root = $state<HTMLDivElement>();
  let queryInput = $state<HTMLInputElement>();
  let suggestions = $state<Suggestion[]>([]);
  let suggestionIndex = $state(0);
  // Set when a full path was accepted: the list must not reopen and swallow
  // the next Enter, which has to submit instead.
  let dismissed = $state(false);
  let manifestCache: { stageId: number; paths: string[] } | null = null;
  // Last-wins token: a slow suggestion response for old text is dropped.
  let generation = 0;

  const matches = $derived(paletteState.matches());
  const ctx = $derived(paletteState.context);
  const focusedArg = $derived(ctx ? (ctx.cmd.args[ctx.focus] ?? null) : null);
  const suggestionOpen = $derived(focusedArg !== null && !dismissed && suggestions.length > 0);
  const rows = $derived([...matches.nameMatches, ...matches.descriptionMatches]);

  function tabExecutes(): boolean {
    return (controlsState as unknown as { paletteTabExecutes?: boolean }).paletteTabExecutes ?? true;
  }

  function primPaths(nodes: RenderNode[], out: string[] = []): string[] {
    for (const node of nodes) {
      out.push(node.path);
      primPaths(node.children, out);
    }
    return out;
  }

  async function loadFilePaths(prefix: string, gen: number): Promise<void> {
    try {
      const answer = await invoke<{ entries: { name: string; is_dir: boolean }[] }>("suggest_dir_entries", {
        prefix,
      });
      if (gen !== generation) return;
      suggestions = filterDirEntries(prefix, answer.entries ?? []);
    } catch {
      if (gen === generation) suggestions = [];
    }
    suggestionIndex = 0;
  }

  async function loadPrimPaths(prefix: string, gen: number): Promise<void> {
    const stageId = stageState.activeStageId;
    try {
      if (manifestCache?.stageId !== stageId) {
        manifestCache = { stageId, paths: primPaths(await fetchManifest()) };
      }
      if (gen !== generation) return;
      suggestions = filterPrimPaths(prefix, manifestCache.paths);
    } catch {
      if (gen === generation) suggestions = [];
    }
    suggestionIndex = 0;
  }

  $effect(() => {
    generation += 1;
    const gen = generation;
    const arg = focusedArg;
    if (!paletteState.open || dismissed || !arg?.autocomplete) {
      suggestions = [];
      return;
    }
    const prefix = ctx?.values[arg.key] ?? "";
    if (arg.autocomplete === "prim_path") {
      void loadPrimPaths(prefix, gen);
      return;
    }
    const timer = setTimeout(() => void loadFilePaths(prefix, gen), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  // Focus follows the form: the query input, or the field the keyboard drives.
  $effect(() => {
    const open = paletteState.open;
    const hasContext = ctx !== null;
    const focus = ctx?.focus ?? 0;
    if (!open) return;
    void tick().then(() => {
      if (!hasContext) queryInput?.focus();
      else root?.querySelectorAll<HTMLInputElement>(".palette-field input")[focus]?.focus();
    });
  });

  // Keep the active row inside the scroll box while the keyboard moves it.
  $effect(() => {
    // Dependencies: which row is active, which list is showing.
    void (suggestionOpen ? suggestionIndex : paletteState.highlighted);
    if (!paletteState.open) return;
    void tick().then(() => {
      root?.querySelector<HTMLElement>(".is-active")?.scrollIntoView?.({ block: "nearest" });
    });
  });

  function startCommand(cmd: Command | undefined): void {
    if (!cmd) return;
    dismissed = false;
    paletteState.startContext(cmd);
    if (cmd.args.length === 0) void paletteState.submit();
  }

  function acceptSuggestion(index = suggestionIndex): void {
    const arg = focusedArg;
    const picked = suggestions[index];
    if (!arg || !picked) return;
    paletteState.setValue(arg.key, picked.value);
    if (!picked.is_dir) dismissed = true;
    suggestionIndex = 0;
  }

  function moveFocus(step: number): void {
    if (!ctx) return;
    paletteState.setFocus(ctx.focus + step);
  }

  function onKeydown(e: KeyboardEvent): void {
    if (!paletteState.open) return;
    // A modal raised by a command owns the keyboard while it is up.
    if (document.querySelector(".modal-overlay")) return;
    const listOpen = suggestionOpen;
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        paletteState.closePalette();
        return;
      case "ArrowDown":
        e.preventDefault();
        if (listOpen) suggestionIndex = stepSuggestion(suggestionIndex, 1, suggestions.length);
        else if (ctx) moveFocus(1);
        else paletteState.highlighted = Math.min(paletteState.highlighted + 1, Math.max(rows.length - 1, 0));
        return;
      case "ArrowUp":
        e.preventDefault();
        if (listOpen) suggestionIndex = stepSuggestion(suggestionIndex, -1, suggestions.length);
        else if (ctx) moveFocus(-1);
        else paletteState.highlighted = Math.max(paletteState.highlighted - 1, 0);
        return;
      case "Enter":
        e.preventDefault();
        if (listOpen) acceptSuggestion();
        else if (ctx) void paletteState.submit();
        else startCommand(rows[paletteState.highlighted]);
        return;
      // Tab runs the highlighted command from the list, like Enter, when the
      // setting allows it; inside the argument form it accepts the suggestion
      // or moves to the next field.
      case "Tab":
        e.preventDefault();
        if (ctx) {
          if (listOpen) acceptSuggestion();
          else moveFocus(1);
          return;
        }
        if (tabExecutes()) startCommand(rows[paletteState.highlighted]);
        return;
      case "Backspace": {
        const target = e.target as HTMLInputElement | null;
        if (target?.value.trim()) return;
        paletteState.backspaceOnEmpty();
        return;
      }
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if paletteState.open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="palette-overlay"
    role="presentation"
    onclick={(e) => e.target === e.currentTarget && paletteState.closePalette()}
  >
    <div class="palette" bind:this={root} role="dialog" aria-modal="true" aria-label="Command palette">
      <input
        class="palette-input"
        bind:this={queryInput}
        value={paletteState.query}
        placeholder="Type a command…"
        spellcheck="false"
        autocomplete="off"
        oninput={(e) => {
          paletteState.query = e.currentTarget.value;
          paletteState.highlighted = 0;
        }}
      />

      {#snippet row(cmd: Command, index: number)}
        <button
          class="row"
          class:is-active={index === paletteState.highlighted}
          onclick={() => startCommand(cmd)}
        >
          <span class="row-name">{commandTitle(cmd)}</span>
          <span class="row-desc">{cmd.description}</span>
        </button>
      {/snippet}

      {#if ctx}
        <div class="palette-form">
          <div class="form-title">{commandTitle(ctx.cmd)}</div>
          {#each ctx.cmd.args as arg, i (arg.key)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="palette-field"
              class:focused={i === ctx.focus}
              onclick={() => paletteState.setFocus(i)}
            >
              <div class="field-head">
                <span class="field-key">{arg.key}</span>
                {#if arg.optional}<span class="field-optional">optional</span>{/if}
                {#if arg.describe}<span class="field-desc">{arg.describe}</span>{/if}
              </div>
              <input
                value={ctx.values[arg.key] ?? ""}
                spellcheck="false"
                autocomplete="off"
                onfocus={() => paletteState.setFocus(i)}
                oninput={(e) => {
                  dismissed = false;
                  paletteState.setValue(arg.key, e.currentTarget.value);
                }}
              />
              {#if i === ctx.focus && suggestionOpen}
                <ul class="suggestions">
                  {#each suggestions as suggestion, j (suggestion.value)}
                    <li>
                      <button
                        class="suggestion"
                        class:is-active={j === suggestionIndex}
                        onclick={() => acceptSuggestion(j)}
                      >
                        {suggestion.value}
                      </button>
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
          {/each}
          {#if paletteState.fieldHint}
            <div class="hint">{paletteState.fieldHint}</div>
          {/if}
        </div>
      {:else}
        <div class="palette-list">
          {#each matches.nameMatches as cmd, i (cmd.name)}
            {@render row(cmd, i)}
          {/each}
          {#if matches.descriptionMatches.length > 0}
            <div class="group-label">Matching description</div>
            {#each matches.descriptionMatches as cmd, i (cmd.name)}
              {@render row(cmd, matches.nameMatches.length + i)}
            {/each}
          {/if}
          {#if rows.length === 0}
            <div class="empty">No matching command</div>
          {/if}
        </div>
      {/if}

      {#if paletteState.result}
        <div class="result" class:error={!paletteState.result.ok}>
          {#if pngBase64(paletteState.result.payload)}
            <img src="data:image/png;base64,{pngBase64(paletteState.result.payload)}" alt="Command result" />
          {:else}
            <pre>{resultText(paletteState.result)}</pre>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .palette-overlay {
    position: fixed;
    inset: 0;
    background: var(--overlay);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12vh;
    /* Below the modal family: a modal a command raises must paint on top. */
    z-index: 9998;
  }

  .palette {
    display: flex;
    flex-direction: column;
    width: min(680px, 90vw);
    max-height: 70vh;
    background: var(--bg);
    border: 1px solid var(--control-border);
    border-radius: 8px;
    box-shadow: 0 10px 30px var(--shadow);
    overflow: hidden;
    font-size: 13px;
    color: var(--text);
  }

  .palette-input {
    flex: none;
    padding: 12px 16px;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--border);
    color: var(--text-strong);
    font-size: 15px;
    outline: none;
  }

  .palette-list,
  .palette-form {
    overflow-y: auto;
    padding: 6px;
  }

  .row {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;
    padding: 6px 10px;
    background: transparent;
    border: none;
    border-radius: 4px;
    text-align: left;
    color: var(--text);
    cursor: pointer;
  }

  .row.is-active {
    background: var(--row-hover);
    color: var(--text-bright);
  }

  .row-name {
    font-weight: 600;
  }

  .row-desc {
    color: var(--text-dim);
    font-size: 12px;
  }

  .group-label {
    padding: 10px 10px 4px;
    color: var(--text-faint);
    font-size: 11px;
    text-transform: uppercase;
  }

  .empty {
    padding: 10px;
    color: var(--text-dim);
  }

  .form-title {
    padding: 4px 10px 8px;
    font-weight: 600;
    color: var(--text-strong);
  }

  .palette-field {
    padding: 6px 10px;
    border-radius: 4px;
  }

  .palette-field.focused {
    background: var(--row-hover);
  }

  .field-head {
    display: flex;
    gap: 8px;
    align-items: baseline;
    margin-bottom: 4px;
  }

  .field-key {
    color: var(--overlay-accent);
    font-family: monospace;
  }

  .field-optional,
  .field-desc {
    color: var(--text-dim);
    font-size: 12px;
  }

  .palette-field input {
    width: 100%;
    padding: 4px 6px;
    background: var(--input-bg-soft);
    border: 1px solid var(--input-border-soft);
    border-radius: 4px;
    color: var(--text-input);
    outline: none;
  }

  .palette-field.focused input {
    border-color: var(--focus-border);
  }

  .suggestions {
    list-style: none;
    margin: 4px 0 0;
    padding: 0;
    max-height: 160px;
    overflow-y: auto;
  }

  .suggestion {
    width: 100%;
    padding: 3px 8px;
    background: transparent;
    border: none;
    border-radius: 3px;
    text-align: left;
    color: var(--text-mid);
    font-family: monospace;
    font-size: 12px;
    cursor: pointer;
  }

  .suggestion.is-active {
    background: var(--control-bg-active);
    color: var(--text-bright);
  }

  .hint {
    padding: 6px 10px;
    color: var(--warning);
    font-size: 12px;
  }

  .result {
    flex: none;
    max-height: 40vh;
    overflow: auto;
    border-top: 1px solid var(--border);
    background: var(--bg-deep);
    padding: 8px 12px;
  }

  .result pre {
    margin: 0;
    color: var(--text-body);
    font-family: monospace;
    font-size: 12px;
    white-space: pre-wrap;
    user-select: text;
  }

  .result.error pre {
    color: var(--danger);
  }

  .result img {
    max-width: 100%;
    display: block;
  }
</style>
