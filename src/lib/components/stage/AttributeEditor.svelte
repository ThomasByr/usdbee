<script lang="ts">
  import type { ValuePayload } from "$lib/stage/types";
  import {
    colorArrayHex,
    commitColorArray,
    commitEditedValue,
    isColorArray,
    isEditableValue,
    parseEditedValue,
  } from "$lib/stage/valueEdit";
  import ValueView from "./ValueView.svelte";

  // `oncommit` receives the edited payload and returns the backend error
  // (null on success) so the editor surfaces it next to the field.
  let {
    value,
    oncommit,
  }: { value: ValuePayload; oncommit: (value: ValuePayload) => Promise<string | null> } = $props();

  const editable = $derived(isEditableValue(value));
  const colorEditable = $derived(editable && isColorArray(value));
  // Null when the value is not an editable color array (no swatch shown).
  const swatch = $derived(colorEditable ? colorArrayHex(value) : null);
  let draft = $state("");
  let error = $state<string | null>(null);
  // A failed Enter-commit keeps the draft for fixing, and the blur that
  // follows must not fire the same failed commit a second time: the flag
  // suppresses that one blur and resets on the next focus.
  let suppressNextBlur = $state(false);

  // Sync the draft to the incoming data on mount and on every details
  // refresh (a successful commit refreshes details; a failed one leaves
  // `value.data` unchanged, so the user's draft stays for fixing).
  $effect(() => {
    const data = value.data;
    draft = colorEditable ? (colorArrayHex(value) ?? "") : String(data ?? "");
    error = null;
  });

  async function commit(fromBlur = false) {
    if (fromBlur && suppressNextBlur) {
      suppressNextBlur = false;
      return;
    }
    if (!editable) return;
    const wasColor = colorEditable;
    const result = wasColor ? commitColorArray(value, draft) : commitEditedValue(value, draft);
    if (!result.ok) {
      error = result.error;
      suppressNextBlur = true;
      return;
    }
    // Nothing changed: just clear the error state. Color arrays compare
    // by content (both sides are fresh JSON arrays).
    const unchanged = wasColor
      ? JSON.stringify(result.value.data) === JSON.stringify(value.data)
      : result.value.data === value.data;
    if (unchanged) {
      error = null;
      return;
    }
    // On success the details refresh rewrites `value.data`, which resets
    // the draft via the effect; on failure keep the draft for fixing and
    // swallow the follow-up blur. A successful ENTER commit also
    // suppresses its immediate follow-up blur (review fix): the
    // event-driven refresh may not have rewritten `value.data` yet, and
    // the blur would fire the same commit a second time.
    error = await oncommit(result.value);
    if (error !== null || !fromBlur) suppressNextBlur = true;
  }

  // Bool payloads come from the checkbox itself, not the text draft.

  function commitBool(checked: boolean) {
    const result = parseEditedValue(value.type, checked);
    if (!result.ok || result.data === value.data) return;
    oncommit({ type: value.type, data: result.data }).then((backendError) => {
      error = backendError;
    });
  }
</script>

{#if editable && value.type === "bool"}
  <input
    class="value-editor value-bool"
    type="checkbox"
    checked={value.data === true}
    onchange={(event) => commitBool(event.currentTarget.checked)}
  />
{:else if editable}
  <span class="value-editor-wrap">
    {#if colorEditable && swatch !== null}
      <input
        class="color-swatch"
        type="color"
        value={swatch}
        onchange={(event) => {
          draft = event.currentTarget.value;
          suppressNextBlur = true;
          void commit();
        }}
      />
    {/if}
    <input
      class="value-editor"
      class:value-error={error !== null}
      type="text"
      bind:value={draft}
      onfocus={() => (suppressNextBlur = false)}
      onkeydown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
      }}
      onblur={() => commit(true)}
    />
    {#if error !== null}<span class="value-editor-error" title={error}>{error}</span>{/if}
  </span>
{:else}
  <ValueView {value} />
{/if}

<style>
  .value-editor-wrap {
    display: inline-flex;
    flex-direction: column;
    min-width: 0;
  }

  .color-swatch {
    width: 1.6rem;
    height: 1.2rem;
    padding: 0;
    border: 1px solid var(--input-border-soft);
    border-radius: 3px;
    background: none;
    cursor: pointer;
  }

  .color-swatch::-webkit-color-swatch-wrapper {
    padding: 0;
  }

  .color-swatch::-webkit-color-swatch {
    border: none;
    border-radius: 2px;
  }

  .value-editor {
    width: 100%;
    min-width: 4rem;
    max-width: 14rem;
    padding: 0.1rem 0.3rem;
    border: 1px solid var(--input-border-soft);
    border-radius: 3px;
    background: var(--input-bg-soft);
    color: inherit;
    font: inherit;
    font-size: 0.85rem;
  }

  .value-editor:focus {
    outline: none;
    border-color: var(--focus-border);
  }

  .value-editor.value-error {
    border-color: var(--danger-focus-border);
  }

  .value-editor-error {
    font-size: 0.72rem;
    color: var(--danger-muted);
    max-width: 14rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
