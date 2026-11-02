<script lang="ts">
  import type { ValuePayload } from "$lib/stage/types";
  import { commitEditedValue, isEditableValue, parseEditedValue } from "$lib/stage/valueEdit";
  import ValueView from "./ValueView.svelte";

  // `oncommit` receives the edited payload and returns the backend error
  // (null on success) so the editor surfaces it next to the field.
  let {
    value,
    oncommit,
  }: { value: ValuePayload; oncommit: (value: ValuePayload) => Promise<string | null> } = $props();

  const editable = $derived(isEditableValue(value));
  let draft = $state("");
  let error = $state<string | null>(null);

  // Sync the draft to the incoming data on mount and on every details
  // refresh (a successful commit refreshes details; a failed one leaves
  // `value.data` unchanged, so the user's draft stays for fixing).
  $effect(() => {
    const data = value.data;
    draft = String(data ?? "");
    error = null;
  });

  async function commit() {
    if (!editable) return;
    const result = commitEditedValue(value, draft);
    if (!result.ok) {
      error = result.error;
      return;
    }
    if (result.value.data === value.data) {
      // Nothing changed: just clear the error state.
      error = null;
      return;
    }
    // On success the details refresh rewrites `value.data`, which resets
    // the draft via the effect; on failure keep the draft for fixing.
    error = await oncommit(result.value);
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
    <input
      class="value-editor"
      class:value-error={error !== null}
      type="text"
      bind:value={draft}
      onkeydown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
      }}
      onblur={commit}
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

  .value-editor {
    width: 100%;
    min-width: 4rem;
    max-width: 14rem;
    padding: 0.1rem 0.3rem;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.05);
    color: inherit;
    font: inherit;
    font-size: 0.85rem;
  }

  .value-editor:focus {
    outline: none;
    border-color: rgba(120, 170, 255, 0.7);
  }

  .value-editor.value-error {
    border-color: rgba(255, 100, 100, 0.8);
  }

  .value-editor-error {
    font-size: 0.72rem;
    color: #ff8080;
    max-width: 14rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
